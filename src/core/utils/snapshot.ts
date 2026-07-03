import type {
  BettingRound,
  Chips,
  HandLedger,
  PlayerId,
  PotBucket,
  PotLedger,
  Seat,
  SeatIndex,
  SeatingChart,
  TableSnapshot,
  TurnEvent,
} from '../../types/index';

/**
 * Describes a seat located by player identifier within a seating chart.
 * @property seat The full seat record containing occupant and stack information.
 * @property index The zero-based position of the seat within the seating chart.
 */
export interface SeatLookupEntry {
  readonly seat: Seat;
  readonly index: SeatIndex;
}

/**
 * Finds the seat occupied by a specific player within the seating chart.
 * @param seating Table seating arrangement containing the available seats.
 * @param playerId Identifier of the player whose seat should be located.
 * @returns A lookup entry with the seat and its index, or undefined if the player is not seated.
 */
export function findSeatByPlayerId(
  seating: SeatingChart,
  playerId: PlayerId,
): SeatLookupEntry | undefined {
  for (const seat of seating.seats) {
    if (seat.occupant?.playerId === playerId) {
      return { seat, index: seat.index };
    }
  }

  return undefined;
}

/**
 * Aggregates chip contributions for a betting round, grouped by acting player.
 * @param round The betting round whose turns should be totaled.
 * @returns A map keyed by player identifier with the chips each player contributed during the round.
 */
export function calculateRoundContributions(
  round: BettingRound,
): Map<PlayerId, Chips> {
  const result = new Map<PlayerId, Chips>();

  for (const turn of round.turns) {
    const previous = result.get(turn.actor) ?? 0;
    result.set(turn.actor, previous + turn.contribution);
  }

  return result;
}

/**
 * Aggregates chip contributions across the entire hand, including main and side pots.
 * @param ledger Ledger describing the current pot state for the hand.
 * @returns A map of each player's cumulative contributions for the hand.
 */
export function calculateHandContributions(
  ledger: PotLedger,
): Map<PlayerId, Chips> {
  const result = new Map<PlayerId, Chips>();

  aggregateBucket(result, ledger.main);
  for (const bucket of ledger.sides) {
    aggregateBucket(result, bucket);
  }

  return result;
}

/**
 * Adds all contributions from a pot bucket into an aggregate contribution map.
 * @param target Running contribution totals keyed by player identifier.
 * @param bucket Pot bucket whose contributions should be merged into the target map.
 */
function aggregateBucket(
  target: Map<PlayerId, Chips>,
  bucket: PotBucket,
): void {
  for (const [playerId, amount] of Object.entries(bucket.contributions)) {
    const running = target.get(playerId) ?? 0;
    target.set(playerId, running + amount);
  }
}

/**
 * Collects identifiers for every player who folded or timed out to a fold during the hand.
 * @param hand Ledger describing the sequence of betting rounds and turns for the hand.
 * @returns A set of player identifiers who are no longer active because they folded.
 */
export function collectFoldedPlayers(hand: HandLedger): Set<PlayerId> {
  const folded = new Set<PlayerId>();

  for (const round of hand.bettingRounds) {
    for (const turn of round.turns) {
      if (turn.action.type === 'fold') {
        folded.add(turn.actor);
      }
      if (turn.action.type === 'timeout' && turn.action.fallback === 'fold') {
        folded.add(turn.actor);
      }
    }
  }

  return folded;
}

/**
 * Determines which players are all-in based on the latest snapshot and optional recent event.
 * @param snapshot Current table snapshot containing seating and stack information.
 * @param recentEvent Optional most recent turn event to capture just-occurred all-in actions.
 * @returns A set of player identifiers whose stacks are fully committed.
 */
export function collectAllInPlayers(
  snapshot: TableSnapshot,
  recentEvent?: TurnEvent,
): Set<PlayerId> {
  const allIn = new Set<PlayerId>();

  for (const seat of snapshot.seating.seats) {
    if (seat.occupant && seat.stack === 0) {
      allIn.add(seat.occupant.playerId);
    }
  }

  if (recentEvent) {
    const { action, stackAfter } = recentEvent;
    if (stackAfter === 0) {
      allIn.add(recentEvent.actor);
    }
    if (action.type === 'all-in') {
      allIn.add(recentEvent.actor);
    }

    if (
      (action.type === 'call' ||
        action.type === 'bet' ||
        action.type === 'raise') &&
      Boolean(action.isAllIn)
    ) {
      allIn.add(recentEvent.actor);
    }
  }

  return allIn;
}

/**
 * Sums all chip amounts held in the main and side pots.
 * @param ledger Ledger capturing the current state of the main and side pots.
 * @returns The total chips currently in play across all pots, including rake.
 */
export function sumPotAmounts(ledger: PotLedger): Chips {
  let total = ledger.main.amount + ledger.rake;
  for (const side of ledger.sides) {
    total += side.amount;
  }
  return total;
}

/**
 * Resolves the acting player sequence for a betting round based on the seating arrangement.
 * @param round Betting round containing the order of seat indices that should act.
 * @param seating Seating chart that maps seat indices to occupying players.
 * @returns An ordered list of player identifiers for the round, excluding empty seats.
 */
export function deriveTurnOrderActors(
  round: BettingRound,
  seating: SeatingChart,
): PlayerId[] {
  const actorBySeat = new Map<SeatIndex, PlayerId>();
  for (const seat of seating.seats) {
    if (seat.occupant) {
      actorBySeat.set(seat.index, seat.occupant.playerId);
    }
  }

  return round.turnOrder
    .map((seatIndex) => actorBySeat.get(seatIndex))
    .filter((playerId): playerId is PlayerId => Boolean(playerId));
}
