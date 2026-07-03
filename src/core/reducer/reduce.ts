import { ReducerInvariantError } from '../errors';
import { rebuildPotLedger } from './pot-ledger';
import {
  calculateHandContributions,
  calculateRoundContributions,
  collectFoldedPlayers,
  findSeatByPlayerId,
} from '../utils/snapshot';
import type {
  ActionClock,
  BettingRound,
  Card,
  CardLedger,
  CardRevealMetadata,
  Chips,
  CommunityBoard,
  HandFlags,
  HandLedger,
  HandStage,
  PayoutSummary,
  PlayerId,
  PotLedger,
  Seat,
  SeatingChart,
  TableSnapshot,
  TurnEvent,
} from '../../types/index';

export function reduce(
  snapshot: TableSnapshot,
  event: TurnEvent,
): TableSnapshot {
  const seatLookup = findSeatByPlayerId(snapshot.seating, event.actor);
  if (!seatLookup) {
    throw new ReducerInvariantError('Actor not seated', {
      actor: event.actor,
    });
  }

  if (seatLookup.seat.stack !== event.stackBefore) {
    throw new ReducerInvariantError('Event stackBefore mismatch', {
      actor: event.actor,
      expected: seatLookup.seat.stack,
      received: event.stackBefore,
    });
  }

  const roundIndex = snapshot.hand.bettingRounds.length - 1;
  if (roundIndex < 0) {
    throw new ReducerInvariantError('No betting rounds available', {});
  }

  const currentRound = snapshot.hand.bettingRounds[roundIndex]!;
  const roundContributionsBefore = calculateRoundContributions(currentRound);
  const actorContributionBefore =
    roundContributionsBefore.get(event.actor) ?? 0;
  const actorContributionAfter = actorContributionBefore + event.contribution;
  const roundPot = currentRound.roundPot + event.contribution;
  const previousHighestBet = currentRound.highestBet;
  const highestBet = Math.max(previousHighestBet, actorContributionAfter);
  const isAggressive = isAggressiveAction(
    event,
    actorContributionAfter,
    previousHighestBet,
  );

  const updatedRound: BettingRound = {
    ...currentRound,
    turns: [...currentRound.turns, stripCardRevealMetadata(event)],
    roundPot,
    highestBet,
    lastAggressor: isAggressive ? event.actor : currentRound.lastAggressor,
  };

  const updatedRounds = snapshot.hand.bettingRounds.slice();
  updatedRounds[roundIndex] = updatedRound;

  let hand: HandLedger = {
    ...snapshot.hand,
    bettingRounds: updatedRounds,
  };

  const updatedSeats = snapshot.seating.seats.map((seat) =>
    seat.index === seatLookup.index
      ? updateSeatStack(seat, event.stackAfter)
      : seat,
  );

  let seating: SeatingChart = {
    ...snapshot.seating,
    seats: updatedSeats,
  };

  const allInPlayers = deriveAllInPlayers(seating, event);

  const foldedPlayers = collectFoldedPlayers(hand);
  const contributions = calculateHandContributions(snapshot.pots);
  const aggregateContribution = contributions.get(event.actor) ?? 0;
  contributions.set(event.actor, aggregateContribution + event.contribution);

  let pots = rebuildPotLedger({
    contributions,
    foldedPlayers,
    previousRake: snapshot.pots.rake,
    previousSides: snapshot.pots.sides,
    allInPlayers,
  });

  const roundContributionsAfter = calculateRoundContributions(updatedRound);
  const actorsThisRound = new Set(updatedRound.turns.map((turn) => turn.actor));

  let nextActor = determineNextActor({
    round: updatedRound,
    seating,
    actorsThisRound,
    foldedPlayers,
    allInPlayers,
    roundContributions: roundContributionsAfter,
  });

  // The reducer is a pure function of (snapshot, event): every time-derived
  // value (reveal-schedule timestamps, the action-clock deadline) comes from the
  // event's own timestamp, which is persisted in the log. That is what lets
  // replayEvents rebuild byte-for-byte identical state on any machine.
  const resolvedNow = event.timestamp;

  let cards: CardLedger = snapshot.cards;
  let flags: HandFlags = snapshot.flags;

  ({ hand, seating, pots, cards, flags, nextActor } = applyEventMetadata({
    hand,
    seating,
    pots,
    cards,
    flags,
    nextActor,
    timestamp: resolvedNow,
    event,
  }));

  const clock = updateClock(snapshot.clock, nextActor, resolvedNow);

  return {
    ...snapshot,
    index: snapshot.index + 1,
    seating,
    hand,
    pots,
    cards,
    flags,
    clock,
  } satisfies TableSnapshot;
}

