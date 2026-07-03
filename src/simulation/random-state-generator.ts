import { toSnapshotEnvelope } from '../core/envelopes';
import { type SeatBootstrapConfig, dealHoleCards } from '../session/lifecycle';
import { selectDecisionContext } from '../session/selectors';
import {
  type CreateSessionOptions,
  type ResumeSessionOptions,
  SessionManager,
} from '../session/session-manager';
import type { Card, CardRank, CardSuit, PlayerId } from '../types/common';
import type { DecisionContextView } from '../types/derived';
import type { PlayerOption, TurnEventEnvelope } from '../types/events';
import type {
  RandomStateSummary,
  SerializableSessionState,
  StepRangeConfig,
} from '../types/random-state';
import type { Session, SessionConfig } from '../types/session';
import type { Seat, TableSnapshot } from '../types/snapshot';
import {
  createIntentFromOption,
  finalizeIntent,
  selectBiasedOption,
} from './intent-utils';
import {
  normalizeCallOptionForApi,
  normalizeCallOptionForDisplay,
  resolvePostedBlindAmount,
} from './random-state-blind-utils';
import {
  DEFAULT_RANDOM_STATE_CONFIG,
  DEFAULT_RANDOM_STATE_SEATS,
} from './random-state-defaults';
import type { SimulationIntentPolicy } from './runner';

const DEFAULT_RANDOM_STATE_STEPS: StepRangeConfig = { min: 1, max: 6 };

export interface RandomStateGeneratorOptions {
  readonly config?: SessionConfig;
  readonly seats?: readonly SeatBootstrapConfig[];
  readonly steps?: StepRangeConfig;
  readonly random?: () => number;
  readonly intentPolicy?: SimulationIntentPolicy;
  readonly managerOptions?: CreateSessionOptions;
}

export interface AdvanceRandomStateOptions {
  readonly steps?: StepRangeConfig;
  readonly random?: () => number;
  readonly intentPolicy?: SimulationIntentPolicy;
  readonly resumeOptions?: ResumeSessionOptions;
}

export interface ApplyOptionToStateOptions {
  readonly resumeOptions?: ResumeSessionOptions;
}

const DEFAULT_INTENT_POLICY: SimulationIntentPolicy = async (
  decision,
  session,
  rng,
) => {
  if (!decision.actor) {
    return null;
  }
  const choice = selectBiasedOption(decision, session, rng);
  if (!choice) {
    return null;
  }
  return createIntentFromOption(decision.actor, choice, session);
};

export async function generateRandomState(
  options: RandomStateGeneratorOptions = {},
): Promise<RandomStateSummary> {
  const config = options.config ?? DEFAULT_RANDOM_STATE_CONFIG;
  const seats = options.seats ?? DEFAULT_RANDOM_STATE_SEATS;
  const rng = options.random ?? Math.random;
  const policy = options.intentPolicy ?? DEFAULT_INTENT_POLICY;
  const targetSteps = resolveStepTarget(options.steps, rng);

  const manager = SessionManager.create(config, seats, {
    ...options.managerOptions,
    deck: options.managerOptions?.deck ?? createShuffledDeck(rng),
  });

  const applied = await applyRandomTransitions(
    manager,
    targetSteps,
    policy,
    rng,
  );
  return createSummary(manager, applied);
}

export async function advanceRandomState(
  state: SerializableSessionState,
  options: AdvanceRandomStateOptions = {},
): Promise<RandomStateSummary> {
  const rng = options.random ?? Math.random;
  const policy = options.intentPolicy ?? DEFAULT_INTENT_POLICY;
  const targetSteps = resolveStepTarget(options.steps, rng);
  const manager = resumeManager(state, options.resumeOptions);

  const applied = await applyRandomTransitions(
    manager,
    targetSteps,
    policy,
    rng,
  );
  return createSummary(manager, applied);
}

