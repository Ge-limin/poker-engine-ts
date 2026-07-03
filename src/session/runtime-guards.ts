import { RuntimeModeViolationError } from '../core/errors';
import type { RuntimeMode } from '../types/common';
import type { RuntimeContext, Session } from '../types/session';

type GuardTarget = Session | RuntimeContext;

type LiveRuntimeContext = Extract<RuntimeContext, { mode: 'live' }>;
type ReplayRuntimeContext = Extract<RuntimeContext, { mode: 'replay' }>;
type SimulationRuntimeContext = Extract<RuntimeContext, { mode: 'simulation' }>;
type ScenarioRuntimeContext = Extract<RuntimeContext, { mode: 'scenario' }>;

function hasRuntimeContext(target: GuardTarget): target is Session {
  return (target as Session).runtimeContext !== undefined;
}

function resolveContext(target: GuardTarget): RuntimeContext {
  return hasRuntimeContext(target) ? target.runtimeContext : target;
}

function violation(
  context: RuntimeContext,
  action: string,
  expected: readonly RuntimeMode[],
  extra: Record<string, unknown> = {},
): never {
  const allowed = expected.join(', ');
  const message = `Cannot ${action} while session is in ${context.mode} mode. Expected one of: ${allowed}.`;
  throw new RuntimeModeViolationError(message, {
    action,
    allowedModes: expected,
    actualMode: context.mode,
    ...extra,
  });
}

export function assertRuntimeModes(
  target: GuardTarget,
  modes: readonly RuntimeMode[],
  action: string,
): RuntimeContext {
  const context = resolveContext(target);
  if (!modes.includes(context.mode)) {
    violation(context, action, modes);
  }
  return context;
}

export function assertLivePlay(
  target: GuardTarget,
  action = 'mutate session state',
): LiveRuntimeContext {
  const context = resolveContext(target);
  if (context.mode !== 'live') {
    violation(context, action, ['live']);
  }
  return context as LiveRuntimeContext;
}

export interface ReplayTimelineOptions {
  readonly eventCount?: number;
}

export function assertReplayTimeline(
  target: GuardTarget,
  action = 'control replay timeline',
  options: ReplayTimelineOptions = {},
): ReplayRuntimeContext {
  const context = resolveContext(target);
  if (context.mode !== 'replay') {
    violation(context, action, ['replay']);
  }
  if (
    options.eventCount !== undefined &&
    (context.timelineIndex < 0 || context.timelineIndex > options.eventCount)
  ) {
    violation(context, action, ['replay'], {
      timelineIndex: context.timelineIndex,
      eventCount: options.eventCount,
    });
  }
  return context as ReplayRuntimeContext;
}

export interface ScenarioPlaybackOptions {
  readonly eventCount?: number;
}

export function assertScenarioPlayback(
  target: GuardTarget,
  action = 'review scenario history',
  options: ScenarioPlaybackOptions = {},
): ScenarioRuntimeContext {
  const context = resolveContext(target);
  if (context.mode !== 'scenario') {
    violation(context, action, ['scenario']);
  }
  if (context.viewingIndex === null) {
    violation(context, action, ['scenario'], {
      viewingIndex: context.viewingIndex,
      reason: 'scenario-aligned-with-live',
    });
  }
  if (
    options.eventCount !== undefined &&
    (context.viewingIndex < 0 || context.viewingIndex > options.eventCount)
  ) {
    violation(context, action, ['scenario'], {
      viewingIndex: context.viewingIndex,
      eventCount: options.eventCount,
    });
  }
  return context as ScenarioRuntimeContext;
}

export function assertScenarioInteractive(
  target: GuardTarget,
  action = 'submit scenario intent',
): ScenarioRuntimeContext {
  const context = resolveContext(target);
  if (context.mode !== 'scenario') {
    violation(context, action, ['scenario']);
  }
  if (context.isCompleted) {
    violation(context, action, ['scenario'], {
      state: 'completed',
    });
  }
  if (context.viewingIndex !== null) {
    violation(context, action, ['scenario'], {
      viewingIndex: context.viewingIndex,
    });
  }
  return context as ScenarioRuntimeContext;
}

export function assertSimulationControl(
  target: GuardTarget,
  action = 'control simulation runtime',
): SimulationRuntimeContext {
  const context = resolveContext(target);
  if (context.mode !== 'simulation') {
    violation(context, action, ['simulation']);
  }
  if (context.handsCompleted > context.handsToRun) {
    violation(context, action, ['simulation'], {
      handsCompleted: context.handsCompleted,
      handsToRun: context.handsToRun,
    });
  }
  return context as SimulationRuntimeContext;
}

export function createRuntimeModeViolation(
  target: GuardTarget,
  action: string,
  modes: readonly RuntimeMode[],
  extra: Record<string, unknown> = {},
): RuntimeModeViolationError {
  const context = resolveContext(target);
  const allowed = modes.join(', ');
  const message = `Cannot ${action} while session is in ${context.mode} mode. Expected one of: ${allowed}.`;
  return new RuntimeModeViolationError(message, {
    action,
    allowedModes: modes,
    actualMode: context.mode,
    ...extra,
  });
}
