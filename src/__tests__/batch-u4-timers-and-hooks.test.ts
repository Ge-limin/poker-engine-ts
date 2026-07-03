import { describe, expect, test } from 'vitest';

import {
  advanceActionClock,
  appendReplayEntry,
  createTableSnapshot,
  createTurnIntent,
  endDealerPause,
  invokeEngineHooks,
  partitionShowdownByVisibility,
  startDealerPause,
  updateSessionMetrics,
  validateEquityBreakdown,
  validateIntent,
  validateShowdownAgainstPolicy,
} from '..';
import type {
  EngineHooks,
  EvaluationPolicy,
  Session,
  SessionConfig,
  SessionMetrics,
  TelemetryPayload,
  TelemetryUpdateContext,
} from '..';
import type { ReplayQueueEntry } from '..';
import type { PersonaAdjustmentView } from '../types/derived';
import type {
  ActionClock,
  PayoutSummary,
  ShowdownSummary,
} from '../types/snapshot';

function createShowdownSummary(): ShowdownSummary {
  return {
    evaluatedHands: [
      {
        playerId: 'player-a',
        rankClass: 'full-house',
        rankValue: 7000,
        bestFive: ['Ah', 'As', 'Ad', 'Kh', 'Ks'],
        kickers: [],
      },
      {
        playerId: 'player-b',
        rankClass: 'pair',
        rankValue: 2000,
        bestFive: ['Qh', 'Qs', 'Jh', 'Td', '9s'],
        kickers: ['8h', '7d', '6s'],
      },
    ],
    board: ['Ah', 'As', 'Kh', 'Ks', 'Qh'],
    evaluatorId: 'lookup-v1',
    equities: [
      {
        playerId: 'player-a',
        winPct: 80,
        tiePct: 10,
        lossPct: 10,
        iterations: 5000,
      },
      {
        playerId: 'player-b',
        winPct: 20,
        tiePct: 10,
        lossPct: 70,
        iterations: 5000,
      },
    ],
  };
}

