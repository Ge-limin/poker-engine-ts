import { describe, expect, test } from 'vitest';

import {
  SessionManager,
  bootstrapSession,
  completeHand,
  selectDecisionContext,
  selectTableView,
  transitionSeat,
} from '..';
import type {
  ApplyIntentResult,
  BlindLevel,
  SeatBootstrapConfig,
  SimulationPolicy,
} from '..';
import type { PlayerOption, TurnIntent } from '../types/events';
import type { SessionConfig, SimulationRequest } from '../types/session';

describe('batch S2 – extended heads-up reliability', () => {
  test('bust-outs and reentries preserve rotation, metrics, and personas', () => {
    const config = createHeadsUpConfig();
    const seats = createHeadsUpSeats();

    let session = bootstrapSession(config, seats);

    const personas = session.activeSnapshot.personas;
    const heroProfile = personas.entries['player-a'];
    const villainProfile = personas.entries['player-b'];

    expect(heroProfile).toBeDefined();
    expect(villainProfile).toBeDefined();
    if (!heroProfile || !villainProfile) return;

    const heroPersona = {
      ...heroProfile,
      adaptation: {
        ...heroProfile.adaptation,
        trackedMetrics: {
          ...heroProfile.adaptation.trackedMetrics,
          vpip: 52,
          pfr: 31,
          aggressionFactor: 22,
          showdownRate: 44,
        },
        lastUpdated: 1_000,
        featureVector: [1, 0],
      },
    } satisfies typeof heroProfile;

    const villainPersona = {
      ...villainProfile,
      adaptation: {
        ...villainProfile.adaptation,
        trackedMetrics: {
          ...villainProfile.adaptation.trackedMetrics,
          vpip: 48,
          pfr: 27,
          aggressionFactor: 17,
          showdownRate: 33,
        },
        lastUpdated: 2_000,
        featureVector: [0, 1],
      },
    } satisfies typeof villainProfile;

    const personaMatrix = {
      entries: {
        ...personas.entries,
        'player-a': heroPersona,
        'player-b': villainPersona,
      },
    } satisfies typeof personas;

    session = {
      ...session,
      activeSnapshot: {
        ...session.activeSnapshot,
        personas: personaMatrix,
      },
      initialSnapshot: {
        ...session.initialSnapshot,
        personas: personaMatrix,
      },
    };

    const heroBaseline = {
      lastUpdated: heroPersona.adaptation.lastUpdated,
      featureVector: [...heroPersona.adaptation.featureVector],
      trackedMetrics: { ...heroPersona.adaptation.trackedMetrics },
    } as const;

    const villainBaseline = {
      lastUpdated: villainPersona.adaptation.lastUpdated,
      featureVector: [...villainPersona.adaptation.featureVector],
      trackedMetrics: { ...villainPersona.adaptation.trackedMetrics },
    } as const;

    let expectedHands = 0;

    const assertPersonaPersistence = () => {
      const hero = session.activeSnapshot.personas.entries['player-a'];
      const villain = session.activeSnapshot.personas.entries['player-b'];
      expect(hero?.adaptation.lastUpdated).toBe(heroBaseline.lastUpdated);
      expect(hero?.adaptation.featureVector).toEqual(
        heroBaseline.featureVector,
      );
      expect(hero?.adaptation.trackedMetrics).toEqual(
        heroBaseline.trackedMetrics,
      );
      expect(villain?.adaptation.lastUpdated).toBe(villainBaseline.lastUpdated);
      expect(villain?.adaptation.featureVector).toEqual(
        villainBaseline.featureVector,
      );
      expect(villain?.adaptation.trackedMetrics).toEqual(
        villainBaseline.trackedMetrics,
      );
    };

    // Cycle 1 – player A busts then re-enters
    session = transitionSeat(session, 0, 'leaving', { stack: 0 });
    session = completeHand(session);
    expectedHands += 1;
    expect(session.metrics.handsDealt).toBe(expectedHands);
    expect(session.activeSnapshot.seating.dealerButton).toBe(1);
    assertPersonaPersistence();

    session = transitionSeat(session, 0, 'occupied', {
      occupant: { playerId: 'player-a', displayName: 'Hero' },
      stack: 120,
    });
    session = completeHand(session);
    expectedHands += 1;
    expect(session.metrics.handsDealt).toBe(expectedHands);
    expect(session.activeSnapshot.seating.dealerButton).toBe(0);
    assertPersonaPersistence();

    // Cycle 2 – player B busts then re-enters
    session = transitionSeat(session, 1, 'leaving', { stack: 0 });
    session = completeHand(session);
    expectedHands += 1;
    expect(session.metrics.handsDealt).toBe(expectedHands);
    expect(session.activeSnapshot.seating.dealerButton).toBe(0);
    assertPersonaPersistence();

    session = transitionSeat(session, 1, 'occupied', {
      occupant: { playerId: 'player-b', displayName: 'Villain' },
      stack: 140,
    });
    session = completeHand(session);
    expectedHands += 1;
    expect(session.metrics.handsDealt).toBe(expectedHands);
    expect(session.activeSnapshot.seating.dealerButton).toBe(1);
    assertPersonaPersistence();
  });

  test('blind schedule escalation updates auto-posting and betting minimums', () => {
    const blindLevels: BlindLevel[] = [
      { level: 1, smallBlind: 1, bigBlind: 2 },
      { level: 2, smallBlind: 2, bigBlind: 4 },
      { level: 3, smallBlind: 4, bigBlind: 8 },
    ];

    let lastMinBet = 0;

    for (const level of blindLevels) {
      const config = createHeadsUpConfig({ blindSchedule: [level] });
      let session = bootstrapSession(config, createHeadsUpSeats());

      const snapshot = session.activeSnapshot;
      expect(snapshot.hand.blinds.smallBlind.amount).toBe(level.smallBlind);
      expect(snapshot.hand.blinds.bigBlind.amount).toBe(level.bigBlind);

      const contributions = snapshot.pots.main.contributions;
      const smallBlindContribution = contributions['player-a'] ?? 0;
      const bigBlindContribution = contributions['player-b'] ?? 0;
      expect(smallBlindContribution).toBeGreaterThan(0);
      expect(bigBlindContribution).toBeGreaterThan(0);
      expect(snapshot.pots.main.amount).toBe(
        smallBlindContribution + bigBlindContribution,
      );

      const firstDecision = selectDecisionContext(session);
      const firstOption = chooseOption(firstDecision.availableActions, [
        'raise',
        'bet',
        'call',
        'check',
      ]);

      if (firstOption.type === 'bet' || firstOption.type === 'raise') {
        expect(firstOption.min).toBeGreaterThanOrEqual(lastMinBet);
        lastMinBet = firstOption.min;
      }

      session = completeHand(session);
      expect(session.metrics.handsDealt).toBe(1);
      expect(session.activeSnapshot.hand.blinds.smallBlind.amount).toBe(
        level.smallBlind,
      );
      expect(session.activeSnapshot.hand.blinds.bigBlind.amount).toBe(
        level.bigBlind,
      );
      const completedContributions =
        session.activeSnapshot.pots.main.contributions;
      expect(completedContributions['player-a'] ?? 0).toBeGreaterThan(0);
      expect(completedContributions['player-b'] ?? 0).toBeGreaterThan(0);
    }
  });

  test('button seat posts the small blind and acts first preflop', () => {
    const session = bootstrapSession(
      createHeadsUpConfig(),
      createHeadsUpSeats(),
    );
    const snapshot = session.activeSnapshot;

    expect(snapshot.seating.dealerButton).toBe(0);
    expect(snapshot.hand.blinds.smallBlind.playerId).toBe('player-a');
    expect(snapshot.hand.blinds.bigBlind.playerId).toBe('player-b');

    const contributions = snapshot.pots.main.contributions;
    expect(contributions['player-a']).toBeGreaterThan(0);
    expect(contributions['player-b']).toBeGreaterThan(0);

    const decision = selectDecisionContext(session);
    expect(decision.actor).toBe('player-a');
  });

  test('consecutive mutual all-ins auto-run the board without leaking visibility', async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const manager = SessionManager.create(
        createHeadsUpConfig(),
        createHeadsUpSeats(),
        { now: createDeterministicClock() },
      );

      const issuedAt = createTimestampGenerator();
      const opening = selectDecisionContext(manager.session);
      expect(opening.actor).toBeDefined();
      const shoveOption = chooseOption(opening.availableActions, ['all-in']);
      const shoveIntent = buildIntentFromOption(
        requireActor(opening.actor),
        shoveOption,
        manager.session.activeSnapshot.index,
        issuedAt(),
      );

      const shoveOutcome = await manager.applyIntent(shoveIntent);
      expect(shoveOutcome.validation.kind).toBe('accepted');

      const response = selectDecisionContext(shoveOutcome.session);
      expect(response.actor).toBeDefined();
      const responseOption = chooseOption(response.availableActions, [
        'all-in',
        'call',
      ]);
      const responseIntent = buildIntentFromOption(
        requireActor(response.actor),
        responseOption,
        shoveOutcome.session.activeSnapshot.index,
        issuedAt(),
      );

      const showdown = await manager.applyIntent(responseIntent);
      expect(showdown.validation.kind).toBe('accepted');

      const decision = selectDecisionContext(showdown.session);
      expect(decision.actor).toBeUndefined();
      expect(decision.availableActions).toHaveLength(0);
      expect(decision.playersLeftToAct).toHaveLength(0);

      const table = selectTableView(showdown.session);
      expect(table.currentActor).toBeUndefined();
      expect(table.seats.every((seat) => seat.isAllIn)).toBe(true);

      const revealedStages = table.board.revealSchedule.map(
        (entry) => entry.stage,
      );
      const allowedStages: ReadonlyArray<(typeof revealedStages)[number]> = [
        'flop',
        'turn',
        'river',
      ];
      expect(
        revealedStages.every((stage, index, array) => {
          const stageIndex = allowedStages.indexOf(stage);
          const previous =
            index === 0 ? stageIndex : allowedStages.indexOf(array[index - 1]!);
          return stageIndex !== -1 && stageIndex >= previous;
        }),
      ).toBe(true);
    }
  });

  test('advisor cooldown halts simulation dispatch while scenario review is active', async () => {
    const simulationPolicy: SimulationPolicy = {
      maxIterations: 64,
      convergenceEpsilon: 0.01,
      supportsPartialInformation: true,
    };

    const requests: SimulationRequest[] = [];
    const manager = SessionManager.create(
      createHeadsUpConfig({ simulationPolicy }),
      createHeadsUpSeats(),
      {
        now: createDeterministicClock(),
        sessionId: 's2-advisor-cooldown',
        hooks: {
          simulationRequested: {
            id: 'record-request',
            priority: 1,
            handler: async (request) => {
              requests.push(request);
            },
          },
        },
      },
    );

    const issuedAt = createTimestampGenerator();

    const firstOutcome = await applyDeterministicAction(manager, issuedAt, [
      'call',
      'check',
    ]);
    expect(requests).toHaveLength(1);
    expect(firstOutcome.channels.advisory).toBeDefined();

    manager.updateRuntimeContext({
      mode: 'scenario',
      scenarioId: 'heads-up-review',
      isCompleted: false,
      viewingIndex: null,
    });
    await manager.advanceHand();

    const cooledOutcome = await applyDeterministicAction(manager, issuedAt, [
      'check',
      'call',
    ]);
    expect(requests).toHaveLength(1);
    expect(cooledOutcome.channels.advisory).toBeUndefined();

    manager.updateRuntimeContext({ mode: 'live' });
    await manager.advanceHand();

    const resumedOutcome = await applyDeterministicAction(manager, issuedAt, [
      'bet',
      'raise',
      'check',
    ]);
    expect(requests).toHaveLength(2);
    expect(resumedOutcome.channels.advisory).toBeDefined();
    expect(
      manager.session.metrics.advisoryEquityRequests,
    ).toBeGreaterThanOrEqual(2);
  });
});