function updateSeatStack(seat: Seat, stackAfter: Chips): Seat {
  return {
    ...seat,
    stack: stackAfter,
  };
}

interface NextActorParams {
  readonly round: BettingRound;
  readonly seating: TableSnapshot['seating'];
  readonly actorsThisRound: Set<PlayerId>;
  readonly foldedPlayers: Set<PlayerId>;
  readonly allInPlayers: Set<PlayerId>;
  readonly roundContributions: Map<PlayerId, Chips>;
}

function determineNextActor(params: NextActorParams): PlayerId | undefined {
  const {
    round,
    seating,
    actorsThisRound,
    foldedPlayers,
    allInPlayers,
    roundContributions,
  } = params;

  const seatMap = new Map<number, Seat>();
  for (const seat of seating.seats) {
    seatMap.set(seat.index, seat);
  }

  const latestActor = round.turns.at(-1)?.actor;
  if (!latestActor) {
    return undefined;
  }

  const lastActorIndex = round.turnOrder.findIndex((seatIndex) => {
    const seat = seatMap.get(seatIndex);
    return seat?.occupant?.playerId === latestActor;
  });

  if (lastActorIndex === -1) {
    return undefined;
  }

  for (let offset = 1; offset <= round.turnOrder.length; offset += 1) {
    const seatIndex =
      round.turnOrder[(lastActorIndex + offset) % round.turnOrder.length];
    if (seatIndex === undefined) {
      continue;
    }
    const seat = seatMap.get(seatIndex);
    const playerId = seat?.occupant?.playerId;
    if (!playerId) {
      continue;
    }
    if (foldedPlayers.has(playerId)) {
      continue;
    }
    if (allInPlayers.has(playerId)) {
      continue;
    }

    const hasActed = actorsThisRound.has(playerId);
    const contribution = roundContributions.get(playerId) ?? 0;
    const owesCall = contribution < round.highestBet;

    if (!hasActed || owesCall) {
      return playerId;
    }
  }

  return undefined;
}

interface MetadataApplicationParams {
  hand: HandLedger;
  seating: SeatingChart;
  pots: PotLedger;
  cards: CardLedger;
  flags: HandFlags;
  nextActor: PlayerId | undefined;
  timestamp: number;
  event: TurnEvent;
}

interface MetadataApplicationResult {
  hand: HandLedger;
  seating: SeatingChart;
  pots: PotLedger;
  cards: CardLedger;
  flags: HandFlags;
  nextActor: PlayerId | undefined;
}

function applyEventMetadata(
  params: MetadataApplicationParams,
): MetadataApplicationResult {
  const { event, timestamp } = params;
  const metadata = event.metadata;
  if (!metadata) {
    return params;
  }

  let hand = params.hand;
  let seating = params.seating;
  let pots = params.pots;
  let cards = params.cards;
  let flags = params.flags;
  let nextActor = params.nextActor;

  if (metadata.nextHandStage) {
    hand = ensureBettingRoundForStage(hand, metadata.nextHandStage, seating);
  }

  if (metadata.cardReveals) {
    cards = applyCardReveals(cards, metadata.cardReveals, timestamp);
  }

  if (metadata.personaFlagUpdates) {
    flags = { ...flags, ...metadata.personaFlagUpdates } satisfies HandFlags;
  }

  if (metadata.nextHandStage) {
    hand = { ...hand, stage: metadata.nextHandStage } satisfies HandLedger;
  }

  if (metadata.showdownSummary) {
    hand = { ...hand, showdown: metadata.showdownSummary } satisfies HandLedger;
  }

  if (metadata.payoutSummary) {
    const settlement = applyPayoutSummary(
      metadata.payoutSummary,
      seating,
      pots,
    );
    seating = settlement.seating;
    pots = settlement.pots;
    hand = {
      ...hand,
      payouts: metadata.payoutSummary,
      stage: metadata.nextHandStage ?? 'settled',
    } satisfies HandLedger;
    flags = {
      ...flags,
      showdownLocked: true,
      pendingEliminations: collectPendingEliminations(seating.seats),
    } satisfies HandFlags;
    nextActor = undefined;
  }

  if (metadata.nextActorId) {
    nextActor = metadata.nextActorId;
  }

  return {
    hand,
    seating,
    pots,
    cards,
    flags,
    nextActor,
  } satisfies MetadataApplicationResult;
}

