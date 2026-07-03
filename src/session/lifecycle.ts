import { reduce } from '../core/reducer';
import { createPersonaProfile } from '../persona/baseline';
import type {
  Card,
  HandStage,
  PlayerId,
  Timestamp,
  UUID,
} from '../types/common';
import type { TurnEvent } from '../types/events';
import type { PersonaMatrix, PersonaProfile } from '../types/persona';
import type {
  AdvisorBridge,
  AnalyticsEndpoint,
  EngineHooks,
  PersonaPolicy,
  RuntimeContext,
  Session,
  SessionChannels,
  SessionConfig,
  SessionMetrics,
} from '../types/session';
import type {
  ActionClock,
  BettingRound,
  CardLedger,
  CommunityBoard,
  HandFlags,
  HandLedger,
  PotLedger,
  Seat,
  SeatStatus,
  TableSnapshot,
} from '../types/snapshot';
import { createDeterministicHandId } from './hand-id';

export interface SeatBootstrapConfig {
  readonly playerId: PlayerId;
  readonly stack: number;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly personaId?: string;
  readonly seatIndex?: number;
  readonly status?: SeatStatus;
  readonly rebuyTokens?: number;
}

export interface SessionBootstrapOptions {
  readonly sessionId?: UUID;
  readonly runtimeContext?: RuntimeContext;
  readonly timestamp?: Timestamp;
  readonly buttonIndex?: number;
  readonly perTurnMs?: number;
  readonly deck?: readonly Card[];
  readonly deckSeed?: string;
  readonly personaSubstitutions?: Record<PlayerId, PersonaProfile['style']>;
  readonly channels?: Partial<SessionChannels>;
  readonly hooks?: EngineHooks;
}

export interface DealResult {
  readonly session: Session;
  readonly dealtCards: readonly Card[];
}

export interface HandResetOptions {
  readonly deck?: readonly Card[];
  readonly deckSeed?: string;
  readonly timestamp?: Timestamp;
}

export function bootstrapSession(
  config: SessionConfig,
  seatsConfig: readonly SeatBootstrapConfig[],
  options: SessionBootstrapOptions = {},
): Session {
  const sessionId = options.sessionId ?? 'session-1';
  const timestamp = options.timestamp ?? Date.now();
  const runtimeContext: RuntimeContext = options.runtimeContext ?? {
    mode: 'live',
  };

  const seats = buildSeats(config.maxSeats, seatsConfig);
  const buttonIndex = resolveButtonIndex(options.buttonIndex, seats);
  const blindLevel = config.blindSchedule[0] ?? {
    level: 1,
    smallBlind: 0,
    bigBlind: 0,
  };
  const firstHandNumber = 1;
  const firstSnapshotVersion = 0;
  const hand: HandLedger = buildHandLedger(
    sessionId,
    firstHandNumber,
    config,
    seats,
    buttonIndex,
    blindLevel.smallBlind,
    blindLevel.bigBlind,
    options.deckSeed ?? 'deck-seed-1',
  );

  const personas = buildPersonaMatrix(
    config.personaPolicy,
    seats,
    timestamp,
    options.personaSubstitutions,
  );

  const deck = [...(options.deck ?? [])];
  const cards: CardLedger = {
    remainingDeck: deck,
    burnPile: [],
    community: createEmptyCommunityBoard(),
    holeCards: createEmptyHoleCards(seats),
  };

  const potLedger = buildInitialPots(seats);
  const flags = createInitialFlags();

  const withAntes = applyAntes(seats, potLedger, hand, flags);
  const withBlinds = applyBlinds(
    withAntes.seats,
    withAntes.pots,
    hand,
    withAntes.flags,
  );

  const bettingRound = createInitialBettingRound(
    hand,
    withBlinds.seats,
    withBlinds.pots,
  );
  const updatedHand: HandLedger = {
    ...hand,
    bettingRounds: [bettingRound],
  };

  const clock = createActionClock(
    withBlinds.seats,
    updatedHand,
    options.perTurnMs,
    timestamp,
  );

  const snapshot: TableSnapshot = {
    index: firstSnapshotVersion,
    handNumber: firstHandNumber,
    seating: { dealerButton: updatedHand.buttonSeat, seats: withBlinds.seats },
    hand: updatedHand,
    pots: withBlinds.pots,
    cards,
    personas,
    clock,
    flags: withBlinds.flags,
  };

  const initialSnapshot = cloneSnapshot(snapshot);

  const session: Session = {
    id: sessionId,
    config,
    runtimeContext,
    initialSnapshot,
    events: [],
    activeSnapshot: snapshot,
    metrics: createInitialMetrics(),
    channels: resolveChannels(sessionId, options.channels),
    hooks: options.hooks ?? {},
  };

  return session;
}

