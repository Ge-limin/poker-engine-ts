import { describe, expect, test } from 'vitest';

import {
  SessionManager,
  bootstrapSession,
  completeHand,
  fromSnapshotEnvelope,
  replayEvents,
  selectDecisionContext,
  toSnapshotEnvelope,
  transitionSeat,
} from '..';
import { collectFoldedPlayers } from '../core/utils/snapshot';
import type { PlayerOption, TurnEvent, TurnIntent } from '../types/events';
import type { Session } from '../types/session';
import type { SessionConfig } from '../types/session';
import type { TableSnapshot } from '../types/snapshot';

type SeatState = {
  readonly playerId: string;
  readonly stack: number;
  readonly seatIndex: number;
};

describe('batch S1 – long-running consistency', () => {
  test('1,000-hand simulation keeps total chip count constant', async () => {
    const clock = createClock();
    const timestamp = createTimestampGenerator();

    let seatStates = buildSeats(6);
    const totalChips = seatStates.reduce((sum, seat) => sum + seat.stack, 0);

    for (let handIndex = 0; handIndex < 1_000; handIndex += 1) {
      const manager = SessionManager.create(createConfig(), seatStates, {
        now: clock,
      });

      await playHand(manager, {
        handIndex,
        totalChips,
        timestamp,
      });

      expect(calculateTotalChips(manager.session.activeSnapshot)).toBe(
        totalChips,
      );

      seatStates = applyPayouts(manager.session.activeSnapshot, seatStates);
      const stackTotal = seatStates.reduce((sum, seat) => sum + seat.stack, 0);
      expect(stackTotal).toBe(totalChips);
    }
  }, 15_000);

  test('checkpoint parity holds when replaying marathon turn sequences', async () => {
    const manager = SessionManager.create(createConfig(), buildSeats(4), {
      now: createClock(),
    });

    const timestamp = createTimestampGenerator();
    const checkpoints: Array<{
      readonly initial: ReturnType<typeof cloneForTest>;
      readonly events: ReturnType<typeof cloneEventsForTest>;
      readonly active: ReturnType<typeof cloneForTest>;
      readonly envelope: ReturnType<typeof toSnapshotEnvelope>;
    }> = [];

    const recordCheckpoint = (
      session: Session,
      envelope?: ReturnType<typeof toSnapshotEnvelope>,
    ) => {
      checkpoints.push({
        initial: cloneForTest(session.initialSnapshot),
        events: cloneEventsForTest(session.events),
        active: cloneForTest(session.activeSnapshot),
        envelope: envelope ?? toSnapshotEnvelope(session.activeSnapshot),
      });
    };

    recordCheckpoint(manager.session);

    for (let index = 0; index < 96; index += 1) {
      const decision = selectDecisionContext(manager.session);

      if (!decision.actor) {
        if (manager.session.activeSnapshot.hand.stage === 'showdown') {
          recordCheckpoint(manager.session);
          await manager.advanceHand();
          continue;
        }
        break;
      }

      const enabled = decision.availableActions.some(
        (action) => !action.disabled,
      );
      if (!enabled) {
        if (manager.session.activeSnapshot.hand.stage === 'showdown') {
          recordCheckpoint(manager.session);
          await manager.advanceHand();
          continue;
        }
        break;
      }

      const actor = decision.actor ?? `player-${(index % 4) + 1}`;
      const option = chooseOption(decision.availableActions);

      const intent = buildIntentFromOption(actor, option, {
        handIndex: manager.session.activeSnapshot.handNumber,
        turn: index,
        version: manager.session.activeSnapshot.index,
        issuedAt: timestamp(),
      });

      const outcome = await manager.applyIntent(intent);
      expect(outcome.validation.kind).toBe('accepted');
      expect(outcome.hookErrors).toHaveLength(0);

      if (
        outcome.session.events.length % 6 === 0 ||
        outcome.session.activeSnapshot.hand.stage === 'showdown'
      ) {
        recordCheckpoint(outcome.session, outcome.snapshotEnvelope);
      }

      if (outcome.session.activeSnapshot.hand.stage === 'showdown') {
        await manager.advanceHand();
      }
    }

    expect(checkpoints.length).toBeGreaterThan(0);

    for (const checkpoint of checkpoints) {
      const replayed = replayEvents(checkpoint.initial, checkpoint.events);
      expect(replayed).toEqual(checkpoint.active);
      expect(replayed).toEqual(fromSnapshotEnvelope(checkpoint.envelope));
    }
  });

  test('action clocks and hooks remain stable during extended sessions', async () => {
    const hookInvocations: Record<
      'beforeIntent' | 'afterValidation' | 'afterReduction' | 'handCompleted',
      number
    > = {
      beforeIntent: 0,
      afterValidation: 0,
      afterReduction: 0,
      handCompleted: 0,
    };

    const manager = SessionManager.create(createConfig(), buildSeats(3), {
      now: createClock(),
      hooks: {
        beforeIntent: {
          id: 'before-intent',
          priority: 1,
          handler: async () => {
            hookInvocations.beforeIntent += 1;
          },
        },
        afterValidation: {
          id: 'after-validation',
          priority: 1,
          handler: async () => {
            hookInvocations.afterValidation += 1;
          },
        },
        afterReduction: {
          id: 'after-reduction',
          priority: 1,
          handler: async () => {
            hookInvocations.afterReduction += 1;
          },
        },
        handCompleted: {
          id: 'hand-completed',
          priority: 1,
          handler: async () => {
            hookInvocations.handCompleted += 1;
          },
        },
      },
    });

    const timestamp = createTimestampGenerator();
    let accepted = 0;
    let handsCompleted = 0;

    for (let index = 0; index < 64; index += 1) {
      const decision = selectDecisionContext(manager.session);

      if (!decision.actor) {
        if (manager.session.activeSnapshot.hand.stage === 'showdown') {
          handsCompleted += 1;
          await manager.advanceHand();
          continue;
        }
        break;
      }

      const enabled = decision.availableActions.some(
        (action) => !action.disabled,
      );
      if (!enabled) {
        if (manager.session.activeSnapshot.hand.stage === 'showdown') {
          handsCompleted += 1;
          await manager.advanceHand();
          continue;
        }
        break;
      }

      const actor = decision.actor ?? `player-${(index % 3) + 1}`;
      const option = chooseOption(decision.availableActions);
      const intent = buildIntentFromOption(actor, option, {
        handIndex: manager.session.activeSnapshot.handNumber,
        turn: index,
        version: manager.session.activeSnapshot.index,
        issuedAt: timestamp(),
      });

      const outcome = await manager.applyIntent(intent);
      expect(outcome.validation.kind).toBe('accepted');
      accepted += 1;

      const clock = outcome.session.activeSnapshot.clock;
      if (clock.currentActor) {
        expect(clock.deadline).toBeDefined();
        expect(clock.deadline ?? 0).toBeGreaterThanOrEqual(0);
      } else {
        expect(clock.deadline).toBeUndefined();
      }
      expect(Object.values(clock.bankMs).every((value) => value >= 0)).toBe(
        true,
      );

      if (outcome.session.activeSnapshot.hand.stage === 'showdown') {
        handsCompleted += 1;
        await manager.advanceHand();
      }
    }

    expect(hookInvocations.beforeIntent).toBe(accepted);
    expect(hookInvocations.afterValidation).toBe(accepted);
    expect(hookInvocations.afterReduction).toBe(accepted);
    expect(hookInvocations.handCompleted).toBe(handsCompleted);
  });

  test('seat lifecycle survives repeated elimination and rebuy cycles', () => {
    const config = createConfig();
    const seats = buildSeats(6);
    let session = bootstrapSession(config, seats);

    const rebuyStacks = [140, 160, 200, 180, 220, 190];
    const rebuyTokens = [1, 2, 3, 2, 1, 4];

    for (let cycle = 0; cycle < 12; cycle += 1) {
      const seatIndex = cycle % seats.length;
      const seat = session.activeSnapshot.seating.seats[seatIndex]!;
      const playerId = seat.occupant?.playerId ?? `player-${seatIndex + 1}`;

      session = transitionSeat(session, seatIndex, 'leaving', {
        stack: 0,
        rebuyTokens: rebuyTokens[seatIndex % rebuyTokens.length],
      });

      session = {
        ...session,
        activeSnapshot: {
          ...session.activeSnapshot,
          flags: {
            ...session.activeSnapshot.flags,
            pendingEliminations: Array.from(
              new Set(
                session.activeSnapshot.flags.pendingEliminations.concat(
                  playerId,
                ),
              ),
            ),
          },
        },
      };

      session = completeHand(session);

      const reopened = session.activeSnapshot.seating.seats[seatIndex]!;
      expect(reopened.status).toBe('open');
      expect(reopened.occupant).toBeUndefined();
      expect(reopened.rebuyTokens).toBe(
        rebuyTokens[seatIndex % rebuyTokens.length],
      );
      expect(session.activeSnapshot.flags.pendingEliminations).not.toContain(
        playerId,
      );

      session = transitionSeat(session, seatIndex, 'occupied', {
        occupant: { playerId, displayName: `Player ${seatIndex + 1}` },
        stack: rebuyStacks[seatIndex % rebuyStacks.length],
        rebuyTokens: rebuyTokens[(seatIndex + 1) % rebuyTokens.length],
      });

      const reseated = session.activeSnapshot.seating.seats[seatIndex]!;
      expect(reseated.status).toBe('occupied');
      expect(reseated.occupant?.playerId).toBe(playerId);
      expect(reseated.stack).toBe(rebuyStacks[seatIndex % rebuyStacks.length]);
      expect(reseated.rebuyTokens).toBe(
        rebuyTokens[(seatIndex + 1) % rebuyTokens.length],
      );
    }
  });
});

