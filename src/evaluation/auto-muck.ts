import type { PayoutSummary, ShowdownSummary } from '../types/snapshot';

export interface AutoMuckResult {
  readonly revealed: readonly ShowdownSummary['evaluatedHands'][number][];
  readonly hidden: readonly string[];
}

export function partitionShowdownByVisibility(
  showdown: ShowdownSummary,
  payouts: PayoutSummary | undefined,
  autoMuckPlayers: readonly string[],
): AutoMuckResult {
  const winners = new Set<string>();
  if (payouts) {
    for (const entry of payouts.entries) {
      if (entry.amount > 0) {
        winners.add(entry.playerId);
      }
    }
  }

  const autoMuckSet = new Set(autoMuckPlayers);
  const revealed: ShowdownSummary['evaluatedHands'][number][] = [];
  const hidden: string[] = [];

  for (const hand of showdown.evaluatedHands) {
    if (winners.has(hand.playerId)) {
      revealed.push(hand);
      continue;
    }

    if (autoMuckSet.has(hand.playerId)) {
      hidden.push(hand.playerId);
      continue;
    }

    revealed.push(hand);
  }

  return { revealed, hidden };
}