export function applyTurnEvent(session: Session, event: TurnEvent): Session {
  const reduced = reduce(session.activeSnapshot, event);
  return {
    ...session,
    events: session.events.concat(event),
    activeSnapshot: reduced,
  };
}

export function replayEvents(
  initialSnapshot: TableSnapshot,
  events: readonly TurnEvent[],
): TableSnapshot {
  let snapshot = cloneSnapshot(initialSnapshot);
  for (const event of events) {
    snapshot = reduce(snapshot, event);
  }
  return snapshot;
}

type SeatTransitionOptions =
  | {
      readonly occupant?: Seat['occupant'];
      readonly stack?: number;
      readonly rebuyTokens?: number;
    }
  | Seat['occupant'];

function resolveSeatTransitionOptions(options?: SeatTransitionOptions): {
  readonly occupant?: Seat['occupant'];
  readonly stack?: number;
  readonly rebuyTokens?: number;
} {
  if (!options) return {};
  if ('playerId' in options) {
    return { occupant: options };
  }
  return options;
}

export function transitionSeat(
  session: Session,
  seatIndex: number,
  status: SeatStatus,
  options?: SeatTransitionOptions,
): Session {
  const { occupant, stack, rebuyTokens } =
    resolveSeatTransitionOptions(options);
  const seats = session.activeSnapshot.seating.seats.map((seat) => {
    if (seat.index !== seatIndex) return seat;
    if (status === 'open') {
      return {
        index: seat.index,
        status,
        stack: 0,
      };
    }
    return {
      ...seat,
      status,
      occupant: occupant ?? seat.occupant,
      stack: stack ?? seat.stack,
      rebuyTokens: rebuyTokens ?? seat.rebuyTokens,
    };
  });

  const snapshot: TableSnapshot = {
    ...session.activeSnapshot,
    seating: { ...session.activeSnapshot.seating, seats },
  };

  return { ...session, activeSnapshot: snapshot };
}

export function dealHoleCards(
  session: Session,
  playerOrder: readonly PlayerId[],
): DealResult {
  const snapshot = session.activeSnapshot;
  const deck = [...snapshot.cards.remainingDeck];
  const holeCards = { ...snapshot.cards.holeCards };
  const dealt: Card[] = [];
  const cardsPerPlayer = Math.max(
    0,
    session.config.ruleSet.cardDistribution.holeCardsPerPlayer ?? 0,
  );

  for (const playerId of playerOrder) {
    if (cardsPerPlayer === 0) {
      holeCards[playerId] = [];
      continue;
    }

    const playerCards: Card[] = [];
    for (let index = 0; index < cardsPerPlayer; index += 1) {
      const card = deck.shift();
      if (!card) {
        throw new Error('Insufficient cards remaining to complete deal');
      }
      playerCards.push(card);
    }
    holeCards[playerId] = playerCards as readonly Card[];
    dealt.push(...playerCards);
  }

  const cards: CardLedger = {
    ...snapshot.cards,
    remainingDeck: deck,
    holeCards,
  };

  const updatedSnapshot: TableSnapshot = {
    ...snapshot,
    cards,
  };

  return {
    session: { ...session, activeSnapshot: updatedSnapshot },
    dealtCards: dealt,
  };
}