function ensureBettingRoundForStage(
  hand: HandLedger,
  stage: HandStage,
  seating: SeatingChart,
): HandLedger {
  if (!needsBettingRound(stage)) {
    return hand.stage === stage ? hand : { ...hand, stage };
  }

  if (hand.bettingRounds.some((round) => round.stage === stage)) {
    return hand.stage === stage ? hand : { ...hand, stage };
  }

  const turnOrder = deriveTurnOrderForStage(stage, seating, hand);
  const nextRound: BettingRound = {
    stage,
    turnOrder,
    turns: [],
    roundPot: 0,
    highestBet: 0,
  };

  return {
    ...hand,
    stage,
    bettingRounds: hand.bettingRounds.concat(nextRound),
  } satisfies HandLedger;
}

function needsBettingRound(stage: HandStage): boolean {
  return (
    stage === 'preflop' ||
    stage === 'flop' ||
    stage === 'turn' ||
    stage === 'river'
  );
}

function deriveTurnOrderForStage(
  stage: HandStage,
  seating: SeatingChart,
  hand: HandLedger,
): number[] {
  const seats = seating.seats;
  if (stage === 'preflop') {
    const bigBlindSeatIndex = seats.find(
      (seat) => seat.occupant?.playerId === hand.blinds.bigBlind.playerId,
    )?.index;
    if (bigBlindSeatIndex === undefined) {
      return seats.filter((seat) => seat.occupant).map((seat) => seat.index);
    }
    return rotateSeatIndices(seats, bigBlindSeatIndex);
  }

  const firstActorIndex = findNextOccupiedSeatIndex(seats, hand.buttonSeat);
  if (firstActorIndex === null) {
    return [];
  }
  const rotationStart = (firstActorIndex + seats.length - 1) % seats.length;
  return rotateSeatIndices(seats, rotationStart);
}

function rotateSeatIndices(
  seats: readonly Seat[],
  startIndex: number,
): number[] {
  const result: number[] = [];
  const total = seats.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const index = (startIndex + offset) % total;
    const seat = seats[index];
    if (seat?.occupant) {
      result.push(seat.index);
    }
  }
  return result;
}

function findNextOccupiedSeatIndex(
  seats: readonly Seat[],
  startIndex: number,
): number | null {
  const total = seats.length;
  if (total === 0) {
    return null;
  }
  for (let offset = 1; offset <= total; offset += 1) {
    const index = (startIndex + offset + total) % total;
    const seat = seats[index];
    if (seat?.occupant) {
      return index;
    }
  }
  return null;
}

// A snapshot's betting round records the turn as it was decided. The
// cardReveals metadata on a logged event is transport for rebuilding the
// card ledger (applyCardReveals below); inside a snapshot that information
// lives in cards.burnPile and cards.community.revealSchedule. Live sessions
// patch the logged event with reveals only after this reduction has produced
// the snapshot, so keeping reveals off the turn copy is also what makes a
// rebuilt snapshot identical to the live one.
function stripCardRevealMetadata(event: TurnEvent): TurnEvent {
  if (!event.metadata?.cardReveals) {
    return event;
  }
  const { cardReveals: _cardReveals, ...metadata } = event.metadata;
  return { ...event, metadata } satisfies TurnEvent;
}

function applyCardReveals(
  ledger: CardLedger,
  reveals: CardRevealMetadata,
  timestamp: number,
): CardLedger {
  const remainingDeck = [...ledger.remainingDeck];
  const burnPile = [...ledger.burnPile];
  let community: CommunityBoard = { ...ledger.community };
  const revealSchedule = [...ledger.community.revealSchedule];
  let holeCards: CardLedger['holeCards'] = { ...ledger.holeCards };

  if (reveals.community) {
    for (const entry of reveals.community) {
      const cards = entry.cards.slice();
      for (const card of cards) {
        removeCardFromDeck(remainingDeck, card);
      }
      const reason = entry.reason ?? 'deal';
      revealSchedule.push({
        stage: entry.stage,
        cards,
        timestamp,
        reason,
      });

      if (reason === 'burn') {
        burnPile.push(...cards);
        continue;
      }

      if (entry.stage === 'flop') {
        if (cards.length < 3) {
          throw new ReducerInvariantError('Flop reveal requires three cards', {
            cards,
          });
        }
        community = {
          ...community,
          flop: [cards[0]!, cards[1]!, cards[2]!] as readonly [
            Card,
            Card,
            Card,
          ],
        } satisfies CommunityBoard;
      } else if (entry.stage === 'turn') {
        community = { ...community, turn: cards[0]! } satisfies CommunityBoard;
      } else if (entry.stage === 'river') {
        community = { ...community, river: cards[0]! } satisfies CommunityBoard;
      }
    }
  }

  if (reveals.holeCards) {
    holeCards = { ...holeCards };
    for (const [playerId, revealed] of Object.entries(reveals.holeCards)) {
      if (!revealed) continue;
      holeCards[playerId] = revealed.slice() as readonly Card[];
      for (const card of revealed) {
        removeCardFromDeck(remainingDeck, card);
      }
    }
  }

  community = { ...community, revealSchedule } satisfies CommunityBoard;

  return {
    ...ledger,
    remainingDeck,
    burnPile,
    community,
    holeCards,
  } satisfies CardLedger;
}