interface HeadsUpConfigOverrides {
  readonly blindSchedule?: readonly BlindLevel[];
  readonly simulationPolicy?: SimulationPolicy;
}

function createHeadsUpConfig(
  overrides: HeadsUpConfigOverrides = {},
): SessionConfig {
  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats: 2,
    startingStack: 100,
    blindSchedule: overrides.blindSchedule ?? [
      { level: 1, smallBlind: 1, bigBlind: 2 },
    ],
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
    simulationPolicy: overrides.simulationPolicy,
    autoAdvance: true,
  } satisfies SessionConfig;
}

function createHeadsUpSeats(): SeatBootstrapConfig[] {
  return [
    { playerId: 'player-a', stack: 100, displayName: 'Hero', seatIndex: 0 },
    { playerId: 'player-b', stack: 100, displayName: 'Villain', seatIndex: 1 },
  ];
}

async function applyDeterministicAction(
  manager: SessionManager,
  issuedAt: () => number,
  priority: PlayerOption['type'][] = [],
): Promise<ApplyIntentResult> {
  const decision = selectDecisionContext(manager.session);
  const option = chooseOption(decision.availableActions, priority);
  const intent = buildIntentFromOption(
    requireActor(decision.actor),
    option,
    manager.session.activeSnapshot.index,
    issuedAt(),
  );

  const outcome = await manager.applyIntent(intent);
  expect(outcome.validation.kind).toBe('accepted');
  return outcome;
}