export function recoverMisdeal(
  session: Session,
  dealt: readonly Card[],
): Session {
  const snapshot = session.activeSnapshot;
  const clearedHoleCards = Object.fromEntries(
    Object.keys(snapshot.cards.holeCards).map(
      (playerId) => [playerId, null] as const,
    ),
  ) as TableSnapshot['cards']['holeCards'];

  const communityDrawn = snapshot.cards.community.revealSchedule.flatMap(
    (entry) => entry.cards,
  );
  const communitySet = new Set(communityDrawn);
  const replenishedHoleCards = dealt.filter((card) => !communitySet.has(card));

  const cards: CardLedger = {
    ...snapshot.cards,
    remainingDeck: [
      ...replenishedHoleCards,
      ...communityDrawn,
      ...snapshot.cards.remainingDeck,
    ],
    burnPile: [],
    community: createEmptyCommunityBoard(),
    holeCards: clearedHoleCards,
  };

  const updatedSnapshot: TableSnapshot = {
    ...snapshot,
    cards,
  };

  return { ...session, activeSnapshot: updatedSnapshot };
}

type CommunityStage = Extract<HandStage, 'flop' | 'turn' | 'river'>;

interface CommunityDistributionParams {
  readonly ledger: CardLedger;
  readonly config: SessionConfig;
  readonly stage: CommunityStage;
  readonly timestamp: Timestamp;
  readonly expectedCards?: readonly Card[];
  readonly revealReason?: 'deal' | 'burn' | 'expose' | 'rollback';
}

interface CommunityDistributionResult {
  readonly ledger: CardLedger;
  readonly revealedCards: readonly Card[];
}

const REVEAL_STAGES: readonly CommunityStage[] = ['flop', 'turn', 'river'];

export function resolveDistributionCounts(
  config: SessionConfig,
  stage: CommunityStage,
): { burn: number; reveal: number } {
  const { cardDistribution, streets } = config.ruleSet;
  const stageIndex = streets.indexOf(stage);
  if (stageIndex === -1) {
    throw new Error(`Stage ${stage} is not part of the configured rule set`);
  }

  const revealIndex = REVEAL_STAGES.indexOf(stage);
  const burnPerStreet = cardDistribution.burnPerStreet ?? [];
  const burn = (() => {
    if (burnPerStreet.length === REVEAL_STAGES.length) {
      return burnPerStreet[revealIndex] ?? 0;
    }
    if (burnPerStreet.length > stageIndex) {
      return burnPerStreet[stageIndex] ?? 0;
    }
    if (burnPerStreet.length > revealIndex) {
      return burnPerStreet[revealIndex] ?? 0;
    }
    return 0;
  })();
  const defaultReveal = stage === 'flop' ? 3 : 1;
  const communityReveal = cardDistribution.communityReveal ?? [];
  const reveal = (() => {
    if (communityReveal.length === REVEAL_STAGES.length) {
      return communityReveal[revealIndex] ?? defaultReveal;
    }
    if (communityReveal.length > stageIndex) {
      return communityReveal[stageIndex] ?? defaultReveal;
    }
    if (communityReveal.length > revealIndex) {
      return communityReveal[revealIndex] ?? defaultReveal;
    }
    return defaultReveal;
  })();

  return { burn, reveal };
}

function ensureStageAvailable(
  community: CommunityBoard,
  stage: CommunityStage,
): void {
  if (stage === 'flop' && community.flop) {
    throw new Error('Flop has already been revealed');
  }
  if (stage === 'turn' && community.turn) {
    throw new Error('Turn has already been revealed');
  }
  if (stage === 'river' && community.river) {
    throw new Error('River has already been revealed');
  }
}

function cardsMatch(
  revealed: readonly Card[],
  expected: readonly Card[] | undefined,
): boolean {
  if (!expected) {
    return true;
  }
  if (revealed.length !== expected.length) {
    return false;
  }
  for (let index = 0; index < revealed.length; index += 1) {
    if (revealed[index] !== expected[index]) {
      return false;
    }
  }
  return true;
}

