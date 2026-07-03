import { describe, expect, test } from 'vitest';

import { SessionManager, selectDecisionContext, selectTableView } from '..';
import { RuntimeModeViolationError } from '../core/errors';
import type { PlayerOption, TurnIntent } from '../types/events';
import type { SessionConfig, SimulationRequest } from '../types/session';

function createConfig(
  maxSeats: SessionConfig['maxSeats'] = 6,
  blindSchedule: SessionConfig['blindSchedule'] = [
    { level: 1, smallBlind: 1, bigBlind: 2 },
  ],
): SessionConfig {
  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats,
    startingStack: 100,
    blindSchedule,
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
      cacheSize: 1024,
    },
    autoAdvance: true,
  };
}

function buildSeats(
  count: number,
): { playerId: string; stack: number; seatIndex: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    stack: 100,
    seatIndex: index,
  }));
}

function buildIntentFromOption(
  actor: string,
  option: PlayerOption,
  version: number,
  issuedAt: number,
): TurnIntent {
  switch (option.type) {
    case 'fold':
      return {
        id: `${actor}-fold`,
        actor,
        requested: { type: 'fold' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    case 'check':
      return {
        id: `${actor}-check`,
        actor,
        requested: { type: 'check' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    case 'call':
      return {
        id: `${actor}-call`,
        actor,
        requested: { type: 'call', amount: option.amount },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    case 'bet':
      return {
        id: `${actor}-bet`,
        actor,
        requested: { type: 'bet', amount: option.min },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    case 'raise':
      return {
        id: `${actor}-raise`,
        actor,
        requested: { type: 'raise', amount: option.min, to: option.min },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    case 'all-in':
      return {
        id: `${actor}-all-in`,
        actor,
        requested: { type: 'all-in', amount: option.amount, from: 'bet' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    default:
      return {
        id: `${actor}-fallback-fold`,
        actor,
        requested: { type: 'fold' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
  }
}

describe('@batch(I2) state management & concurrency', () => {
  test('state rollback restores snapshot and increments recovery metric', async () => {
    const manager = SessionManager.create(createConfig(), buildSeats(2));
    const actor =
      manager.session.activeSnapshot.clock.currentActor ?? 'player-1';
    const context = selectDecisionContext(manager.session);
    const option =
      context.availableActions.find((action) => action.type === 'fold') ??
      context.availableActions[0]!;
    const foldIntent = buildIntentFromOption(
      actor,
      option,
      manager.session.activeSnapshot.index,
      1_000,
    );

    const outcome = await manager.applyIntent(foldIntent);
    expect(outcome.validation.kind).toBe('accepted');
    expect(outcome.channels.telemetry?.metadata.mode).toBe('live');
    expect(manager.session.events).toHaveLength(1);

    manager.enterReplay();
    const rewound = await manager.rewindTo(0);
    expect(rewound.events).toHaveLength(0);
    expect(rewound.metrics.recoveries).toBe(1);
    expect(rewound.activeSnapshot.index).toBe(0);
    expect(rewound.runtimeContext.mode).toBe('replay');
    manager.exitReplay();
    expect(manager.eventLog).toHaveLength(0);
  });

  test('stale intent rejection surfaces version mismatch reason', async () => {
    const manager = SessionManager.create(createConfig(), buildSeats(2));
    const staleIntent: TurnIntent = {
      id: 'stale',
      actor: 'player-1',
      requested: { type: 'check' },
      issuedAt: 2_000,
      origin: 'ui',
      expectedSnapshotVersion: -1,
    };

    const result = await manager.applyIntent(staleIntent);
    expect(result.validation.kind).toBe('rejected');
    if (result.validation.kind === 'rejected') {
      expect(result.validation.reason).toBe('version-mismatch');
    }
  });

  test('replay mode rejects live intents to protect event log', async () => {
    const manager = SessionManager.create(createConfig(), buildSeats(2));
    manager.enterReplay();

    expect(manager.session.runtimeContext).toMatchObject({
      mode: 'replay',
      timelineIndex: 0,
      isPlaying: false,
    });

    const actor =
      manager.session.activeSnapshot.clock.currentActor ?? 'player-1';
    const context = selectDecisionContext(manager.session);
    const option =
      context.availableActions.find((action) => action.type === 'fold') ??
      context.availableActions[0]!;
    const intent = buildIntentFromOption(
      actor,
      option,
      manager.session.activeSnapshot.index,
      3_000,
    );

    await expect(manager.applyIntent(intent)).rejects.toThrow(
      RuntimeModeViolationError,
    );
  });

  test('session creation supports diverse table sizes and blind schedules', () => {
    const headsUpSchedule = [
      { level: 1, smallBlind: 25, bigBlind: 50 },
      { level: 2, smallBlind: 40, bigBlind: 80 },
    ] as const;
    const fullRingSchedule = [
      { level: 5, smallBlind: 200, bigBlind: 400 },
    ] as const;

    const headsUpConfig = createConfig(2, headsUpSchedule);
    const fullRingConfig = createConfig(9, fullRingSchedule);

    const headsUpManager = SessionManager.create(
      headsUpConfig,
      buildSeats(headsUpConfig.maxSeats),
      { sessionId: 'session-headsup' },
    );
    const fullRingManager = SessionManager.create(
      fullRingConfig,
      buildSeats(fullRingConfig.maxSeats),
      { sessionId: 'session-fullring' },
    );

    const headsUpTable = selectTableView(headsUpManager.session);
    const fullRingTable = selectTableView(fullRingManager.session);

    expect(headsUpTable.seats).toHaveLength(headsUpConfig.maxSeats);
    expect(fullRingTable.seats).toHaveLength(fullRingConfig.maxSeats);
    expect(headsUpManager.session.activeSnapshot.seating.seats).toHaveLength(
      headsUpConfig.maxSeats,
    );
    expect(fullRingManager.session.activeSnapshot.seating.seats).toHaveLength(
      fullRingConfig.maxSeats,
    );

    const headsUpBlinds = headsUpManager.session.activeSnapshot.hand.blinds;
    const fullRingBlinds = fullRingManager.session.activeSnapshot.hand.blinds;

    expect(headsUpBlinds.smallBlind.amount).toBe(
      headsUpSchedule[0]!.smallBlind,
    );
    expect(headsUpBlinds.bigBlind.amount).toBe(headsUpSchedule[0]!.bigBlind);
    expect(fullRingBlinds.smallBlind.amount).toBe(
      fullRingSchedule[0]!.smallBlind,
    );
    expect(fullRingBlinds.bigBlind.amount).toBe(fullRingSchedule[0]!.bigBlind);

    expect(headsUpManager.session.config.blindSchedule).toHaveLength(2);
    expect(headsUpManager.session.config.blindSchedule[1]?.level).toBe(
      headsUpSchedule[1]!.level,
    );
  });

  test('accepted intents produce deterministic ULID identifiers', async () => {
    const seats = buildSeats(2);
    const config = createConfig();
    const firstManager = SessionManager.create(config, seats);
    const secondManager = SessionManager.create(config, seats);

    const actor =
      firstManager.session.activeSnapshot.clock.currentActor ?? 'player-1';
    const context = selectDecisionContext(firstManager.session);
    const option = context.availableActions[0]!;
    const issuedAt = 1_000;

    const intent = buildIntentFromOption(
      actor,
      option,
      firstManager.session.activeSnapshot.index,
      issuedAt,
    );

    const firstOutcome = await firstManager.applyIntent(intent);
    const secondOutcome = await secondManager.applyIntent({ ...intent });

    expect(firstOutcome.validation.kind).toBe('accepted');
    expect(secondOutcome.validation.kind).toBe('accepted');

    const firstId = firstOutcome.eventEnvelope?.event.id;
    const secondId = secondOutcome.eventEnvelope?.event.id;

    expect(firstId).toBeDefined();
    expect(firstId).toHaveLength(26);
    expect(secondId).toBe(firstId);
  });

  test('channel dispatch prepares telemetry, replay, and advisory payloads', async () => {
    const simulationPolicy = {
      maxIterations: 250,
      convergenceEpsilon: 0.01,
      supportsPartialInformation: true,
    } as const;
    const config: SessionConfig = {
      ...createConfig(),
      simulationPolicy,
    };
    const requests: SimulationRequest[] = [];
    const manager = SessionManager.create(config, buildSeats(2), {
      hooks: {
        simulationRequested: {
          id: 'sim-hook',
          priority: 1,
          handler: async (request) => {
            requests.push(request);
          },
        },
      },
    });

    const actor =
      manager.session.activeSnapshot.clock.currentActor ?? 'player-1';
    const decision = selectDecisionContext(manager.session);
    const option =
      decision.availableActions.find((action) => action.type === 'check') ??
      decision.availableActions.find((action) => action.type === 'call') ??
      decision.availableActions.find((action) => action.type === 'bet') ??
      decision.availableActions.find((action) => action.type === 'raise') ??
      decision.availableActions[0]!;

    expect(option.type).not.toBe('fold');

    const intent = buildIntentFromOption(
      actor,
      option,
      manager.session.activeSnapshot.index,
      5_000,
    );

    const outcome = await manager.applyIntent(intent);

    expect(outcome.validation.kind).toBe('accepted');
    expect(outcome.channels.telemetry?.event.sessionId).toBe(
      manager.session.id,
    );
    expect(outcome.channels.replay?.event.event.id).toBe(
      outcome.eventEnvelope?.event.id,
    );
    expect(outcome.channels.advisory?.simulation?.policy).toEqual(
      simulationPolicy,
    );
    expect(outcome.session.metrics.advisoryEquityRequests).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.iterations).toBe(simulationPolicy.maxIterations);
  });
});