function chooseOption(
  options: readonly PlayerOption[],
  priority: PlayerOption['type'][] = [
    'check',
    'call',
    'bet',
    'raise',
    'all-in',
    'fold',
  ],
): PlayerOption {
  const enabled = options.filter((option) => !option.disabled);
  expect(enabled.length).toBeGreaterThan(0);

  for (const type of priority) {
    const match = enabled.find((option) => option.type === type);
    if (match) {
      return match;
    }
  }

  return enabled[0]!;
}

function buildIntentFromOption(
  actor: string,
  option: PlayerOption,
  version: number,
  issuedAt: number,
): TurnIntent {
  const base = {
    id: `${actor}-${option.type}-${issuedAt}`,
    actor,
    issuedAt,
    origin: 'automation' as const,
    expectedSnapshotVersion: version,
  };

  switch (option.type) {
    case 'fold':
      return {
        ...base,
        requested: { type: 'fold' },
      };
    case 'check':
      return {
        ...base,
        requested: { type: 'check' },
      };
    case 'call':
      return {
        ...base,
        requested: { type: 'call', amount: option.amount },
      };
    case 'bet':
      return {
        ...base,
        requested: { type: 'bet', amount: option.min },
      };
    case 'raise':
      return {
        ...base,
        requested: {
          type: 'raise',
          amount: option.min,
          to: option.max ?? option.min,
        },
      };
    case 'all-in':
      return {
        ...base,
        requested: { type: 'all-in', amount: option.amount, from: 'bet' },
      };
    default:
      return {
        ...base,
        requested: { type: 'fold' },
      } satisfies TurnIntent;
  }
}

function createTimestampGenerator(): () => number {
  let current = 1_000;
  return () => {
    current += 5;
    return current;
  };
}

function createDeterministicClock(): () => number {
  let current = 5_000;
  return () => {
    current += 10;
    return current;
  };
}

function requireActor(actor: string | undefined): string {
  expect(actor).toBeDefined();
  return actor ?? 'unassigned-actor';
}