describe('batch U4 – evaluation, timers & hooks', () => {
  test('hand ranking fidelity validates evaluator contract and rank classes', () => {
    const policy: EvaluationPolicy = {
      engine: 'lookup-table',
      evaluatorId: 'lookup-v1',
      supportsHiLo: false,
      cacheSize: 1024,
    };

    const showdown = createShowdownSummary();
    const result = validateShowdownAgainstPolicy(showdown, policy);
    expect(result.ok).toBe(true);

    const mismatch = validateShowdownAgainstPolicy(
      { ...showdown, evaluatorId: 'hybrid-v2' },
      policy,
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.issues).toContain('evaluator-mismatch');
  });

  test('equity enrichment enforces near-100% totals and consistent iterations', () => {
    const showdown = createShowdownSummary();
    const validation = validateEquityBreakdown(showdown);
    expect(validation.ok).toBe(true);

    const broken = validateEquityBreakdown({
      ...showdown,
      equities: [
        {
          playerId: 'player-a',
          winPct: 70,
          tiePct: 5,
          lossPct: 10,
          iterations: 4000,
        },
        {
          playerId: 'player-b',
          winPct: 20,
          tiePct: 10,
          lossPct: 65,
          iterations: 5000,
        },
      ],
    });
    expect(broken.ok).toBe(false);
    expect(broken.issues).toContain('equity-sum-out-of-range:player-a');
    expect(broken.issues).toContain('iteration-mismatch');
  });

  test('auto-muck hides losing hands while payouts remain intact', () => {
    const showdown = createShowdownSummary();
    const payouts: PayoutSummary = {
      entries: [
        { playerId: 'player-a', amount: 100, potIds: ['main'] },
        { playerId: 'player-b', amount: 0, potIds: [] },
      ],
    };

    const result = partitionShowdownByVisibility(showdown, payouts, [
      'player-b',
    ]);
    expect(result.revealed.map((hand) => hand.playerId)).toEqual(['player-a']);
    expect(result.hidden).toContain('player-b');
    expect(payouts.entries[0]?.amount).toBe(100);
  });

  test('current actor enforcement rejects intents that do not match the clock', () => {
    const snapshot = createTableSnapshot();
    const intent = createTurnIntent({
      actor: 'player-b',
      expectedSnapshotVersion: snapshot.index,
    });

    const result = validateIntent(snapshot, intent);
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('not-actors-turn');
  });

  test('time bank consumption decrements overtime and signals exhaustion', () => {
    const baseClock: ActionClock = {
      currentActor: 'player-a',
      deadline: 1_000,
      perTurnMs: 1_000,
      bankMs: { 'player-a': 2_000 },
      pauses: [],
    };

    const firstAdvance = advanceActionClock(baseClock, 'player-a', 2_500);
    expect(firstAdvance.usedBankMs).toBe(1_500);
    expect(firstAdvance.exhausted).toBe(false);
    expect(firstAdvance.clock.bankMs['player-a']).toBe(500);
    expect(firstAdvance.clock.deadline).toBe(2_500 + baseClock.perTurnMs);

    const exhaustedClock = {
      ...baseClock,
      bankMs: { 'player-a': 300 },
    };
    const exhaustedAdvance = advanceActionClock(
      exhaustedClock,
      'player-a',
      2_000,
    );
    expect(exhaustedAdvance.usedBankMs).toBe(300);
    expect(exhaustedAdvance.exhausted).toBe(true);
    expect(exhaustedAdvance.clock.deadline).toBeUndefined();
  });

  test('pause windows halt advancement until cleared and respect paused duration', () => {
    const baseClock: ActionClock = {
      currentActor: 'player-a',
      deadline: 1_000,
      perTurnMs: 1_000,
      bankMs: { 'player-a': 1_000 },
      pauses: [],
    };

    const pausedClock = startDealerPause(baseClock, 1_200);
    const stillPaused = advanceActionClock(pausedClock, 'player-a', 2_000);
    expect(stillPaused.usedBankMs).toBe(0);
    expect(stillPaused.clock.bankMs['player-a']).toBe(1_000);

    const resumedClock = endDealerPause(pausedClock, 1_600);
    const resumedAdvance = advanceActionClock(resumedClock, 'player-a', 2_000);
    expect(resumedAdvance.usedBankMs).toBe(600);
    expect(resumedAdvance.clock.bankMs['player-a']).toBe(400);
  });

  test('hook invocation order honors priority and stable sorting', async () => {
    const order: string[] = [];
    const hooks: EngineHooks = {
      beforeIntent: [
        {
          id: 'gamma',
          priority: 5,
          handler: async () => {
            order.push('gamma');
          },
        },
        {
          id: 'alpha',
          priority: 1,
          handler: async () => {
            order.push('alpha');
          },
        },
        {
          id: 'beta',
          priority: 5,
          handler: async () => {
            order.push('beta');
          },
        },
      ],
    };

    await invokeEngineHooks(
      hooks,
      'beforeIntent',
      createTurnIntent(),
      createSessionStub(),
    );
    expect(order).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('telemetry fan-out updates latency and pot metrics', () => {
    const metrics: SessionMetrics = {
      handsDealt: 1,
      potsAwarded: 0,
      averagePot: 0,
      avgIntentLatencyMs: 0,
      maxIntentLatencyMs: 0,
      timeoutsHard: 0,
      recoveries: 0,
      simulationsRun: 0,
      advisoryEquityRequests: 0,
    };

    const sampleAdjustment: PersonaAdjustmentView = {
      playerId: 'player-a',
      after: {
        personaId: 'persona-a',
        style: 'balanced',
        aggression: 0,
        tightness: 0,
        bluffIndex: 0,
        riskTolerance: 0,
        trackedMetrics: {
          vpip: 0,
          pfr: 0,
          aggressionFactor: 0,
          showdownRate: 0,
          tiltIndicator: 0,
        },
        featureVector: [],
        lastUpdated: 0,
      },
    };

    const payload: TelemetryPayload = {
      potDelta: 40,
      latencyMs: 120,
      personaAdjustments: [sampleAdjustment],
    };
    const context: TelemetryUpdateContext = { intentSamples: 0 };

    const firstUpdate = updateSessionMetrics(metrics, payload, context);
    expect(firstUpdate.metrics.potsAwarded).toBe(1);
    expect(firstUpdate.metrics.averagePot).toBe(40);
    expect(firstUpdate.metrics.avgIntentLatencyMs).toBe(120);
    expect(firstUpdate.metrics.maxIntentLatencyMs).toBe(120);
    expect(firstUpdate.metrics.advisoryEquityRequests).toBe(1);
    expect(firstUpdate.context.intentSamples).toBe(1);

    const secondUpdate = updateSessionMetrics(
      firstUpdate.metrics,
      { potDelta: 20, latencyMs: 80, personaAdjustments: [] },
      firstUpdate.context,
    );
    expect(secondUpdate.metrics.potsAwarded).toBe(2);
    expect(secondUpdate.metrics.averagePot).toBe(30);
    expect(secondUpdate.metrics.avgIntentLatencyMs).toBe(100);
    expect(secondUpdate.metrics.maxIntentLatencyMs).toBe(120);
    expect(secondUpdate.context.intentSamples).toBe(2);
  });

  test('replay queue maintains chronological order and caps retention', () => {
    const queue: ReplayQueueEntry[] = [
      { id: 'evt-2', recordedAt: 1_000, payloadVersion: 1 },
    ];

    const withEarlier = appendReplayEntry(
      queue,
      { id: 'evt-1', recordedAt: 900, payloadVersion: 1 },
      10,
    );
    expect(withEarlier.map((entry) => entry.id)).toEqual(['evt-1', 'evt-2']);

    const withTie = appendReplayEntry(
      withEarlier,
      { id: 'evt-3', recordedAt: 1_000, payloadVersion: 1 },
      10,
    );
    expect(withTie.map((entry) => entry.id)).toEqual([
      'evt-1',
      'evt-2',
      'evt-3',
    ]);

    const limited = appendReplayEntry(
      withTie,
      { id: 'evt-4', recordedAt: 1_200, payloadVersion: 1 },
      2,
    );
    expect(limited.map((entry) => entry.id)).toEqual(['evt-3', 'evt-4']);
  });
});

function createSessionStub(): Session {
  const snapshot = createTableSnapshot();
  const config: SessionConfig = {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats: 6,
    startingStack: 100,
    blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
    personaPolicy: { defaultStyle: 'balanced' },
    ruleSet: {
      streets: ['preflop', 'flop', 'turn', 'river'],
      postingOrder: ['small-blind', 'big-blind'],
      minRaisePolicy: 'double-last-bet',
      cardDistribution: {
        holeCardsPerPlayer: 2,
        burnPerStreet: [1, 1, 1],
        communityReveal: [3, 1, 1],
      },
      showdownOrdering: 'high-card',
    },
    evaluationPolicy: {
      engine: 'lookup-table',
      evaluatorId: 'lookup-v1',
      supportsHiLo: false,
      cacheSize: 1024,
    },
    autoAdvance: true,
  };

  const metrics: SessionMetrics = {
    handsDealt: 1,
    potsAwarded: 0,
    averagePot: 0,
    avgIntentLatencyMs: 0,
    maxIntentLatencyMs: 0,
    timeoutsHard: 0,
    recoveries: 0,
    simulationsRun: 0,
    advisoryEquityRequests: 0,
  };

  return {
    id: 'session-1',
    config,
    runtimeContext: { mode: 'live' },
    initialSnapshot: snapshot,
    events: [],
    activeSnapshot: snapshot,
    metrics,
    channels: {
      realtime: 'topic',
      analytics: {
        provider: 'noop',
        streamId: 'stream',
        batching: { maxBatch: 1, flushMs: 1 },
      },
      replay: { transport: 'filesystem', retentionHands: 10 },
      advisory: { requestTopic: 'req', responseTopic: 'res', timeoutMs: 1_000 },
    },
    hooks: {},
  };
}
