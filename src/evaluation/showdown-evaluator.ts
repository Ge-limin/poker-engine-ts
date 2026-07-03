import type { Card, PlayerId } from '../types/common';
import type {
  EvaluatedHand,
  ShowdownSummary,
  TableSnapshot,
} from '../types/snapshot';

type Rank =
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'T'
  | 'J'
  | 'Q'
  | 'K'
  | 'A';

type Suit = 'c' | 'd' | 'h' | 's';

interface ParsedCard {
  readonly rank: Rank;
  readonly suit: Suit;
  readonly weight: number;
  readonly face: Card;
}

interface EvaluationResult {
  readonly rankClass:
    | 'high-card'
    | 'pair'
    | 'two-pair'
    | 'three-of-a-kind'
    | 'straight'
    | 'flush'
    | 'full-house'
    | 'four-of-a-kind'
    | 'straight-flush';
  readonly primaryRanks: readonly number[];
  readonly combination: readonly ParsedCard[];
  readonly kickers: readonly ParsedCard[];
}

const RANK_ORDER: readonly Rank[] = [
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

const RANK_WEIGHTS: Readonly<Record<Rank, number>> = {
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

const CATEGORY_WEIGHTS: Readonly<
  Record<EvaluationResult['rankClass'], number>
> = {
  'high-card': 0,
  pair: 1,
  'two-pair': 2,
  'three-of-a-kind': 3,
  straight: 4,
  flush: 5,
  'full-house': 6,
  'four-of-a-kind': 7,
  'straight-flush': 8,
};

const SHOWDOWN_EVALUATOR_ID = 'engine.v0.auto-settlement';

export function evaluateShowdown(
  snapshot: TableSnapshot,
): ShowdownSummary | null {
  const board = collectBoard(snapshot);
  if (board.length < 3) {
    return null;
  }

  const contenders = collectEligiblePlayers(snapshot);
  if (contenders.size === 0) {
    return null;
  }

  const evaluations: EvaluatedHand[] = [];
  for (const playerId of contenders) {
    const holeCards = snapshot.cards.holeCards[playerId];
    if (!holeCards || holeCards.length === 0) {
      continue;
    }

    const parsedHole = holeCards
      .filter((card): card is Card => Boolean(card))
      .map(parseCard);
    if (parsedHole.length === 0) {
      continue;
    }

    const parsedBoard = board.map(parseCard);
    const evaluation = evaluateBestCombination(parsedHole, parsedBoard);
    if (!evaluation) {
      continue;
    }

    evaluations.push({
      playerId,
      rankClass: evaluation.rankClass,
      rankValue: computeRankValue(
        evaluation.rankClass,
        evaluation.primaryRanks,
      ),
      bestFive: evaluation.combination.map((card) => card.face),
      kickers: evaluation.kickers.map((card) => card.face),
    });
  }

  if (evaluations.length === 0) {
    return null;
  }

  evaluations.sort((left, right) => {
    if (left.rankValue !== right.rankValue) {
      return right.rankValue - left.rankValue;
    }
    return compareCardFaces(right.kickers, left.kickers);
  });

  return {
    evaluatedHands: evaluations,
    board,
    evaluatorId: SHOWDOWN_EVALUATOR_ID,
  } satisfies ShowdownSummary;
}

function collectBoard(snapshot: TableSnapshot): Card[] {
  const community = snapshot.cards.community;
  const board: Card[] = [];
  if (community.flop) {
    board.push(...community.flop);
  }
  if (community.turn) {
    board.push(community.turn);
  }
  if (community.river) {
    board.push(community.river);
  }
  return board;
}

function collectEligiblePlayers(snapshot: TableSnapshot): Set<PlayerId> {
  const eligible = new Set<PlayerId>();
  for (const playerId of snapshot.pots.main.eligiblePlayers) {
    eligible.add(playerId);
  }
  for (const side of snapshot.pots.sides) {
    for (const playerId of side.eligiblePlayers) {
      eligible.add(playerId);
    }
  }
  return eligible;
}

function parseCard(card: Card): ParsedCard {
  const rankCandidate = card.charAt(0);
  const suitCandidate = card.charAt(1);
  if (!isRank(rankCandidate) || !isSuit(suitCandidate)) {
    throw new Error(`Invalid card: ${card}`);
  }
  return {
    rank: rankCandidate,
    suit: suitCandidate,
    weight: RANK_WEIGHTS[rankCandidate],
    face: card,
  } satisfies ParsedCard;
}

function isRank(candidate: string): candidate is Rank {
  return (RANK_ORDER as readonly string[]).includes(candidate);
}

function isSuit(candidate: string): candidate is Suit {
  return (
    candidate === 'c' ||
    candidate === 'd' ||
    candidate === 'h' ||
    candidate === 's'
  );
}

function evaluateBestCombination(
  hole: readonly ParsedCard[],
  board: readonly ParsedCard[],
): EvaluationResult | null {
  const candidates = [...hole, ...board];
  if (candidates.length < 5) {
    return null;
  }

  let best: EvaluationResult | null = null;
  const indices = [...Array(candidates.length).keys()];

  const choose = (start: number, chosen: number[]): void => {
    if (chosen.length === 5) {
      const picked = chosen.map((index) => candidates[index]!);
      const evaluation = evaluateCombination(picked);
      if (!evaluation) {
        return;
      }
      if (!best) {
        best = evaluation;
        return;
      }
      const comparison = compareEvaluations(evaluation, best);
      if (comparison > 0) {
        best = evaluation;
      }
      return;
    }

    for (let index = start; index < indices.length; index += 1) {
      choose(index + 1, [...chosen, indices[index]!]);
    }
  };

  choose(0, []);
  return best;
}

function evaluateCombination(
  cards: readonly ParsedCard[],
): EvaluationResult | null {
  const sorted = [...cards].sort((left, right) => right.weight - left.weight);
  const counts = countRanks(sorted);
  const rankGroups = Array.from(counts.entries()).sort((left, right) => {
    if (left[1] !== right[1]) {
      return right[1] - left[1];
    }
    return RANK_WEIGHTS[right[0]] - RANK_WEIGHTS[left[0]];
  });

  const flushSuit = detectFlush(sorted);
  const straightHigh = detectStraight(sorted);

  if (flushSuit) {
    const flushCards = sorted.filter((card) => card.suit === flushSuit);
    const straightFlushHigh = detectStraight(flushCards);
    if (straightFlushHigh !== null) {
      const combination = selectStraightCombination(
        flushCards,
        straightFlushHigh,
      );
      return {
        rankClass: 'straight-flush',
        primaryRanks: [straightFlushHigh],
        combination,
        kickers: [],
      } satisfies EvaluationResult;
    }
  }

  const quad = rankGroups.find((entry) => entry[1] === 4);
  if (quad) {
    const quadRank = RANK_WEIGHTS[quad[0]];
    const remainder = sorted.filter((card) => card.rank !== quad[0]);
    const kicker = remainder[0];
    const combination = [...sorted]
      .filter((card) => card.rank === quad[0])
      .concat(kicker ? [kicker] : [])
      .slice(0, 5);
    return {
      rankClass: 'four-of-a-kind',
      primaryRanks: [quadRank, kicker?.weight ?? 0],
      combination,
      kickers: kicker ? [kicker] : [],
    } satisfies EvaluationResult;
  }

  const triple = rankGroups.find((entry) => entry[1] === 3);
  const pair = rankGroups.find(
    (entry) => entry[1] === 2 && entry[0] !== triple?.[0],
  );
  if (triple && pair) {
    const tripCards = sorted
      .filter((card) => card.rank === triple[0])
      .slice(0, 3);
    const pairCards = sorted
      .filter((card) => card.rank === pair[0])
      .slice(0, 2);
    return {
      rankClass: 'full-house',
      primaryRanks: [RANK_WEIGHTS[triple[0]], RANK_WEIGHTS[pair[0]]],
      combination: [...tripCards, ...pairCards],
      kickers: [],
    } satisfies EvaluationResult;
  }

  if (flushSuit) {
    const flushCards = sorted
      .filter((card) => card.suit === flushSuit)
      .slice(0, 5);
    return {
      rankClass: 'flush',
      primaryRanks: flushCards.map((card) => card.weight),
      combination: flushCards,
      kickers: [],
    } satisfies EvaluationResult;
  }

  if (straightHigh !== null) {
    const straightCards = selectStraightCombination(sorted, straightHigh);
    return {
      rankClass: 'straight',
      primaryRanks: [straightHigh],
      combination: straightCards,
      kickers: [],
    } satisfies EvaluationResult;
  }

  if (triple) {
    const tripRank = triple[0];
    const tripCards = sorted
      .filter((card) => card.rank === tripRank)
      .slice(0, 3);
    const kickers = sorted.filter((card) => card.rank !== tripRank).slice(0, 2);
    return {
      rankClass: 'three-of-a-kind',
      primaryRanks: [
        RANK_WEIGHTS[tripRank],
        ...kickers.map((card) => card.weight),
      ],
      combination: [...tripCards, ...kickers],
      kickers,
    } satisfies EvaluationResult;
  }

  const pairs = rankGroups.filter((entry) => entry[1] === 2);
  if (pairs.length >= 2) {
    const [highPair, lowPair] = pairs
      .slice(0, 2)
      .sort((left, right) => RANK_WEIGHTS[right[0]] - RANK_WEIGHTS[left[0]]);
    if (!highPair || !lowPair) {
      return null;
    }
    const remaining = sorted.filter(
      (card) => card.rank !== highPair[0] && card.rank !== lowPair[0],
    );
    const kicker = remaining[0];
    const combination = [
      ...sorted.filter((card) => card.rank === highPair[0]).slice(0, 2),
      ...sorted.filter((card) => card.rank === lowPair[0]).slice(0, 2),
      ...(kicker ? [kicker] : []),
    ].slice(0, 5);
    return {
      rankClass: 'two-pair',
      primaryRanks: [
        RANK_WEIGHTS[highPair[0]],
        RANK_WEIGHTS[lowPair[0]],
        kicker?.weight ?? 0,
      ],
      combination,
      kickers: kicker ? [kicker] : [],
    } satisfies EvaluationResult;
  }

  if (pairs.length === 1) {
    const [pairEntry] = pairs;
    if (!pairEntry) {
      return null;
    }
    const pairCards = sorted
      .filter((card) => card.rank === pairEntry[0])
      .slice(0, 2);
    const remaining = sorted
      .filter((card) => card.rank !== pairEntry[0])
      .slice(0, 3);
    const combination = [...pairCards, ...remaining];
    return {
      rankClass: 'pair',
      primaryRanks: [
        RANK_WEIGHTS[pairEntry[0]],
        ...remaining.map((card) => card.weight),
      ],
      combination,
      kickers: remaining,
    } satisfies EvaluationResult;
  }

  const highCards = sorted.slice(0, 5);
  return {
    rankClass: 'high-card',
    primaryRanks: highCards.map((card) => card.weight),
    combination: highCards,
    kickers: highCards.slice(1),
  } satisfies EvaluationResult;
}

function countRanks(cards: readonly ParsedCard[]): Map<Rank, number> {
  const counts = new Map<Rank, number>();
  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  }
  return counts;
}

function detectFlush(cards: readonly ParsedCard[]): Suit | null {
  const suitCounts = new Map<Suit, number>();
  for (const card of cards) {
    suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1);
  }
  for (const [suit, count] of suitCounts) {
    if (count >= 5) {
      return suit;
    }
  }
  return null;
}

