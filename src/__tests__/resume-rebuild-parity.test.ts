import { describe, expect, test } from 'vitest';

import { SessionManager, selectDecisionContext } from '..';
import type {
  Card,
  PlayerId,
  PlayerOption,
  SeatBootstrapConfig,
  SessionConfig,
  TurnIntent,
} from '..';
import {
  toSnapshotEnvelope,
  toTurnEventEnvelope,
} from '../core/envelopes/index';

// SessionManager.resume replays the persisted event log through the same
// reduce + post-reduce + auto-advance pipeline as the live session. These
// tests pin the strongest guarantee that pipeline can give: the rebuilt
// activeSnapshot is deeply identical to the live one, including the card
// bookkeeping (burn pile, reveal schedule) and every turn record.

const config: SessionConfig = {
  tableVariant: 'texas-holdem',
  bettingStructure: 'no-limit',
  maxSeats: 2,
  startingStack: 100,
  blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
  personaPolicy: { defaultStyle: 'balanced' },
  ruleSet: {
    streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
    postingOrder: ['small-blind', 'big-blind'],
    minRaisePolicy: 'double-last-bet',
    showdownOrdering: 'high-card',
    cardDistribution: {
      holeCardsPerPlayer: 2,
      burnPerStreet: [0, 1, 1],
      communityReveal: [0, 3, 1, 1],
    },
  },
  evaluationPolicy: {
    engine: 'lookup-table',
    evaluatorId: 'default',
    supportsHiLo: false,
    cacheSize: 1024,
  },
  autoAdvance: true,
};

const seats: readonly SeatBootstrapConfig[] = [
  { playerId: 'hero', seatIndex: 0, stack: 100 },
  { playerId: 'villain', seatIndex: 1, stack: 100 },
];

const deck: readonly Card[] = [
  'As', 'Ks', 'Qs', 'Js', 'Ts', '9s', '8s', '7s', '6s', '5s',
];

function toIntent(
  actor: PlayerId,
  option: PlayerOption,
  snapshotVersion: number,
): TurnIntent {
  const requested =
    option.type === 'call'
      ? ({ type: 'call', amount: option.amount } as const)
      : option.type === 'bet'
        ? ({ type: 'bet', amount: option.min } as const)
        : option.type === 'raise'
          ? ({ type: 'raise', amount: option.min, to: option.min } as const)
          : option.type === 'all-in'
            ? ({ type: 'all-in', amount: option.amount, from: 'bet' } as const)
            : ({ type: option.type } as const);
  return {
    id: `${actor}-${snapshotVersion}-${option.type}`,
    actor,
    requested,
    origin: 'ui',
    issuedAt: 1_000,
    expectedSnapshotVersion: snapshotVersion,
  };
}

async function driveCheckCall(
  manager: SessionManager,
  stopWhen: (stage: string) => boolean,
): Promise<void> {
  for (let guard = 0; guard < 100; guard += 1) {
    if (stopWhen(manager.session.activeSnapshot.hand.stage)) {
      return;
    }
    const decision = selectDecisionContext(manager.session);
    if (!decision.actor) {
      return;
    }
    const legal = decision.availableActions.filter(
      (option) => !option.disabled,
    );
    const choice =
      legal.find((option) => option.type === 'check') ??
      legal.find((option) => option.type === 'call') ??
      legal[0];
    if (!choice) {
      return;
    }
    const result = await manager.applyIntent(
      toIntent(decision.actor, choice, manager.session.activeSnapshot.index),
    );
    if (result.validation.kind !== 'accepted') {
      throw new Error(`intent rejected: ${result.validation.reason}`);
    }
  }
  throw new Error('hand did not terminate within the step guard');
}

function resumeFrom(manager: SessionManager): SessionManager {
  const { session } = manager;
  return SessionManager.resume(
    {
      sessionId: session.id,
      config: session.config,
      runtimeContext: session.runtimeContext,
      initialSnapshot: toSnapshotEnvelope(session.initialSnapshot),
      events: session.events.map((event) => toTurnEventEnvelope(event)),
      metrics: session.metrics,
      channels: session.channels,
      hooks: {},
    },
    { now: () => 1_000 },
  );
}

describe('resume rebuilds the live snapshot exactly', () => {
  test('after a full board run-out, including burn pile and turn records', async () => {
    const manager = SessionManager.create(config, seats, {
      deck,
      now: () => 1_000,
    });
    await driveCheckCall(manager, () => false);

    const live = manager.session.activeSnapshot;
    // The board must have actually run out for the comparison to mean
    // anything: every street was dealt, with its burns.
    expect(live.hand.stage).toBe('showdown');
    expect(live.cards.community.river).toBeDefined();
    expect(live.cards.burnPile).toHaveLength(2);

    const resumed = resumeFrom(manager);
    expect(resumed.session.activeSnapshot).toStrictEqual(live);
  });

  test('mid-hand, with streets still to come', async () => {
    const manager = SessionManager.create(config, seats, {
      deck,
      now: () => 1_000,
    });
    await driveCheckCall(manager, (stage) => stage === 'turn');

    const live = manager.session.activeSnapshot;
    expect(live.hand.stage).toBe('turn');
    expect(live.cards.burnPile).toHaveLength(1);

    const resumed = resumeFrom(manager);
    expect(resumed.session.activeSnapshot).toStrictEqual(live);
  });
});