export function applyCommunityDistribution(
  params: CommunityDistributionParams,
): CommunityDistributionResult {
  const { ledger, config, stage, timestamp, expectedCards } = params;
  const { burn, reveal } = resolveDistributionCounts(config, stage);
  if (reveal <= 0) {
    throw new Error(`Rule set does not define community cards for ${stage}`);
  }

  ensureStageAvailable(ledger.community, stage);

  const deck = [...ledger.remainingDeck];
  if (deck.length < burn + reveal) {
    throw new Error('Insufficient cards remaining to reveal community cards');
  }

  const burnCards: Card[] = [];
  for (let index = 0; index < burn; index += 1) {
    const burnCard = deck.shift();
    if (!burnCard) {
      throw new Error('Insufficient cards remaining to burn before reveal');
    }
    burnCards.push(burnCard);
  }

  const revealCards: Card[] = [];
  for (let index = 0; index < reveal; index += 1) {
    const card = deck.shift();
    if (!card) {
      throw new Error('Insufficient cards remaining to reveal community cards');
    }
    revealCards.push(card);
  }

  if (!cardsMatch(revealCards, expectedCards)) {
    throw new Error('Community cards must match the deck order');
  }

  const revealSchedule = [...ledger.community.revealSchedule];
  if (burnCards.length > 0) {
    revealSchedule.push({
      stage,
      cards: burnCards as readonly Card[],
      timestamp,
      reason: 'burn',
    });
  }
  revealSchedule.push({
    stage,
    cards: revealCards as readonly Card[],
    timestamp,
    reason: params.revealReason ?? 'deal',
  });

  if (revealCards.length !== reveal) {
    const expectedDescription =
      reveal === 1 ? 'a single card' : `${reveal} cards`;
    throw new Error(`${stage} reveal must expose ${expectedDescription}`);
  }

  const community: CommunityBoard = {
    ...ledger.community,
    ...(stage === 'flop'
      ? {
          flop: [
            revealCards[0]!,
            revealCards[1]!,
            revealCards[2]!,
          ] as readonly [Card, Card, Card],
        }
      : stage === 'turn'
        ? { turn: revealCards[0]! }
        : { river: revealCards[0]! }),
    revealSchedule,
  };

  return {
    ledger: {
      ...ledger,
      remainingDeck: deck,
      burnPile: ledger.burnPile.concat(burnCards),
      community,
    },
    revealedCards: revealCards as readonly Card[],
  };
}

export function revealCommunityCards(
  session: Session,
  stage: Extract<HandStage, 'flop' | 'turn' | 'river'>,
  cardsToExpose: readonly Card[],
  timestamp: Timestamp,
  reason: 'deal' | 'burn' | 'expose' | 'rollback' = 'deal',
): Session {
  const snapshot = session.activeSnapshot;
  const distribution = applyCommunityDistribution({
    ledger: snapshot.cards,
    config: session.config,
    stage,
    timestamp,
    expectedCards: cardsToExpose,
    revealReason: reason,
  });

  const updatedSnapshot: TableSnapshot = {
    ...snapshot,
    cards: distribution.ledger,
  };

  return { ...session, activeSnapshot: updatedSnapshot };
}

export function muckHand(session: Session, playerId: PlayerId): Session {
  const snapshot = session.activeSnapshot;
  const holeCards = { ...snapshot.cards.holeCards, [playerId]: null };
  const cards: CardLedger = {
    ...snapshot.cards,
    holeCards,
  };

  const updatedSnapshot: TableSnapshot = {
    ...snapshot,
    cards,
  };

  return { ...session, activeSnapshot: updatedSnapshot };
}