function detectStraight(cards: readonly ParsedCard[]): number | null {
  const distinct = Array.from(new Set(cards.map((card) => card.weight))).sort(
    (left, right) => right - left,
  );
  if (distinct.length < 5) {
    return null;
  }

  for (let index = 0; index <= distinct.length - 5; index += 1) {
    const slice = distinct.slice(index, index + 5);
    if (isSequential(slice)) {
      return slice[0]!;
    }
  }

  const hasWheel =
    distinct.includes(14) &&
    [2, 3, 4, 5].every((rank) => distinct.includes(rank));
  if (hasWheel) {
    return 5;
  }

  return null;
}

function isSequential(ranks: readonly number[]): boolean {
  for (let index = 1; index < ranks.length; index += 1) {
    if (ranks[index - 1]! - ranks[index]! !== 1) {
      return false;
    }
  }
  return true;
}

function selectStraightCombination(
  cards: readonly ParsedCard[],
  straightHigh: number,
): ParsedCard[] {
  const straightCards = selectStraightCards(cards, straightHigh);
  if (straightCards.length === 5) {
    return straightCards;
  }
  return cards.slice(0, 5);
}

function selectStraightCards(
  cards: readonly ParsedCard[],
  straightHigh: number,
): ParsedCard[] {
  const uniqueByRank = new Map<number, ParsedCard>();
  for (const card of cards) {
    if (!uniqueByRank.has(card.weight)) {
      uniqueByRank.set(card.weight, card);
    }
  }

  if (straightHigh === 5 && uniqueByRank.has(14)) {
    const needed = [5, 4, 3, 2, 14];
    return needed
      .map((weight) => uniqueByRank.get(weight))
      .filter((card): card is ParsedCard => Boolean(card));
  }

  const collected: ParsedCard[] = [];
  for (let weight = straightHigh; weight > straightHigh - 5; weight -= 1) {
    const card = uniqueByRank.get(weight);
    if (!card) {
      return [];
    }
    collected.push(card);
  }
  return collected;
}

