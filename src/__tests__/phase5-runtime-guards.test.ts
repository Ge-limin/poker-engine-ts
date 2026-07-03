import { describe, expect, test } from 'vitest';

import {
  SessionManager,
  assertLivePlay,
  assertReplayTimeline,
  assertRuntimeModes,
  assertScenarioInteractive,
  assertScenarioPlayback,
  assertSimulationControl,
  createRuntimeModeViolation,
} from '..';
import { RuntimeModeViolationError } from '../core/errors';
import type { SeatBootstrapConfig } from '../session/lifecycle';
import { selectDecisionContext } from '../session/selectors';
import {
  type SimulationIntentPolicy,
  createSimulationRunner,
} from '../simulation/runner';
import {
  createInMemoryBufferSink,
  createRuntimeDispatchBus,
} from '../telemetry/runtime-dispatch';
import type { DecisionContextView } from '../types/derived';
import type { TurnIntent } from '../types/events';
import type { RuntimeContext, Session, SessionConfig } from '../types/session';

describe('phase 5 runtime enforcement', () => {
  test('runtime guards allow expected modes and annotate violations', () => {
    const manager = createManager();
    const live = assertRuntimeModes(
      manager.session,
      ['live', 'replay'],
      'apply intents',
    );
    expect(live.mode).toBe('live');

    const violation = createRuntimeModeViolation(
      {
        mode: 'scenario',
        scenarioId: 's',
        isCompleted: false,
        viewingIndex: 0,
      },
      'mutate session state',
      ['live'],
    );
    expect(violation).toBeInstanceOf(RuntimeModeViolationError);
    expect(violation.details).toMatchObject({
      code: 'runtime_mode_violation',
      context: {
        action: 'mutate session state',
        allowedModes: ['live'],
        actualMode: 'scenario',
      },
    });
  });

  test('live play guard rejects non-live sessions', () => {
    expect(() =>
      assertLivePlay(
        { mode: 'replay', timelineIndex: 0, isPlaying: true, speed: 1 },
        'dispatch intents',
      ),
    ).toThrow(RuntimeModeViolationError);
  });

  test('timeline guards enforce playback bounds and prerequisites', () => {
    const replay: Extract<RuntimeContext, { mode: 'replay' }> = {
      mode: 'replay',
      timelineIndex: 2,
      isPlaying: false,
      speed: 1,
    };
    expect(() =>
      assertReplayTimeline(replay, 'seek', { eventCount: 1 }),
    ).toThrow(RuntimeModeViolationError);

    const scenarioReview: Extract<RuntimeContext, { mode: 'scenario' }> = {
      mode: 'scenario',
      scenarioId: 'scenario-1',
      isCompleted: false,
      viewingIndex: null,
    };
    expect(() => assertScenarioPlayback(scenarioReview)).toThrow(
      RuntimeModeViolationError,
    );

    const scenarioIndexed: Extract<RuntimeContext, { mode: 'scenario' }> = {
      ...scenarioReview,
      viewingIndex: 5,
    };
    expect(() =>
      assertScenarioPlayback(scenarioIndexed, 'scrub history', {
        eventCount: 3,
      }),
    ).toThrow(RuntimeModeViolationError);
  });

  test('scenario interactive guard enforces completion state', () => {
    const context: Extract<RuntimeContext, { mode: 'scenario' }> = {
      mode: 'scenario',
      scenarioId: 'example',
      isCompleted: true,
      viewingIndex: null,
    };

    expect(() => assertScenarioInteractive(context)).toThrow(
      RuntimeModeViolationError,
    );
  });

  test('simulation guard enforces completion threshold', () => {
    const context: Extract<RuntimeContext, { mode: 'simulation' }> = {
      mode: 'simulation',
      simulationId: 'sim-1',
      handsToRun: 5,
      handsCompleted: 6,
    };
    expect(() => assertSimulationControl(context)).toThrow(
      RuntimeModeViolationError,
    );
  });

  test('scenario guard rejects playback interactions during review', () => {
    const context: Extract<RuntimeContext, { mode: 'scenario' }> = {
      mode: 'scenario',
      scenarioId: 'example',
      isCompleted: false,
      viewingIndex: 3,
    };

    expect(() => assertScenarioInteractive(context)).toThrow(
      RuntimeModeViolationError,
    );
  });

  test('simulation mode blocks ui-origin intents but allows automation', async () => {
    const manager = createManager();
    manager.startSimulation('sim-test', 1);

    const decision = selectDecisionContext(manager.session);
    const option = decision.availableActions.find((entry) => !entry.disabled);
    const actor = decision.actor ?? 'player-1';
    const baseIntent = buildIntent(actor, option, manager);

    await expect(
      manager.applyIntent({ ...baseIntent, origin: 'ui' }),
    ).rejects.toThrow(RuntimeModeViolationError);

    const automated = await manager.applyIntent({
      ...baseIntent,
      origin: 'automation',
    });
    expect(automated.validation.kind).toBe('accepted');
  });

  test('simulation runner emits dispatches and checkpoints', async () => {
    const bus = createRuntimeDispatchBus();
    const { sink, buffer } = createInMemoryBufferSink({ id: 'runner-buffer' });
    bus.register(sink);

    const intentPolicy: SimulationIntentPolicy = async (decision, session) => {
      if (!decision.actor) {
        return null;
      }
      const chosen =
        decision.availableActions.find(
          (entry) => !entry.disabled && entry.type !== 'fold',
        ) ?? decision.availableActions.find((entry) => !entry.disabled);
      if (!chosen) {
        return null;
      }
      return buildIntentFromSession(decision.actor, chosen, session);
    };

    const runner = createSimulationRunner({
      config: createConfig(),
      seats: createSeats(),
      hands: 2,
      dispatchBus: bus,
      checkpointEvery: 1,
      intentPolicy,
      random: () => 0.42,
    });

    const result = await runner.run();
    expect(result.handsCompleted).toBeGreaterThanOrEqual(1);
    expect(result.intentsApplied).toBeGreaterThan(0);
    expect(result.checkpoints).not.toHaveLength(0);
    expect(buffer.telemetry.length).toBeGreaterThan(0);
  });

  test('simulation runner resolves empty decision states', async () => {
    const bus = createRuntimeDispatchBus();
    const { sink } = createInMemoryBufferSink({ id: 'empty-decision-buffer' });
    bus.register(sink);

    const runner = createSimulationRunner({
      config: createConfig(),
      seats: createSeats(),
      hands: 1,
      dispatchBus: bus,
      checkpointEvery: 1,
      intentPolicy: async (decision, session) => {
        if (!decision.actor) {
          return null;
        }
        const option = decision.availableActions.find(
          (entry) => !entry.disabled && entry.type !== 'fold',
        );
        const chosen =
          option ?? decision.availableActions.find((entry) => !entry.disabled);
        if (!chosen) {
          return null;
        }
        return buildIntentFromSession(decision.actor, chosen, session);
      },
    });

    const result = await runner.run();
    expect(result.handsCompleted).toBe(1);
    expect(result.checkpoints).toHaveLength(1);
  });

  test('simulation runner tracks fold completions', async () => {
    const runner = createSimulationRunner({
      config: createConfig(),
      seats: createSeats(),
      hands: 1,
      intentPolicy: async (decision, session) => {
        if (!decision.actor) {
          return null;
        }
        const foldOption = decision.availableActions.find(
          (entry) => entry.type === 'fold' && !entry.disabled,
        );
        const chosen =
          foldOption ??
          decision.availableActions.find((entry) => !entry.disabled);
        if (!chosen) {
          return null;
        }
        return buildIntentFromSession(decision.actor, chosen, session);
      },
    });

    const result = await runner.run();
    expect(result.handsCompleted).toBe(1);
    expect(result.intentsApplied).toBeGreaterThan(0);
  });
});

