// Shared plumbing for every tab. All of it goes through the public API:
// SessionManager, the selectors, the envelope codecs. Nothing reaches into
// engine internals, and no tab keeps prerendered frames around.
import {
  SessionManager,
  deriveRoundComputation,
  generateRandomState,
  selectDecisionContext,
  toSnapshotEnvelope,
  type PlayerOption,
  type SeatBootstrapConfig,
  type SerializableSessionState,
  type Session,
  type SessionConfig,
  type TableSnapshot,
  type TurnIntent,
} from 'poker-engine-ts';

// A fixed clock keeps every engine-derived timestamp deterministic, so a
// session rebuilt from its log can be compared field by field against the
// one it replaces. The clock is a documented option on create and resume.
export const FIXED_NOW = 1_750_000_000_000;
export const now = (): number => FIXED_NOW;

export function makeConfig(smallBlind: number, bigBlind: number): SessionConfig {
  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats: 6,
    startingStack: 120,
    blindSchedule: [{ level: 1, smallBlind, bigBlind }],
    antePolicy: undefined,
    personaPolicy: { defaultStyle: 'balanced' },
    ruleSet: {
      streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
      postingOrder: ['small-blind', 'big-blind'],
      minRaisePolicy: 'double-last-bet',
      cardDistribution: {
        holeCardsPerPlayer: 2,
        burnPerStreet: [1, 1, 1],
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
    simulationPolicy: undefined,
    autoAdvance: true,
  };
}

// Deal a fresh hand: hole cards dealt, blinds posted, nobody has acted yet.
export async function bootstrapHand(
  config: SessionConfig,
  seats: readonly SeatBootstrapConfig[],
  random: () => number,
): Promise<SerializableSessionState> {
  const summary = await generateRandomState({
    config,
    seats,
    random,
    steps: { min: 0, max: 0 },
    managerOptions: { now },
  });
  return summary.session;
}

// Everything resume needs to rebuild a session. Deliberately excludes the
// active snapshot: the log, not the snapshot, is the source of truth.
export type PersistedLog = Omit<SerializableSessionState, 'activeSnapshot'>;

export function resumeFromState(state: PersistedLog): SessionManager {
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
    { now },
  );
}

export function serializeManager(manager: SessionManager): SerializableSessionState {
  const session = manager.session;
  return {
    id: session.id,
    config: session.config,
    runtimeContext: session.runtimeContext,
    initialSnapshot: toSnapshotEnvelope(session.initialSnapshot),
    activeSnapshot: session.activeSnapshot,
    metrics: session.metrics,
    channels: session.channels,
    events: manager.eventLog,
  };
}

// Turn a legal option into the intent a backend client would submit. For bet
// and raise, sizeTo is the round-total target; the engine, not this helper,
// decides whether it is legal.
export function buildIntent(
  actor: string,
  option: PlayerOption,
  session: Session,
  origin: 'ui' | 'automation',
  sizeTo?: number,
): TurnIntent {
  const base = {
    id: `${actor}-${session.events.length + 1}-${option.type}`,
    actor,
    issuedAt: FIXED_NOW,
    origin,
    expectedSnapshotVersion: session.activeSnapshot.index,
  } as const;
  const round = session.activeSnapshot.hand.bettingRounds.at(-1);
  const computation = round ? deriveRoundComputation(round) : undefined;
  const contribution = computation?.contributions.get(actor) ?? 0;
  const highest = computation?.highestContribution ?? 0;
  switch (option.type) {
    case 'fold':
      return { ...base, requested: { type: 'fold' } };
    case 'check':
      return { ...base, requested: { type: 'check' } };
    case 'call':
      return { ...base, requested: { type: 'call', amount: option.amount } };
    case 'bet': {
      const amount = sizeTo ?? option.min;
      return { ...base, requested: { type: 'bet', amount } };
    }
    case 'raise': {
      const to = sizeTo ?? option.min;
      return { ...base, requested: { type: 'raise', amount: to - contribution, to } };
    }
    case 'all-in': {
      const total = contribution + option.amount;
      const from = highest === 0 ? 'bet' : total > highest ? 'raise' : 'call';
      return { ...base, requested: { type: 'all-in', amount: option.amount, from } };
    }
    default:
      return { ...base, requested: { type: 'fold' } };
  }
}