function compareEvaluations(
  left: EvaluationResult,
  right: EvaluationResult,
): number {
  if (left.rankClass !== right.rankClass) {
    const leftCategory = CATEGORY_WEIGHTS[left.rankClass];
    const rightCategory = CATEGORY_WEIGHTS[right.rankClass];
    return leftCategory > rightCategory ? 1 : -1;
  }

  for (
    let index = 0;
    index < Math.max(left.primaryRanks.length, right.primaryRanks.length);
    index += 1
  ) {
    const leftValue = left.primaryRanks[index] ?? 0;
    const rightValue = right.primaryRanks[index] ?? 0;
    if (leftValue === rightValue) {
      continue;
    }
    return leftValue > rightValue ? 1 : -1;
  }

  return compareCardFaces(
    left.kickers.map((card) => card.face),
    right.kickers.map((card) => card.face),
  );
}

function compareCardFaces(
  left: readonly Card[],
  right: readonly Card[],
): number {
  const toWeights = (cards: readonly Card[]) =>
    cards.map((card) => RANK_WEIGHTS[card[0] as Rank] ?? 0);
  const leftWeights = toWeights(left);
  const rightWeights = toWeights(right);
  for (
    let index = 0;
    index < Math.max(leftWeights.length, rightWeights.length);
    index += 1
  ) {
    const leftValue = leftWeights[index] ?? 0;
    const rightValue = rightWeights[index] ?? 0;
    if (leftValue === rightValue) {
      continue;
    }
    return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

function computeRankValue(
  rankClass: EvaluationResult['rankClass'],
  primaryRanks: readonly number[],
): number {
  const base = CATEGORY_WEIGHTS[rankClass] ?? 0;
  const encoded = primaryRanks.reduce(
    (accumulator, value) => accumulator * 15 + value,
    0,
  );
  return base * 1_000_000 + encoded;
}