export function completeHand(
  session: Session,
  options: HandResetOptions = {},
): Session {
  const current = session.activeSnapshot;
  const config = session.config;
  const blindLevel = config.blindSchedule[0] ?? {
    level: 1,
    smallBlind: 0,
    bigBlind: 0,
  };

  const seats = normalizeLeavingSeats(current.seating.seats);
  const nextButton = findNextOccupiedSeatIndex(
    seats,
    current.seating.dealerButton,
  );
  const buttonSeat = nextButton ?? current.seating.dealerButton;
  const nextHandNumber = current.handNumber + 1;

  const hand: HandLedger = buildHandLedger(
    session.id,
    nextHandNumber,
    config,
    seats,
    buttonSeat,
    blindLevel.smallBlind,
    blindLevel.bigBlind,
    options.deckSeed ?? current.hand.deckSeed,
  );

  const pots = buildInitialPots(seats);
  const flags = createInitialFlags();
  const withAntes = applyAntes(seats, pots, hand, flags);
  const withBlinds = applyBlinds(
    withAntes.seats,
    withAntes.pots,
    hand,
    withAntes.flags,
  );

  const bettingRound = createInitialBettingRound(
    hand,
    withBlinds.seats,
    withBlinds.pots,
  );
  const updatedHand: HandLedger = {
    ...hand,
    bettingRounds: [bettingRound],
  };

  const cards: CardLedger = {
    remainingDeck: [...(options.deck ?? current.cards.remainingDeck)],
    burnPile: [],
    community: createEmptyCommunityBoard(),
    holeCards: createEmptyHoleCards(seats),
  };

  const clock = createActionClock(
    withBlinds.seats,
    updatedHand,
    session.activeSnapshot.clock.perTurnMs,
    options.timestamp ?? Date.now(),
  );

  const snapshot: TableSnapshot = {
    index: current.index + 1,
    handNumber: nextHandNumber,
    seating: { dealerButton: buttonSeat, seats: withBlinds.seats },
    hand: updatedHand,
    pots: withBlinds.pots,
    cards,
    personas: session.activeSnapshot.personas,
    clock,
    flags: withBlinds.flags,
  };

  const metrics: SessionMetrics = {
    ...session.metrics,
    handsDealt: session.metrics.handsDealt + 1,
  };

  return {
    ...session,
    initialSnapshot: cloneSnapshot(snapshot),
    events: [],
    activeSnapshot: snapshot,
    metrics,
  };
}

function buildSeats(
  maxSeats: number,
  seatsConfig: readonly SeatBootstrapConfig[],
): Seat[] {
  const assigned = new Map<number, SeatBootstrapConfig>();
  const queue: SeatBootstrapConfig[] = [];

  for (const config of seatsConfig) {
    if (config.seatIndex !== undefined) {
      assigned.set(config.seatIndex, config);
    } else {
      queue.push(config);
    }
  }

  const seats: Seat[] = [];
  for (let index = 0; index < maxSeats; index += 1) {
    const config = assigned.get(index) ?? queue.shift();
    if (config) {
      seats.push({
        index,
        occupant: {
          playerId: config.playerId,
          displayName: config.displayName ?? config.playerId,
          avatarUrl: config.avatarUrl,
          personaId: config.personaId,
        },
        status: config.status ?? 'occupied',
        stack: config.stack,
        rebuyTokens: config.rebuyTokens,
      });
    } else {
      seats.push({
        index,
        status: 'open',
        stack: 0,
      });
    }
  }

  if (queue.length > 0) {
    throw new Error('Received more seat configurations than available seats');
  }

  return seats;
}

function resolveButtonIndex(
  preferred: number | undefined,
  seats: readonly Seat[],
): number {
  if (preferred !== undefined) {
    return preferred;
  }
  const occupied = findNextOccupiedSeatIndex(seats, -1);
  return occupied ?? 0;
}

function buildHandLedger(
  sessionId: string,
  handNumber: number,
  config: SessionConfig,
  seats: readonly Seat[],
  buttonIndex: number,
  smallBlindAmount: number,
  bigBlindAmount: number,
  deckSeed: string,
): HandLedger {
  const { smallBlindSeat, bigBlindSeat } = resolveBlindSeatIndexes(
    seats,
    buttonIndex,
  );
  const handId = createDeterministicHandId(sessionId, handNumber);

  return {
    id: handId,
    stage: 'preflop',
    deckSeed,
    buttonSeat: buttonIndex,
    blinds: {
      smallBlind: {
        playerId:
          smallBlindSeat !== null
            ? (seats[smallBlindSeat]?.occupant?.playerId ?? 'unassigned')
            : 'unassigned',
        amount: smallBlindAmount,
      },
      bigBlind: {
        playerId:
          bigBlindSeat !== null
            ? (seats[bigBlindSeat]?.occupant?.playerId ?? 'unassigned')
            : 'unassigned',
        amount: bigBlindAmount,
      },
    },
    ante: resolveAnte(config, seats),
    bettingRounds: [],
  };
}

