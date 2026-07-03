import type {
  BettingRound,
  Chips,
  PlayerId,
  TurnEvent,
} from '../../types/index';

import { calculateRoundContributions } from '../utils/snapshot';

export interface RoundComputation {
  readonly round: BettingRound;
  readonly contributions: Map<PlayerId, Chips>;
  readonly highestContribution: Chips;
  readonly lastAggressiveRaise: Chips;
  readonly raisesThisRound: number;
  /**
   * For each player who has voluntarily acted this round (blind and ante
   * posts do not count), the table's highest contribution at the moment of
   * their most recent action. Legal-option derivation compares this against
   * the current highest contribution to decide whether betting has been
   * reopened for them: a short all-in that adds less than a full raise on
   * top of what a player already responded to leaves them call/fold only.
   */
  readonly lastActedHighestContribution: Map<PlayerId, Chips>;
}

export function deriveRoundComputation(round: BettingRound): RoundComputation {
  const contributions = calculateRoundContributions(round);
  const metrics = analyzeTurns(round.turns);

  const highestContribution = Math.max(
    round.highestBet,
    metrics.highestContribution,
  );

  return {
    round,
    contributions,
    highestContribution,
    lastAggressiveRaise: metrics.lastAggressiveRaise,
    raisesThisRound: metrics.raisesThisRound,
    lastActedHighestContribution: metrics.lastActedHighestContribution,
  };
}

interface TurnMetrics {
  readonly lastAggressiveRaise: Chips;
  readonly highestContribution: Chips;
  readonly raisesThisRound: number;
  readonly lastActedHighestContribution: Map<PlayerId, Chips>;
}

function analyzeTurns(turns: readonly TurnEvent[]): TurnMetrics {
  let runningRaiseSize = 0;
  let highestContribution = 0;
  const contributions = new Map<PlayerId, Chips>();
  const lastActedHighestContribution = new Map<PlayerId, Chips>();
  let raisesThisRound = 0;

  for (const turn of turns) {
    const prior = contributions.get(turn.actor) ?? 0;
    const updated = prior + turn.contribution;
    contributions.set(turn.actor, updated);

    const isBlindPost =
      turn.action.type === 'post-blind' || turn.action.type === 'post-ante';
    const isRaiseAction =
      turn.action.type === 'bet' ||
      turn.action.type === 'raise' ||
      (turn.action.type === 'all-in' &&
        (turn.action.from === 'bet' || turn.action.from === 'raise'));
    const increased = updated > highestContribution;

    if (increased) {
      const delta = updated - highestContribution;
      highestContribution = updated;
      // Only a full raise (an increase of at least the current running raise
      // size) advances the minimum re-raise. A short all-in that raises by less
      // than a full increment does not enlarge the minimum re-raise for later
      // actors, so it must not overwrite runningRaiseSize.
      if (!isBlindPost && delta >= runningRaiseSize) {
        runningRaiseSize = delta;
      }
    }

    if (!isBlindPost && isRaiseAction && increased) {
      raisesThisRound += 1;
    }

    // Blind and ante posts are forced wagers, not actions: the big blind
    // keeps its option even after a round of limps. Everything else,
    // including a timeout fallback, consumes the player's opportunity to
    // act on the current wagering level.
    if (!isBlindPost && turn.action.type !== 'resume') {
      lastActedHighestContribution.set(turn.actor, highestContribution);
    }
  }

  return {
    lastAggressiveRaise: runningRaiseSize,
    highestContribution,
    raisesThisRound,
    lastActedHighestContribution,
  };
}
