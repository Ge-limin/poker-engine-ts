import { requireIntegerChips } from '../core/chips';
import type { Card, CardRank } from '../types/common';
import type {
  PayoutEntry,
  PayoutSummary,
  PotBucket,
  SeatingChart,
  ShowdownSummary,
  TableSnapshot,
} from '../types/snapshot';

type EvaluationMap = Record<string, ShowdownSummary['evaluatedHands'][number]>;

export function settlePots(
  snapshot: TableSnapshot,
  summary: ShowdownSummary,
): PayoutSummary {
  const evaluations = mapEvaluations(summary);
  const payoutAccumulator = new Map<
    string,
    { amount: number; potIds: Set<string> }
  >();

  const buckets: PotBucket[] = [snapshot.pots.main, ...snapshot.pots.sides];

  for (const bucket of buckets) {
    const bucketAmount = requireIntegerChips(
      bucket.amount,
      `pot ${bucket.id} amount`,
    );
    if (bucketAmount <= 0) continue;

    const contenders = bucket.eligiblePlayers.filter(
      (playerId) => playerId in evaluations,
    );
    if (contenders.length === 0) {
      // No eligible contender reached showdown for this pot, so its chips were
      // never contested by a live player (an uncalled bet whose contributor
      // then folded). Return them to whoever put them in rather than dropping
      // them, so chips are conserved.
      refundBucketToContributors(payoutAccumulator, bucket);
      continue;
    }

    const winners = determineWinners(contenders, evaluations);
    if (winners.length === 0) {
      // Unreachable: contenders are pre-filtered to those with an evaluated
      // hand, so a non-empty contender set always yields at least one winner.
      // Fail loudly rather than silently dropping this bucket's chips.
      throw new Error(
        `settlePots: pot ${bucket.id} has evaluated contenders but no winner`,
      );
    }

    const baseShare = Math.trunc(bucketAmount / winners.length);
    const normalizedBaseShare = requireIntegerChips(
      baseShare,
      `base share for pot ${bucket.id}`,
    );
    const remainder = requireIntegerChips(
      bucketAmount - normalizedBaseShare * winners.length,
      `remainder for pot ${bucket.id}`,
    );

    for (const winner of winners) {
      incrementPayout(
        payoutAccumulator,
        winner,
        normalizedBaseShare,
        bucket.id,
      );
    }

    if (remainder > 0) {
      // Odd chips go to the first winner clockwise from the button. Fall back
      // to the raw winner list if none map to a seat, so a remainder is never
      // dropped.
      const ordered = orderWinnersByPosition(snapshot.seating, winners);
      const recipients = ordered.length > 0 ? ordered : winners;
      for (let index = 0; index < remainder; index += 1) {
        const recipient = recipients[index % recipients.length]!;
        incrementPayout(payoutAccumulator, recipient, 1, bucket.id);
      }
    }
  }

  const entries: PayoutEntry[] = Array.from(payoutAccumulator.entries()).map(
    ([playerId, payload]) => ({
      playerId,
      amount: requireIntegerChips(payload.amount, `payout for ${playerId}`),
      potIds: Array.from(payload.potIds),
    }),
  );

  entries.sort((left, right) => left.playerId.localeCompare(right.playerId));

  return {
    entries,
    rake: requireIntegerChips(snapshot.pots.rake, 'pot rake'),
  };
}

function mapEvaluations(summary: ShowdownSummary): EvaluationMap {
  const map: EvaluationMap = {};
  for (const hand of summary.evaluatedHands) {
    map[hand.playerId] = hand;
  }
  return map;
}

function determineWinners(
  contenders: readonly string[],
  evaluations: EvaluationMap,
): string[] {
  let best: ShowdownSummary['evaluatedHands'][number] | undefined;
  const winners: string[] = [];

  for (const playerId of contenders) {
    const evaluation = evaluations[playerId];
    if (!evaluation) continue;

    if (!best) {
      best = evaluation;
      winners.push(playerId);
      continue;
    }

    const comparison = compareEvaluations(evaluation, best);
    if (comparison > 0) {
      winners.length = 0;
      winners.push(playerId);
      best = evaluation;
    } else if (comparison === 0) {
      winners.push(playerId);
    }
  }

  return winners;
}

function compareEvaluations(
  left: ShowdownSummary['evaluatedHands'][number],
  right: ShowdownSummary['evaluatedHands'][number],
): number {
  if (left.rankValue !== right.rankValue) {
    return left.rankValue > right.rankValue ? 1 : -1;
  }

  const leftKickers = toRankSequence(left.kickers);
  const rightKickers = toRankSequence(right.kickers);
  const length = Math.max(leftKickers.length, rightKickers.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftKickers[index] ?? 0;
    const rightValue = rightKickers[index] ?? 0;
    if (leftValue === rightValue) continue;
    return leftValue > rightValue ? 1 : -1;
  }

  return 0;
}

function toRankSequence(cards: readonly Card[]): number[] {
  return cards.map((card) => rankWeight(card[0] as CardRank));
}

const rankWeights: Record<CardRank, number> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

function rankWeight(rank: CardRank): number {
  return rankWeights[rank];
}

function refundBucketToContributors(
  accumulator: Map<string, { amount: number; potIds: Set<string> }>,
  bucket: PotBucket,
): void {
  for (const [playerId, amount] of Object.entries(bucket.contributions)) {
    const normalized = requireIntegerChips(amount, `refund for ${playerId}`);
    if (normalized > 0) {
      incrementPayout(accumulator, playerId, normalized, bucket.id);
    }
  }
}

function incrementPayout(
  accumulator: Map<string, { amount: number; potIds: Set<string> }>,
  playerId: string,
  amount: number,
  potId: string,
): void {
  const normalizedAmount = requireIntegerChips(
    amount,
    `payout increment for ${playerId}`,
  );
  if (normalizedAmount <= 0) return;
  const existing = accumulator.get(playerId);
  if (existing) {
    existing.amount = requireIntegerChips(
      existing.amount + normalizedAmount,
      `payout total for ${playerId}`,
    );
    existing.potIds.add(potId);
    return;
  }

  accumulator.set(playerId, {
    amount: normalizedAmount,
    potIds: new Set([potId]),
  });
}

function orderWinnersByPosition(
  seating: SeatingChart,
  winners: readonly string[],
): string[] {
  if (winners.length === 0) {
    return [];
  }

  const winnerSet = new Set(winners);
  const ordered: string[] = [];
  const seatCount = seating.seats.length;
  const start = seating.dealerButton;

  for (let offset = 1; offset <= seatCount; offset += 1) {
    const index = (start + offset) % seatCount;
    const seat = seating.seats[index];
    if (seat?.occupant && winnerSet.has(seat.occupant.playerId)) {
      ordered.push(seat.occupant.playerId);
    }
  }

  for (const winner of winners) {
    if (!winnerSet.has(winner)) continue;
    if (!ordered.includes(winner)) {
      ordered.push(winner);
    }
  }

  return ordered;
}
