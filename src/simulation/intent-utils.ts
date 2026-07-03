import { deriveRoundComputation } from '../core/intent/round-context';
import type { PlayerId } from '../types/common';
import type { DecisionContextView } from '../types/derived';
import type { PlayerOption, TurnIntent } from '../types/events';
import type { Session } from '../types/session';

export function createIntentFromOption(
  actor: PlayerId,
  option: PlayerOption,
  session: Session,
): TurnIntent {
  const id = `${actor}-${session.events.length + 1}-${option.type}`;
  const issuedAt = Date.now();
  const base = {
    id,
    actor,
    issuedAt,
    origin: 'automation' as const,
    expectedSnapshotVersion: session.activeSnapshot.index,
  } satisfies Pick<
    TurnIntent,
    'id' | 'actor' | 'issuedAt' | 'origin' | 'expectedSnapshotVersion'
  >;

  const round = session.activeSnapshot.hand.bettingRounds.at(-1);
  const computation = round ? deriveRoundComputation(round) : undefined;
  const currentContribution = computation?.contributions.get(actor) ?? 0;
  const currentHighest = computation?.highestContribution ?? 0;

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
    case 'bet': {
      const wager = option.min;
      return {
        ...base,
        requested: { type: 'bet', amount: wager },
      } satisfies TurnIntent;
    }
    case 'raise': {
      const amount = option.min;
      const to = currentContribution + amount;
      return {
        ...base,
        requested: { type: 'raise', amount, to },
      } satisfies TurnIntent;
    }
    case 'all-in': {
      const targetTotal = Math.max(option.amount, currentContribution);
      const amount = Math.max(0, targetTotal - currentContribution);
      const newTotal = currentContribution + amount;
      const from =
        currentHighest === 0
          ? 'bet'
          : newTotal > currentHighest
            ? 'raise'
            : 'call';
      return {
        ...base,
        requested: {
          type: 'all-in',
          amount,
          from,
        },
      } satisfies TurnIntent;
    }
    default:
      return { ...base, requested: { type: 'fold' } } satisfies TurnIntent;
  }
}

export function finalizeIntent(
  intent: TurnIntent,
  session: Session,
  decision: DecisionContextView,
): TurnIntent {
  const id =
    intent.id ?? `${decision.actor ?? 'actor'}-${session.events.length}`;
  return {
    ...intent,
    id,
    origin: intent.origin ?? 'automation',
    issuedAt: intent.issuedAt ?? Date.now(),
    expectedSnapshotVersion:
      intent.expectedSnapshotVersion ?? session.activeSnapshot.index,
  } satisfies TurnIntent;
}

export function selectRandomOption(
  actions: readonly PlayerOption[],
  rng: () => number,
): PlayerOption | undefined {
  const available = actions.filter((option) => !option.disabled);
  if (available.length === 0) {
    return undefined;
  }
  const prioritized = available.filter((option) => option.type !== 'fold');
  const candidates = prioritized.length > 0 ? prioritized : available;
  const index = Math.floor(rng() * candidates.length);
  return candidates[index];
}

function countActivePlayers(session: Session): number {
  return session.activeSnapshot.seating.seats.reduce((total, seat) => {
    if (seat.status === 'occupied' && seat.occupant) {
      return total + 1;
    }
    return total;
  }, 0);
}

function weightForOption(option: PlayerOption, activePlayers: number): number {
  const playerFactor = Math.max(0, activePlayers - 2);
  const passiveBoost = 1 + playerFactor * 0.5;
  const aggressivePenalty = 1 + playerFactor * 0.35;
  const shovePenalty = 1 + playerFactor * 0.6;

  switch (option.type) {
    case 'fold':
    case 'check':
    case 'call':
      return passiveBoost;
    case 'bet':
    case 'raise':
      return Math.max(0.05, 1 / aggressivePenalty);
    case 'all-in':
      return Math.max(0.05, 1 / shovePenalty);
    default:
      return 1;
  }
}

export function selectBiasedOption(
  decision: DecisionContextView,
  session: Session,
  rng: () => number,
): PlayerOption | undefined {
  const available = decision.availableActions.filter(
    (option) => !option.disabled,
  );
  if (available.length === 0) {
    return undefined;
  }

  const activePlayers = countActivePlayers(session);
  const weights = available.map((option) =>
    weightForOption(option, activePlayers),
  );
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);

  if (totalWeight <= 0) {
    return available[0];
  }

  let threshold = rng() * totalWeight;
  for (let index = 0; index < available.length; index += 1) {
    const option = available[index]!;
    const weight = weights[index]!;
    threshold -= weight;
    if (threshold <= 0) {
      return option;
    }
  }

  return available[available.length - 1]!;
}