async function playHand(
  manager: SessionManager,
  context: {
    readonly handIndex: number;
    readonly totalChips: number;
    readonly timestamp: () => number;
  },
): Promise<void> {
  for (let turn = 0; turn < 256; turn += 1) {
    const decision = selectDecisionContext(manager.session);
    const snapshot = manager.session.activeSnapshot;

    expect(calculateTotalChips(snapshot)).toBe(context.totalChips);

    if (!decision.actor) {
      expect(decision.availableActions).toHaveLength(0);
      return;
    }

    const option = chooseOption(decision.availableActions);
    const intent = buildIntentFromOption(decision.actor, option, {
      handIndex: context.handIndex,
      turn,
      version: snapshot.index,
      issuedAt: context.timestamp(),
    });

    const outcome = await manager.applyIntent(intent);
    expect(outcome.validation.kind).toBe('accepted');
    expect(calculateTotalChips(outcome.session.activeSnapshot)).toBe(
      context.totalChips,
    );
  }

  throw new Error('hand did not complete within the expected turn limit');
}

function createConfig(): SessionConfig {
  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats: 6,
    startingStack: 100,
    blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
    antePolicy: undefined,
    personaPolicy: { defaultStyle: 'balanced' },
    ruleSet: {
      streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
      postingOrder: ['small-blind', 'big-blind'],
      minRaisePolicy: 'double-last-bet',
      cardDistribution: {
        holeCardsPerPlayer: 2,
        burnPerStreet: [0, 1, 1],
        communityReveal: [0, 3, 1, 1],
      },
      showdownOrdering: 'high-card',
    },
    evaluationPolicy: {
      engine: 'lookup-table',
      evaluatorId: 'default',
      supportsHiLo: false,
      cacheSize: 1_024,
    },
    autoAdvance: true,
  } satisfies SessionConfig;
}

