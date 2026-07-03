import type {
  Chips,
  PlayerId,
  PotBucket,
  PotLedger,
} from '../../types/index';

import { requireIntegerChips, sumChips } from '../chips';

export interface PotLedgerOptions {
  readonly contributions: Map<PlayerId, Chips>;
  readonly foldedPlayers: Set<PlayerId>;
  readonly allInPlayers?: Set<PlayerId>;
  readonly previousRake?: Chips;
  readonly previousSides?: readonly PotBucket[];
}

export function rebuildPotLedger(options: PotLedgerOptions): PotLedger {
  const {
    contributions,
    foldedPlayers,
    previousRake,
    allInPlayers,
    previousSides,
  } = options;
  const normalizedRake =
    previousRake === undefined
      ? 0
      : requireIntegerChips(previousRake, 'previous rake');
  const working = new Map<PlayerId, Chips>();

  for (const [playerId, amount] of contributions.entries()) {
    const normalizedAmount = requireIntegerChips(
      amount,
      `contribution for ${playerId}`,
    );
    if (normalizedAmount > 0) {
      working.set(playerId, normalizedAmount);
    }
  }

  const shouldSimplify =
    (!allInPlayers || allInPlayers.size === 0) &&
    (!previousSides || previousSides.length === 0);

  if (shouldSimplify) {
    let total: Chips = 0;
    for (const amount of working.values()) {
      total = sumChips(total, amount, 'pot total');
    }
    const eligiblePlayers = Array.from(working.keys())
      .filter((playerId) => !foldedPlayers.has(playerId))
      .sort();

    return {
      main: {
        id: 'pot-main-0',
        amount: total,
        eligiblePlayers,
        contributions: Object.fromEntries(working) as Record<PlayerId, Chips>,
      },
      sides: [],
      rake: normalizedRake,
    } satisfies PotLedger;
  }

  const buckets: PotBucket[] = [];
  let bucketIndex = 0;
  const allPlayers = Array.from(working.keys());

  while (true) {
    const participants = Array.from(working.entries()).filter(
      ([, amount]) => amount > 0,
    );
    if (participants.length === 0) {
      break;
    }

    const firstContribution = participants[0]?.[1];
    if (firstContribution === undefined) {
      break;
    }

    let minContribution = firstContribution;
    for (const [, amount] of participants) {
      if (amount < minContribution) {
        minContribution = amount;
      }
    }

    const minContributionInt = requireIntegerChips(
      minContribution,
      'minimum contribution',
    );

    if (minContributionInt <= 0) {
      break;
    }

    const contributionsRecord: Record<PlayerId, Chips> = {};
    for (const playerId of allPlayers) {
      contributionsRecord[playerId] = 0;
    }
    let potAmount: Chips = 0;

    for (const [playerId, amount] of participants) {
      const nextContribution =
        (contributionsRecord[playerId] ?? 0) + minContributionInt;
      contributionsRecord[playerId] = requireIntegerChips(
        nextContribution,
        `bucket contribution for ${playerId}`,
      );

      potAmount = sumChips(potAmount, minContributionInt, 'bucket amount');

      const remaining = amount - minContributionInt;
      if (remaining < 0) {
        throw new Error(
          `Invalid contribution state: ${playerId} underflowed chips`,
        );
      }
      const normalizedRemaining = requireIntegerChips(
        remaining,
        `remaining contribution for ${playerId}`,
      );
      working.set(playerId, normalizedRemaining);
    }

    const eligiblePlayers = participants
      .map(([playerId]) => playerId)
      .filter((playerId) => !foldedPlayers.has(playerId))
      .sort();

    const bucket: PotBucket = {
      id: bucketIndex === 0 ? 'pot-main-0' : `pot-side-${bucketIndex}`,
      amount: potAmount,
      eligiblePlayers,
      contributions: contributionsRecord,
    };

    buckets.push(bucket);
    bucketIndex += 1;
  }

  if (buckets.length === 0) {
    buckets.push({
      id: 'pot-main-0',
      amount: 0,
      eligiblePlayers: [],
      contributions: {},
    });
  }

  const [main, ...sides] = buckets as [PotBucket, ...PotBucket[]];

  return {
    main,
    sides,
    rake: normalizedRake,
  } satisfies PotLedger;
}