function removeCardFromDeck(deck: Card[], card: Card): void {
  const index = deck.indexOf(card);
  if (index !== -1) {
    deck.splice(index, 1);
  }
}

function applyPayoutSummary(
  payout: PayoutSummary,
  seating: SeatingChart,
  pots: PotLedger,
): { seating: SeatingChart; pots: PotLedger } {
  if (payout.entries.length === 0) {
    return { seating, pots };
  }

  const awards = new Map<PlayerId, number>();
  for (const entry of payout.entries) {
    awards.set(entry.playerId, entry.amount);
  }

  const seats = seating.seats.map((seat) => {
    const occupant = seat.occupant;
    if (!occupant) {
      return seat;
    }
    const award = awards.get(occupant.playerId);
    if (award === undefined) {
      return seat;
    }
    const stack = seat.stack + award;
    return {
      ...seat,
      stack,
      status: award > 0 ? 'occupied' : seat.status,
    } satisfies Seat;
  });

  const mainContributions = { ...pots.main.contributions };
  for (const key of Object.keys(mainContributions)) {
    mainContributions[key] = 0;
  }

  const sideBuckets = pots.sides.map((bucket) => {
    const contributions = { ...bucket.contributions };
    for (const key of Object.keys(contributions)) {
      contributions[key] = 0;
    }
    return {
      ...bucket,
      amount: 0,
      contributions,
    };
  });

  return {
    seating: {
      ...seating,
      seats,
    },
    pots: {
      ...pots,
      main: {
        ...pots.main,
        amount: 0,
        contributions: mainContributions,
      },
      sides: sideBuckets,
      rake: payout.rake ?? pots.rake,
    },
  };
}

function collectPendingEliminations(seats: readonly Seat[]): PlayerId[] {
  const pending = new Set<PlayerId>();
  for (const seat of seats) {
    const occupant = seat.occupant;
    if (!occupant) continue;
    if (seat.stack <= 0) {
      pending.add(occupant.playerId);
    }
  }
  return Array.from(pending);
}

function updateClock(
  clock: ActionClock,
  nextActor: PlayerId | undefined,
  timestamp: number,
): ActionClock {
  if (!nextActor) {
    return {
      ...clock,
      currentActor: undefined,
      deadline: undefined,
    };
  }

  const hasDeadline = clock.perTurnMs > 0;

  return {
    ...clock,
    currentActor: nextActor,
    deadline: hasDeadline ? timestamp + clock.perTurnMs : undefined,
  };
}

function isAggressiveAction(
  event: TurnEvent,
  actorContributionAfter: Chips,
  previousHighestBet: Chips,
): boolean {
  if (event.action.type === 'bet' || event.action.type === 'raise') {
    return true;
  }

  if (event.action.type === 'all-in') {
    return actorContributionAfter > previousHighestBet;
  }

  return false;
}

function deriveAllInPlayers(
  seating: TableSnapshot['seating'],
  event: TurnEvent,
): Set<PlayerId> {
  const result = new Set<PlayerId>();

  for (const seat of seating.seats) {
    if (seat.occupant && seat.stack === 0) {
      result.add(seat.occupant.playerId);
    }
  }

  const eventSignalsAllIn =
    event.stackAfter === 0 ||
    event.action.type === 'all-in' ||
    (event.action.type === 'call' && Boolean(event.action.isAllIn)) ||
    (event.action.type === 'bet' && Boolean(event.action.isAllIn)) ||
    (event.action.type === 'raise' && Boolean(event.action.isAllIn));

  if (eventSignalsAllIn) {
    result.add(event.actor);
  }

  return result;
}