function buildSeats(count: number): SeatState[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    stack: 100,
    seatIndex: index,
  }));
}

function applyPayouts(
  snapshot: TableSnapshot,
  previousSeats: readonly SeatState[],
): SeatState[] {
  const folded = collectFoldedPlayers(snapshot.hand);
  const activeSeats = snapshot.seating.seats.filter((seat) => {
    const playerId = seat.occupant?.playerId;
    if (!playerId) {
      return false;
    }
    if (seat.status !== 'occupied') {
      return false;
    }
    if (snapshot.flags.pendingEliminations.includes(playerId)) {
      return false;
    }
    return !folded.has(playerId);
  });

  const contenders =
    activeSeats.length > 0
      ? activeSeats.map((seat) => seat.occupant!.playerId)
      : snapshot.seating.seats
          .filter((seat) => Boolean(seat.occupant))
          .map((seat) => seat.occupant!.playerId);

  const baseStacks = new Map<string, number>();
  for (const seat of snapshot.seating.seats) {
    const playerId = seat.occupant?.playerId;
    if (playerId) {
      baseStacks.set(playerId, seat.stack);
    }
  }

  const potTotal = calculateTotalChips(snapshot) - sumSeatStacks(snapshot);
  if (potTotal > 0 && contenders.length > 0) {
    const share = Math.trunc(potTotal / contenders.length);
    const remainder = potTotal - share * contenders.length;

    for (const playerId of contenders) {
      const current = baseStacks.get(playerId) ?? 0;
      baseStacks.set(playerId, current + share);
    }

    for (let index = 0; index < remainder; index += 1) {
      const playerId = contenders[index % contenders.length]!;
      const current = baseStacks.get(playerId) ?? 0;
      baseStacks.set(playerId, current + 1);
    }
  }

  return previousSeats.map((seat) => ({
    ...seat,
    stack: baseStacks.get(seat.playerId) ?? seat.stack,
  }));
}

