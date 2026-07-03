import type { SeatBootstrapConfig } from '../session/lifecycle';
import {
  DEFAULT_RANDOM_STATE_SEATS,
  advanceRandomState,
  applyOptionToState,
  generateRandomState,
} from '../simulation/random-state-generator';
import type { PlayerOption } from '../types/events';
import type { RandomStateSummary } from '../types/random-state';
import type { RuntimeContext } from '../types/session';

const PLAYER_COUNT_RANGE = {
  min: 2,
  max: DEFAULT_RANDOM_STATE_SEATS.length,
} as const;

export type HeadlessDecisionMode = 'policy' | 'uniform' | 'first-legal';

export interface HeadlessRandomStateOptions {
  readonly seatCount?: number;
  readonly steps?: number;
  readonly stepRange?: { min?: number; max?: number };
  readonly decisionMode?: HeadlessDecisionMode;
  readonly random?: () => number;
  readonly runtimeContext?: RuntimeContext;
  readonly seats?: readonly SeatBootstrapConfig[];
}

export type HeadlessRandomStateAction =
  | { readonly kind: 'generate'; readonly summary: RandomStateSummary }
  | {
      readonly kind: 'apply';
      readonly summary: RandomStateSummary;
      readonly actor: string;
      readonly option: PlayerOption;
      readonly availableOptions: readonly PlayerOption[];
    }
  | { readonly kind: 'advance'; readonly summary: RandomStateSummary };

export interface HeadlessRandomStateResult {
  readonly log: readonly HeadlessRandomStateAction[];
  readonly initial: RandomStateSummary;
  readonly final: RandomStateSummary;
}

export async function runHeadlessRandomState(
  options: HeadlessRandomStateOptions = {},
): Promise<HeadlessRandomStateResult> {
  const random = options.random ?? Math.random;
  const providedSeats = options.seats?.length
    ? options.seats.map((seat, index) => ({
        ...seat,
        seatIndex: seat.seatIndex ?? index,
      }))
    : undefined;
  const seatCount = clamp(
    providedSeats?.length ?? options.seatCount ?? PLAYER_COUNT_RANGE.max,
    PLAYER_COUNT_RANGE.min,
    PLAYER_COUNT_RANGE.max,
  );
  const seats =
    providedSeats?.slice(0, seatCount) ?? buildSeatConfiguration(seatCount);
  const decisionMode = options.decisionMode ?? 'policy';
  const stepRange = normalizeStepRange(options.stepRange);
  const maxSteps = Math.max(0, Math.floor(options.steps ?? 10));

  let summary = await generateRandomState({
    seats,
    random,
    managerOptions: options.runtimeContext
      ? { runtimeContext: options.runtimeContext }
      : undefined,
  });

  const log: HeadlessRandomStateAction[] = [{ kind: 'generate', summary }];

  for (let index = 0; index < maxSteps; index += 1) {
    const { decision } = summary;
    const actionable = decision.availableActions.filter(
      (option) => !option.disabled,
    );

    if (decision.actor && actionable.length > 0 && decisionMode !== 'policy') {
      const option = selectOption(actionable, decisionMode, random);
      summary = await applyOptionToState(
        summary.session,
        decision.actor,
        option,
      );
      log.push({
        kind: 'apply',
        actor: decision.actor,
        option,
        availableOptions: actionable,
        summary,
      });
      continue;
    }

    summary = await advanceRandomState(summary.session, {
      random,
      steps: stepRange,
    });
    log.push({ kind: 'advance', summary });

    if (summary.stepsApplied <= 0) {
      break;
    }
  }

  return { log, initial: log[0]!.summary, final: summary };
}

function selectOption(
  options: readonly PlayerOption[],
  mode: Exclude<HeadlessDecisionMode, 'policy'>,
  random: () => number,
): PlayerOption {
  if (options.length === 0) {
    throw new Error('No options available for selection.');
  }

  if (mode === 'first-legal') {
    return options[0]!;
  }

  const index = Math.floor(random() * options.length);
  return options[index] ?? options[0]!;
}

function buildSeatConfiguration(count: number): SeatBootstrapConfig[] {
  return DEFAULT_RANDOM_STATE_SEATS.slice(0, count).map((seat, index) => ({
    ...seat,
    seatIndex: index,
  }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeStepRange(
  stepRange: HeadlessRandomStateOptions['stepRange'],
): { min: number; max: number } {
  if (!stepRange) {
    return { min: 1, max: 1 };
  }

  const min = Math.max(0, Math.floor(stepRange.min ?? 1));
  const max = Math.max(min, Math.floor(stepRange.max ?? min));
  return { min, max };
}

export function createSeededRandom(seed: number): () => number {
  let state = normalizeSeed(seed);
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    return 1_234_567_890;
  }

  const normalized = Math.floor(Math.abs(seed)) % 4_294_967_296;
  return normalized === 0 ? 1_234_567_890 : normalized;
}