export type DecisionView = ReturnType<typeof selectDecisionContext>;

export function decisionOf(manager: SessionManager): DecisionView {
  return selectDecisionContext(manager.session);
}

export interface DiffResult {
  readonly leaves: number;
  readonly mismatches: readonly string[];
}

// Structural comparison for snapshots that have crossed a JSON boundary:
// an explicitly undefined field and an absent key mean the same thing.
export function diffValues(a: unknown, b: unknown, path = 'snapshot'): DiffResult {
  if (a === undefined && b === undefined) return { leaves: 1, mismatches: [] };
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    const equal = Object.is(a, b);
    return {
      leaves: 1,
      mismatches: equal ? [] : [`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`],
    };
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return { leaves: 1, mismatches: [`${path}: array and object disagree`] };
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let leaves = 0;
  const mismatches: string[] = [];
  for (const key of keys) {
    const child = diffValues(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${path}.${key}`,
    );
    leaves += child.leaves;
    mismatches.push(...child.mismatches);
  }
  return { leaves, mismatches };
}

export function boardCards(snapshot: TableSnapshot): string[] {
  const community = snapshot.cards.community;
  return [
    ...(community.flop ?? []),
    ...(community.turn ? [community.turn] : []),
    ...(community.river ? [community.river] : []),
  ];
}

export function chipsInPlay(snapshot: TableSnapshot): number {
  const stacks = snapshot.seating.seats.reduce((sum, seat) => sum + seat.stack, 0);
  const sides = snapshot.pots.sides.reduce((sum, pot) => sum + pot.amount, 0);
  return stacks + snapshot.pots.main.amount + snapshot.pots.rake + sides;
}

export function foldedPlayers(snapshot: TableSnapshot): Set<string> {
  const folded = new Set<string>();
  for (const round of snapshot.hand.bettingRounds) {
    for (const turn of round.turns) {
      if (turn.action.type === 'fold') folded.add(turn.actor);
    }
  }
  return folded;
}

// Compact, faithful rendering of a legal option for the options panel.
export function describeOptionWindow(option: PlayerOption): string {
  switch (option.type) {
    case 'fold':
      return 'fold';
    case 'check':
      return 'check';
    case 'call':
      return `call ${option.amount}`;
    case 'bet':
      return `bet ${option.min} to ${option.max}`;
    case 'raise':
      return `raise to ${option.min} up to ${option.max}`;
    case 'all-in':
      return `all-in ${option.amount}`;
    default:
      return (option as { type: string }).type;
  }
}

// Weighted bot policy: leans on check and call, raises the minimum now and
// then, rarely shoves. Only ever picks from the engine's own legal options.
export function pickBotOption(
  options: readonly PlayerOption[],
  rng: () => number,
): { option: PlayerOption; sizeTo?: number } | null {
  const legal = options.filter((option) => !option.disabled);
  if (legal.length === 0) return null;
  const canCheck = legal.some((option) => option.type === 'check');
  const weightOf = (option: PlayerOption): number => {
    switch (option.type) {
      case 'check':
        return 5;
      case 'call':
        return 4;
      case 'bet':
        return 2;
      case 'raise':
        return 1.5;
      case 'all-in':
        return 0.3;
      case 'fold':
        return canCheck ? 0 : 1.5;
      default:
        return 0;
    }
  };
  const total = legal.reduce((sum, option) => sum + weightOf(option), 0);
  if (total <= 0) return { option: legal[0] };
  let roll = rng() * total;
  for (const option of legal) {
    roll -= weightOf(option);
    if (roll <= 0) {
      if (option.type === 'bet' || option.type === 'raise') {
        const steps = Math.floor(rng() * 3);
        const sizeTo = Math.min(option.max, option.min + steps * option.increment);
        return { option, sizeTo };
      }
      return { option };
    }
  }
  return { option: legal[legal.length - 1] };
}