function sumSeatStacks(snapshot: TableSnapshot): number {
  return snapshot.seating.seats.reduce((sum, seat) => sum + seat.stack, 0);
}

function calculateTotalChips(snapshot: TableSnapshot): number {
  const seatTotal = sumSeatStacks(snapshot);
  const sidePotTotal = snapshot.pots.sides.reduce(
    (sum, side) => sum + side.amount,
    0,
  );
  return (
    seatTotal + snapshot.pots.main.amount + snapshot.pots.rake + sidePotTotal
  );
}

function chooseOption(options: readonly PlayerOption[]): PlayerOption {
  const enabled = options.filter((option) => !option.disabled);
  if (enabled.length === 0) {
    throw new Error('no enabled options available');
  }

  const priority: PlayerOption['type'][] = [
    'fold',
    'check',
    'call',
    'all-in',
    'bet',
    'raise',
  ];

  for (const type of priority) {
    const candidate = enabled.find((entry) => entry.type === type);
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return enabled[0]!;
}

function buildIntentFromOption(
  actor: string,
  option: PlayerOption,
  context: {
    readonly handIndex: number;
    readonly turn: number;
    readonly version: number;
    readonly issuedAt: number;
  },
): TurnIntent {
  const base = {
    actor,
    issuedAt: context.issuedAt,
    origin: 'automation' as const,
    expectedSnapshotVersion: context.version,
  } satisfies Pick<
    TurnIntent,
    'actor' | 'issuedAt' | 'origin' | 'expectedSnapshotVersion'
  >;

  const id = `${actor}-${context.handIndex}-${context.turn}-${option.type}`;

  switch (option.type) {
    case 'fold':
      return {
        id,
        ...base,
        requested: { type: 'fold' },
      } satisfies TurnIntent;
    case 'check':
      return {
        id,
        ...base,
        requested: { type: 'check' },
      } satisfies TurnIntent;
    case 'call':
      return {
        id,
        ...base,
        requested: { type: 'call', amount: option.amount },
      } satisfies TurnIntent;
    case 'bet':
      return {
        id,
        ...base,
        requested: { type: 'bet', amount: option.min },
      } satisfies TurnIntent;
    case 'raise': {
      const raiseTo = Math.max(option.min, option.max);
      return {
        id,
        ...base,
        requested: { type: 'raise', amount: option.min, to: raiseTo },
      } satisfies TurnIntent;
    }
    case 'all-in':
      return {
        id,
        ...base,
        requested: { type: 'all-in', amount: option.amount, from: 'bet' },
      } satisfies TurnIntent;
    default:
      return {
        id,
        ...base,
        requested: { type: 'fold' },
      } satisfies TurnIntent;
  }
}

function createTimestampGenerator(): () => number {
  let current = 0;
  return () => {
    current += 1;
    return current;
  };
}

function createClock(): () => number {
  let current = 10_000;
  return () => {
    current += 5;
    return current;
  };
}

function cloneForTest(snapshot: TableSnapshot): TableSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TableSnapshot;
}

function cloneEventsForTest(events: readonly TurnEvent[]): TurnEvent[] {
  return events.map((event) => ({ ...event }));
}