function resolveBlindSeatIndexes(
  seats: readonly Seat[],
  buttonIndex: number,
): { smallBlindSeat: number | null; bigBlindSeat: number | null } {
  const occupiedSeats = seats.filter((seat) => seat.occupant);
  if (occupiedSeats.length === 0) {
    return { smallBlindSeat: null, bigBlindSeat: null };
  }

  const buttonSeatHasPlayer = Boolean(seats[buttonIndex]?.occupant);
  const effectiveButton = buttonSeatHasPlayer
    ? buttonIndex
    : (findNextOccupiedSeatIndex(seats, buttonIndex) ??
      occupiedSeats[0]!.index);

  if (occupiedSeats.length === 1) {
    return { smallBlindSeat: effectiveButton, bigBlindSeat: null };
  }

  if (occupiedSeats.length === 2) {
    const otherSeat = findNextOccupiedSeatIndex(seats, effectiveButton);
    return { smallBlindSeat: effectiveButton, bigBlindSeat: otherSeat };
  }

  const smallBlindSeat = findNextOccupiedSeatIndex(seats, effectiveButton);
  if (smallBlindSeat === null) {
    return { smallBlindSeat: null, bigBlindSeat: null };
  }

  const bigBlindSeat = findNextOccupiedSeatIndex(seats, smallBlindSeat);
  return { smallBlindSeat, bigBlindSeat };
}

function resolveAnte(
  config: SessionConfig,
  seats: readonly Seat[],
): HandLedger['ante'] {
  const policy = config.antePolicy;
  if (!policy || policy.type === 'none') {
    return null;
  }

  if (policy.type === 'uniform') {
    const contributors = seats
      .filter((seat) => seat.occupant)
      .map((seat) => seat.occupant!.playerId);
    return {
      type: policy.appliesTo,
      amount: policy.amount,
      contributors,
    };
  }

  const firstLevel = policy.levels[0];
  if (!firstLevel) {
    return {
      type: 'everyone',
      amount: 0,
      contributors: seats
        .filter((seat) => seat.occupant)
        .map((seat) => seat.occupant!.playerId),
    };
  }
  const contributors = seats
    .filter((seat) => seat.occupant)
    .map((seat) => seat.occupant!.playerId);
  return {
    type: 'everyone',
    amount: firstLevel.amount,
    contributors,
  };
}

function buildPersonaMatrix(
  policy: PersonaPolicy,
  seats: readonly Seat[],
  timestamp: Timestamp,
  substitutions: Record<PlayerId, PersonaProfile['style']> = {},
): PersonaMatrix {
  const entries: PersonaMatrix['entries'] = {};
  for (const seat of seats) {
    if (!seat.occupant) continue;
    const playerId = seat.occupant.playerId;
    const style =
      substitutions[playerId] ??
      policy.overrides?.[playerId] ??
      policy.defaultStyle ??
      policy.fallbackStyle ??
      'balanced';

    entries[playerId] = createPersonaProfile(style, timestamp, {
      personaId: seat.occupant.personaId,
    });
  }

  return { entries };
}

function createEmptyCommunityBoard(): CommunityBoard {
  return { revealSchedule: [] };
}

function createEmptyHoleCards(seats: readonly Seat[]): Record<PlayerId, null> {
  const record: Record<PlayerId, null> = {};
  for (const seat of seats) {
    if (seat.occupant) {
      record[seat.occupant.playerId] = null;
    }
  }
  return record;
}

function buildInitialPots(seats: readonly Seat[]): PotLedger {
  const contributions: Record<PlayerId, number> = {};
  const eligible: PlayerId[] = [];

  for (const seat of seats) {
    if (!seat.occupant) continue;
    contributions[seat.occupant.playerId] = 0;
    eligible.push(seat.occupant.playerId);
  }

  return {
    main: {
      id: 'main',
      amount: 0,
      eligiblePlayers: eligible,
      contributions,
    },
    sides: [],
    rake: 0,
  };
}

function createInitialFlags(): HandFlags {
  return {
    showdownLocked: false,
    autoRunout: false,
    pendingEliminations: [],
    rebuyAvailable: false,
    advisoryPending: false,
    recoveryMode: false,
  };
}