export async function applyOptionToState(
  state: SerializableSessionState,
  actor: PlayerId,
  option: PlayerOption,
  options: ApplyOptionToStateOptions = {},
): Promise<RandomStateSummary> {
  const manager = resumeManager(state, options.resumeOptions);
  const decision = selectDecisionContext(manager.session);

  if (!decision.actor || decision.actor !== actor) {
    throw new Error('The provided actor is not the current decision maker.');
  }

  const normalizedOption = normalizeCallOptionForApi(
    option,
    manager.session.activeSnapshot,
    actor,
  );

  const legal = findMatchingOption(normalizedOption, decision.availableActions);
  if (!legal || legal.disabled) {
    throw new Error('The provided option is not legal for the current actor.');
  }

  const intent = createIntentFromOption(actor, legal, manager.session);
  const prepared = finalizeIntent(intent, manager.session, decision);
  await manager.applyIntent(prepared);

  return createSummary(manager, 1);
}

export {
  DEFAULT_RANDOM_STATE_CONFIG,
  DEFAULT_RANDOM_STATE_SEATS,
} from './random-state-defaults';

function resumeManager(
  state: SerializableSessionState,
  options: ResumeSessionOptions | undefined,
): SessionManager {
  return SessionManager.resume(
    {
      sessionId: state.id,
      config: state.config,
      runtimeContext: state.runtimeContext,
      initialSnapshot: state.initialSnapshot,
      events: state.events,
      metrics: state.metrics,
      channels: state.channels,
      hooks: {},
    },
    options,
  );
}

async function applyRandomTransitions(
  manager: SessionManager,
  steps: number,
  policy: SimulationIntentPolicy,
  rng: () => number,
): Promise<number> {
  let applied = 0;

  while (applied < steps) {
    const decision = selectDecisionContext(manager.session);
    if (!decision.actor) {
      break;
    }

    const candidate = await policy(decision, manager.session, rng);
    if (!candidate) {
      break;
    }

    const intent = finalizeIntent(candidate, manager.session, decision);
    await manager.applyIntent(intent);
    applied += 1;
  }

  return applied;
}

function createSummary(
  manager: SessionManager,
  appliedSteps: number,
): RandomStateSummary {
  const session = ensureHoleCards(manager.session);
  const decision = selectDecisionContext(session);
  const normalizedDecision = normalizeDecisionForBlinds(
    decision,
    session.activeSnapshot,
  );
  return {
    session: serializeSession(session, manager.eventLog),
    decision: normalizedDecision,
    stepsApplied: appliedSteps,
  } satisfies RandomStateSummary;
}

function normalizeDecisionForBlinds(
  decision: DecisionContextView,
  snapshot: TableSnapshot,
): DecisionContextView {
  if (!decision.actor) {
    return decision;
  }

  const posted = resolvePostedBlindAmount(snapshot, decision.actor);
  if (posted <= 0 || decision.availableActions.length === 0) {
    return decision;
  }

  const adjustedActions = decision.availableActions.map((action) =>
    normalizeCallOptionForDisplay(action, posted),
  );

  return {
    ...decision,
    availableActions: adjustedActions,
  } satisfies DecisionContextView;
}

function createShuffledDeck(random: () => number): readonly Card[] {
  const deck = createStandardDeck();
  shuffleInPlace(deck, random);
  return deck;
}

function createStandardDeck(): Card[] {
  const ranks: readonly CardRank[] = [
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    'T',
    'J',
    'Q',
    'K',
    'A',
  ];
  const suits: readonly CardSuit[] = ['c', 'd', 'h', 's'];

  const deck: Card[] = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push(`${rank}${suit}` as Card);
    }
  }
  return deck;
}

function shuffleInPlace<T>(values: T[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = values[index];
    const candidate = values[swapIndex];
    if (current === undefined || candidate === undefined) {
      continue;
    }
    values[index] = candidate;
    values[swapIndex] = current;
  }
}

