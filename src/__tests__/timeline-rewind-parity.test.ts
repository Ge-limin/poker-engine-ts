import { describe, expect, test } from 'vitest';

import { SessionManager, selectDecisionContext } from '..';
import type {
  Card,
  PlayerId,
  PlayerOption,
  SeatBootstrapConfig,
  SessionConfig,
  TurnEventEnvelope,
  TurnIntent,
} from '..';
import {
  toSnapshotEnvelope,
  toTurnEventEnvelope,
} from '../core/envelopes/index';

// rewindTo and replaceFrom rebuild snapshots by replaying persisted events.
// They must run each event through the same reduce + post-reduce +
// auto-advance pipeline as applyIntent and resume; a replay that skips
// auto-advance never deals the next street and never settles the hand. These
// tests pin timeline rebuilds to the resume() pipeline, which
// resume-rebuild-parity.test.ts already pins to the live session.

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
        : option.type === 'check'
          ? ({ type: 'check' } as const)
          : ({ type: 'fold' } as const);
  return {
    id: `${actor}-${snapshotVersion}-${option.type}`,
    actor,
    requested,
    origin: 'ui',
    issuedAt: 1_000,
    expectedSnapshotVersion: snapshotVersion,
  };
}

async function driveCheckCall(manager: SessionManager): Promise<void> {
  for (let guard = 0; guard < 100; guard += 1) {
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

interface Persisted {
  readonly payload: Parameters<typeof SessionManager.resume>[0];
  readonly envelopes: readonly TurnEventEnvelope[];
}

async function playAndPersist(): Promise<Persisted> {
  const manager = SessionManager.create(config, seats, {
    deck,
    now: () => 1_000,
  });
  await driveCheckCall(manager);
  const { session } = manager;
  // The hand must have crossed every street so mid-hand rebuilds depend on
  // auto-advance dealing the flop, turn, and river.
  expect(session.activeSnapshot.hand.stage).toBe('showdown');
  expect(session.activeSnapshot.cards.community.river).toBeDefined();
  const envelopes = session.events.map((event) => toTurnEventEnvelope(event));
  return {
    payload: {
      sessionId: session.id,
      config: session.config,
      runtimeContext: session.runtimeContext,
      initialSnapshot: toSnapshotEnvelope(session.initialSnapshot),
      events: envelopes,
      metrics: session.metrics,
      channels: session.channels,
      hooks: {},
    },
    envelopes,
  };
}

describe('timeline rebuilds run the full replay pipeline', () => {
  test('rewindTo lands on the same snapshot as resuming the log prefix', async () => {
    const { payload, envelopes } = await playAndPersist();
    for (let index = 0; index <= envelopes.length; index += 1) {
      const expected = SessionManager.resume(
        { ...payload, events: envelopes.slice(0, index) },
        { now: () => 1_000 },
      ).session.activeSnapshot;

      // A freshly resumed manager only has checkpoints at 0 and N, so any
      // in-between index forces a real replay from the initial snapshot.
      const scrubber = SessionManager.resume(payload, { now: () => 1_000 });
      scrubber.enterReplay();
      const rewound = await scrubber.rewindTo(index);
      expect(rewound.activeSnapshot).toStrictEqual(expected);
    }
  });

  test('replaceFrom with the original tail reproduces the live snapshot exactly', async () => {
    const { payload, envelopes } = await playAndPersist();
    const live = SessionManager.resume(payload, { now: () => 1_000 }).session
      .activeSnapshot;

    const spliceAt = 2;
    const scrubber = SessionManager.resume(payload, { now: () => 1_000 });
    // Enter replay pointed at the splice position: rewindTo truncates the
    // event list, so a timeline index past it would fail the replay guard.
    scrubber.enterReplay(spliceAt);
    await scrubber.rewindTo(spliceAt);
    const spliced = await scrubber.replaceFrom(
      spliceAt,
      envelopes.slice(spliceAt),
    );
    expect(spliced.activeSnapshot).toStrictEqual(live);
  });
});