function applyAntes(
  seats: readonly Seat[],
  pot: PotLedger,
  hand: HandLedger,
  flags: HandFlags,
): { seats: Seat[]; pots: PotLedger; flags: HandFlags } {
  const ante = hand.ante;
  if (!ante) {
    return { seats: seats.map(cloneSeat), pots: pot, flags };
  }

  const contributions = { ...pot.main.contributions };
  const pending = new Set(flags.pendingEliminations);
  let postedTotal = 0;

  const updatedSeats = seats.map((seat) => {
    if (!seat.occupant) {
      return cloneSeat(seat);
    }
    if (!ante.contributors.includes(seat.occupant.playerId)) {
      return cloneSeat(seat);
    }
    const contribution = applyContributionToSeat(seat, ante.amount);
    if (contribution.posted > 0) {
      contributions[seat.occupant.playerId] =
        (contributions[seat.occupant.playerId] ?? 0) + contribution.posted;
      postedTotal += contribution.posted;
      if (contribution.elimination) {
        pending.add(seat.occupant.playerId);
      }
    }
    return contribution.seat;
  });

  const updatedFlags: HandFlags = {
    ...flags,
    pendingEliminations: Array.from(pending),
  };

  const updatedPot: PotLedger = {
    ...pot,
    main: {
      ...pot.main,
      amount: pot.main.amount + postedTotal,
      contributions,
    },
  };

  return { seats: updatedSeats, pots: updatedPot, flags: updatedFlags };
}

function applyBlinds(
  seats: readonly Seat[],
  pot: PotLedger,
  hand: HandLedger,
  flags: HandFlags,
): { seats: Seat[]; pots: PotLedger; flags: HandFlags } {
  const contributions = { ...pot.main.contributions };
  const pending = new Set(flags.pendingEliminations);
  let postedTotal = 0;

  const updatedSeats = seats.map(cloneSeat);

  const applyPosting = (playerId: PlayerId, amount: number) => {
    if (amount <= 0) return;
    const index = updatedSeats.findIndex(
      (seat) => seat.occupant?.playerId === playerId,
    );
    if (index === -1) return;
    const result = applyContributionToSeat(updatedSeats[index]!, amount);
    updatedSeats[index] = result.seat;
    contributions[playerId] = (contributions[playerId] ?? 0) + result.posted;
    postedTotal += result.posted;
    if (result.elimination) {
      pending.add(playerId);
    }
  };

  applyPosting(hand.blinds.smallBlind.playerId, hand.blinds.smallBlind.amount);
  applyPosting(hand.blinds.bigBlind.playerId, hand.blinds.bigBlind.amount);

  const updatedFlags: HandFlags = {
    ...flags,
    pendingEliminations: Array.from(pending),
  };

  const updatedPot: PotLedger = {
    ...pot,
    main: {
      ...pot.main,
      amount: pot.main.amount + postedTotal,
      contributions,
    },
  };

  return { seats: updatedSeats, pots: updatedPot, flags: updatedFlags };
}

function createInitialBettingRound(
  hand: HandLedger,
  seats: readonly Seat[],
  pots: PotLedger,
): BettingRound {
  const turnOrder = seats
    .filter((seat) => seat.occupant)
    .map((seat) => seat.index);

  const contributions = Object.values(pots.main.contributions);
  const roundPot = contributions.reduce(
    (total, contribution) => total + contribution,
    0,
  );
  const highestBet = contributions.reduce(
    (currentHighest, contribution) =>
      contribution > currentHighest ? contribution : currentHighest,
    0,
  );

  return {
    stage: hand.stage,
    turnOrder,
    turns: [],
    roundPot,
    highestBet,
  };
}

function createActionClock(
  seats: readonly Seat[],
  hand: HandLedger,
  perTurnMs: number | undefined,
  timestamp: Timestamp,
): ActionClock {
  const bankMs: Record<PlayerId, number> = {};
  for (const seat of seats) {
    if (seat.occupant) {
      bankMs[seat.occupant.playerId] = 0;
    }
  }

  const currentActor = resolveNextActorId(seats, hand);
  const configuredPerTurnMs = perTurnMs ?? 30_000;
  const hasDeadline = configuredPerTurnMs > 0;

  return {
    currentActor: currentActor ?? undefined,
    deadline:
      currentActor && hasDeadline ? timestamp + configuredPerTurnMs : undefined,
    perTurnMs: configuredPerTurnMs,
    bankMs,
    pauses: [],
  };
}

