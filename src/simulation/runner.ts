import { type SnapshotEnvelope, toSnapshotEnvelope } from '../core/envelopes';
import type { SeatBootstrapConfig } from '../session/lifecycle';
import { selectDecisionContext } from '../session/selectors';
import {
  type CreateSessionOptions,
  SessionManager,
} from '../session/session-manager';
import {
  type RuntimeDispatchBuffer,
  type RuntimeDispatchBus,
  createInMemoryBufferSink,
  createRuntimeDispatchBus,
} from '../telemetry/runtime-dispatch';
import type { PlayerId } from '../types/common';
import type { DecisionContextView } from '../types/derived';
import type { TurnIntent } from '../types/events';
import type { Session, SessionConfig } from '../types/session';
import type { TableSnapshot } from '../types/snapshot';
import {
  createIntentFromOption,
  finalizeIntent,
  selectBiasedOption,
} from './intent-utils';

export interface SimulationRunnerConfig {
  readonly config: SessionConfig;
  readonly seats: readonly SeatBootstrapConfig[];
  readonly hands: number;
  readonly intentPolicy?: SimulationIntentPolicy;
  readonly random?: () => number;
  readonly managerOptions?: CreateSessionOptions;
  readonly dispatchBus?: RuntimeDispatchBus;
  readonly checkpointEvery?: number;
}

export interface SimulationRunner {
  readonly run: () => Promise<SimulationRunResult>;
  readonly bus: RuntimeDispatchBus;
  readonly buffer: RuntimeDispatchBuffer;
}

export type SimulationIntentPolicy = (
  decision: DecisionContextView,
  session: Session,
  rng: () => number,
) => TurnIntent | null | Promise<TurnIntent | null>;

export interface SimulationCheckpoint {
  readonly handNumber: number;
  readonly eventCount: number;
  readonly snapshot: SnapshotEnvelope<TableSnapshot>;
}

export interface SimulationRunResult {
  readonly finalSession: Session;
  readonly handsCompleted: number;
  readonly intentsApplied: number;
  readonly checkpoints: readonly SimulationCheckpoint[];
  readonly dispatches: RuntimeDispatchBuffer;
}

export function createSimulationRunner(
  options: SimulationRunnerConfig,
): SimulationRunner {
  const bus = options.dispatchBus ?? createRuntimeDispatchBus();
  const { sink, buffer } = createInMemoryBufferSink({
    id: 'simulation-buffer',
  });
  bus.register(sink);

  const rng = options.random ?? Math.random;
  const policy = options.intentPolicy ?? defaultIntentPolicy;
  const checkpointEvery = Math.max(1, options.checkpointEvery ?? 25);

  async function run(): Promise<SimulationRunResult> {
    const manager = SessionManager.create(options.config, options.seats, {
      ...options.managerOptions,
    });

    manager.startSimulation(`simulation-${Date.now()}`, options.hands);

    const checkpoints: SimulationCheckpoint[] = [];
    let intentsApplied = 0;
    let handsCompleted = 0;

    while (handsCompleted < options.hands) {
      const decision = selectDecisionContext(manager.session);

      if (!decision.actor) {
        if (isHandResolved(manager.session, decision)) {
          handsCompleted += 1;
          manager.trackSimulationProgress(handsCompleted);
          if (handsCompleted % checkpointEvery === 0) {
            checkpoints.push(createCheckpoint(manager.session));
          }
          if (handsCompleted >= options.hands) {
            break;
          }
          await manager.advanceHand();
          continue;
        }
        break;
      }

      const candidate = await policy(decision, manager.session, rng);
      if (!candidate) {
        break;
      }
      const intent = prepareIntent(candidate, manager.session, decision);
      const outcome = await manager.applyIntent(intent);
      intentsApplied += 1;
      await bus.dispatch(outcome.channels);

      if (outcome.session.activeSnapshot.hand.stage === 'showdown') {
        handsCompleted += 1;
        manager.trackSimulationProgress(handsCompleted);
        if (handsCompleted % checkpointEvery === 0) {
          checkpoints.push(createCheckpoint(manager.session));
        }
        if (handsCompleted < options.hands) {
          await manager.advanceHand();
        }
      }
    }

    return {
      finalSession: manager.session,
      handsCompleted,
      intentsApplied,
      checkpoints,
      dispatches: buffer,
    } satisfies SimulationRunResult;
  }

  return {
    run,
    bus,
    buffer,
  } satisfies SimulationRunner;
}

async function defaultIntentPolicy(
  decision: DecisionContextView,
  session: Session,
  rng: () => number,
): Promise<TurnIntent | null> {
  if (!decision.actor) {
    return null;
  }
  const choice = selectBiasedOption(decision, session, rng);
  if (!choice) {
    return null;
  }
  return createIntentFromOption(decision.actor, choice, session);
}
const prepareIntent = finalizeIntent;

function createCheckpoint(session: Session): SimulationCheckpoint {
  return {
    handNumber: session.activeSnapshot.handNumber,
    eventCount: session.events.length,
    snapshot: toSnapshotEnvelope(session.activeSnapshot),
  } satisfies SimulationCheckpoint;
}

function isHandResolved(
  session: Session,
  decision: DecisionContextView,
): boolean {
  const snapshot = session.activeSnapshot;
  if (snapshot.hand.stage === 'showdown') {
    return true;
  }
  if (decision.availableActions.length === 0) {
    return true;
  }
  const eligible = new Set<PlayerId>();
  for (const player of snapshot.pots.main.eligiblePlayers) {
    eligible.add(player);
  }
  for (const pot of snapshot.pots.sides) {
    for (const player of pot.eligiblePlayers) {
      eligible.add(player);
    }
  }
  return eligible.size <= 1;
}