function serializeSession(
  session: Session,
  events: readonly TurnEventEnvelope[],
): SerializableSessionState {
  return {
    id: session.id,
    config: session.config,
    runtimeContext: session.runtimeContext,
    initialSnapshot: toSnapshotEnvelope(session.initialSnapshot),
    activeSnapshot: session.activeSnapshot,
    metrics: session.metrics,
    channels: session.channels,
    events,
  } satisfies SerializableSessionState;
}

function resolveStepTarget(
  range: StepRangeConfig | undefined,
  rng: () => number,
): number {
  const min = Math.max(
    0,
    Math.floor(range?.min ?? DEFAULT_RANDOM_STATE_STEPS.min ?? 0),
  );
  const resolvedMax = range?.max ?? DEFAULT_RANDOM_STATE_STEPS.max ?? min;
  const max = Math.max(min, Math.floor(resolvedMax));
  if (max === min) {
    return max;
  }
  const span = max - min + 1;
  return min + Math.floor(rng() * span);
}

function findMatchingOption(
  requested: PlayerOption,
  available: readonly PlayerOption[],
): PlayerOption | undefined {
  return available.find((candidate) => isSameOption(candidate, requested));
}

function isSameOption(a: PlayerOption, b: PlayerOption): boolean {
  if (a.type !== b.type) {
    return false;
  }
  switch (a.type) {
    case 'fold':
    case 'check':
      return true;
    case 'call':
      return a.amount === (b as typeof a).amount;
    case 'bet':
    case 'raise':
      return (
        a.min === (b as typeof a).min &&
        a.max === (b as typeof a).max &&
        a.increment === (b as typeof a).increment
      );
    case 'all-in':
      return a.amount === (b as typeof a).amount;
    default:
      return false;
  }
}

function ensureHoleCards(session: Session): Session {
  const perPlayer =
    session.config.ruleSet.cardDistribution.holeCardsPerPlayer ?? 0;
  if (perPlayer <= 0) {
    return session;
  }

  const seats = session.activeSnapshot.seating.seats;
  if (seats.length === 0) {
    return session;
  }

  const order = resolveHoleCardOrder(
    seats,
    session.activeSnapshot.hand.buttonSeat,
  );
  if (order.length === 0) {
    return session;
  }

  const needsDeal = order.some((playerId) => {
    const cards = session.activeSnapshot.cards.holeCards[playerId];
    return !cards || cards.length < perPlayer;
  });

  let working = session;
  if (needsDeal) {
    working = dealHoleCards(session, order).session;
  }

  const initialNeedsUpdate = order.some((playerId) => {
    const cards = working.initialSnapshot.cards.holeCards[playerId];
    return !cards || cards.length < perPlayer;
  });

  if (!needsDeal && !initialNeedsUpdate) {
    return working;
  }

  const snapshot = working.activeSnapshot;

  let initialSnapshot = working.initialSnapshot;
  if (initialNeedsUpdate) {
    const initialClone = cloneSnapshot(working.initialSnapshot);
    const cardsClone = cloneSnapshot(snapshot).cards;

    initialSnapshot = {
      ...initialClone,
      cards: cardsClone,
    };
  }

  return {
    ...working,
    initialSnapshot,
  };
}

function resolveHoleCardOrder(
  seats: readonly Seat[],
  buttonIndex: number,
): PlayerId[] {
  if (seats.length === 0) {
    return [];
  }

  const order: PlayerId[] = [];
  let index = buttonIndex;

  for (let offset = 0; offset < seats.length; offset += 1) {
    index = (index + 1) % seats.length;
    const seat = seats[index];
    if (!seat || seat.status !== 'occupied') {
      continue;
    }
    const occupant = seat.occupant;
    if (!occupant) {
      continue;
    }
    order.push(occupant.playerId);
  }

  return order;
}

function cloneSnapshot(snapshot: TableSnapshot): TableSnapshot {
  if (typeof structuredClone === 'function') {
    return structuredClone(snapshot);
  }
  return JSON.parse(JSON.stringify(snapshot)) as TableSnapshot;
}

declare function structuredClone<T>(value: T): T;