function resolveNextActorId(
  seats: readonly Seat[],
  hand: HandLedger,
): PlayerId | undefined {
  const bigBlindSeatIndex = seats.findIndex(
    (seat) =>
      seat.occupant && seat.occupant.playerId === hand.blinds.bigBlind.playerId,
  );
  if (bigBlindSeatIndex === -1) {
    return undefined;
  }
  const nextSeat = findNextOccupiedSeatIndex(seats, bigBlindSeatIndex);
  if (nextSeat === null) {
    return undefined;
  }
  return seats[nextSeat]?.occupant?.playerId;
}

function findNextOccupiedSeatIndex(
  seats: readonly Seat[],
  startIndex: number,
): number | null {
  const total = seats.length;
  if (total === 0) return null;
  for (let offset = 1; offset <= total; offset += 1) {
    const index = (startIndex + offset + total) % total;
    const seat = seats[index];
    if (seat && seat.occupant) {
      return index;
    }
  }
  return null;
}

function normalizeLeavingSeats(seats: readonly Seat[]): Seat[] {
  return seats.map((seat) => {
    if (seat.status === 'leaving' && seat.stack === 0) {
      return {
        index: seat.index,
        status: 'open',
        stack: 0,
        rebuyTokens: seat.rebuyTokens,
      };
    }
    return cloneSeat(seat);
  });
}

function cloneSeat(seat: Seat): Seat {
  return {
    ...seat,
    occupant: seat.occupant ? { ...seat.occupant } : undefined,
  };
}

interface ContributionOutcome {
  readonly seat: Seat;
  readonly posted: number;
  readonly elimination: boolean;
}

function applyContributionToSeat(
  seat: Seat,
  amount: number,
): ContributionOutcome {
  if (!seat.occupant || amount <= 0) {
    return { seat: cloneSeat(seat), posted: 0, elimination: false };
  }

  const posted = Math.min(amount, seat.stack);
  const remaining = seat.stack - posted;
  const elimination = remaining === 0;

  const updatedSeat: Seat = {
    ...seat,
    stack: remaining,
    status: elimination ? 'leaving' : seat.status,
  };

  return {
    seat: updatedSeat,
    posted,
    elimination,
  };
}

function createInitialMetrics(): SessionMetrics {
  return {
    handsDealt: 0,
    potsAwarded: 0,
    averagePot: 0,
    avgIntentLatencyMs: 0,
    maxIntentLatencyMs: 0,
    timeoutsHard: 0,
    recoveries: 0,
    simulationsRun: 0,
    advisoryEquityRequests: 0,
  };
}

function resolveChannels(
  sessionId: UUID,
  overrides: Partial<SessionChannels> | undefined,
): SessionChannels {
  const analytics: AnalyticsEndpoint = {
    provider: 'noop',
    streamId: sessionId,
    batching: {
      maxBatch: 100,
      flushMs: 1_000,
    },
  };

  const advisory: AdvisorBridge = {
    requestTopic: `advisor:${sessionId}`,
    responseTopic: `advisor:${sessionId}:responses`,
    timeoutMs: 5_000,
  };

  const base: SessionChannels = {
    realtime: `session:${sessionId}`,
    analytics,
    replay: { transport: 'filesystem', retentionHands: 20 },
    advisory,
  };

  if (!overrides) {
    return base;
  }

  return {
    realtime: overrides.realtime ?? base.realtime,
    analytics: overrides.analytics ?? base.analytics,
    replay: overrides.replay ?? base.replay,
    advisory: overrides.advisory ?? base.advisory,
  };
}

function cloneSnapshot(snapshot: TableSnapshot): TableSnapshot {
  if (typeof structuredClone === 'function') {
    return structuredClone(snapshot);
  }
  return JSON.parse(JSON.stringify(snapshot)) as TableSnapshot;
}

declare function structuredClone<T>(value: T): T;