function createManager(): SessionManager {
  return SessionManager.create(createConfig(), createSeats());
}

function createConfig(): SessionConfig {
  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats: 2,
    startingStack: 100,
    blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
    antePolicy: undefined,
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
      cacheSize: 1_024,
    },
    simulationPolicy: undefined,
    autoAdvance: true,
  } satisfies SessionConfig;
}

function createSeats(): readonly SeatBootstrapConfig[] {
  return [
    { playerId: 'player-1', seatIndex: 0, stack: 100 },
    { playerId: 'player-2', seatIndex: 1, stack: 100 },
  ];
}

function buildIntentFromSession(
  actor: string,
  option: DecisionContextView['availableActions'][number],
  session: Session,
): TurnIntent {
  const base: Omit<TurnIntent, 'requested'> = {
    id: `${actor}-${option.type}-${session.events.length}`,
    actor,
    issuedAt: Date.now(),
    origin: 'automation',
    expectedSnapshotVersion: session.activeSnapshot.index,
  };

  switch (option.type) {
    case 'fold':
      return { ...base, requested: { type: 'fold' } } satisfies TurnIntent;
    case 'check':
      return { ...base, requested: { type: 'check' } } satisfies TurnIntent;
    case 'call':
      return {
        ...base,
        requested: { type: 'call', amount: option.amount },
      } satisfies TurnIntent;
    case 'bet':
      return {
        ...base,
        requested: { type: 'bet', amount: option.min },
      } satisfies TurnIntent;
    case 'raise':
      return {
        ...base,
        requested: { type: 'raise', amount: option.min, to: option.min },
      } satisfies TurnIntent;
    case 'all-in':
      return {
        ...base,
        requested: {
          type: 'all-in',
          amount: option.amount,
          from: 'bet',
        },
      } satisfies TurnIntent;
    default:
      return { ...base, requested: { type: 'check' } } satisfies TurnIntent;
  }
}

function buildIntent(
  actor: string,
  option: DecisionContextView['availableActions'][number] | undefined,
  manager: SessionManager,
): TurnIntent {
  const base: TurnIntent = {
    id: `${actor}-intent`,
    actor,
    requested: { type: 'check' },
    issuedAt: Date.now(),
    origin: 'automation',
    expectedSnapshotVersion: manager.session.activeSnapshot.index,
  };

  if (!option || option.type === 'check') {
    return base;
  }
  switch (option.type) {
    case 'fold':
      return { ...base, requested: { type: 'fold' } } satisfies TurnIntent;
    case 'call':
      return {
        ...base,
        requested: { type: 'call', amount: option.amount },
      } satisfies TurnIntent;
    case 'bet':
      return {
        ...base,
        requested: { type: 'bet', amount: option.min },
      } satisfies TurnIntent;
    case 'raise':
      return {
        ...base,
        requested: { type: 'raise', amount: option.min, to: option.min },
      } satisfies TurnIntent;
    case 'all-in':
      return {
        ...base,
        requested: {
          type: 'all-in',
          amount: option.amount,
          from: 'bet',
        },
      } satisfies TurnIntent;
    default:
      return base;
  }
}
