import type {
  Card,
  Chips,
  DeckSeed,
  HandStage,
  Milliseconds,
  PauseReason,
  PlayerId,
  SeatIndex,
  Stack,
  Timestamp,
} from './common';
import type { TurnEvent } from './events';
import type { PersonaMatrix } from './persona';

export interface TableSnapshot {
  readonly index: number;
  readonly handNumber: number;
  readonly seating: SeatingChart;
  readonly hand: HandLedger;
  readonly pots: PotLedger;
  readonly cards: CardLedger;
  readonly personas: PersonaMatrix;
  readonly clock: ActionClock;
  readonly flags: HandFlags;
}

export interface SeatingChart {
  readonly dealerButton: SeatIndex;
  readonly seats: readonly Seat[];
}

export interface Seat {
  readonly index: SeatIndex;
  readonly occupant?: PlayerRef;
  readonly status: SeatStatus;
  readonly stack: Stack;
  readonly rebuyTokens?: number;
}

export type SeatStatus = 'open' | 'reserved' | 'occupied' | 'leaving';

export interface PlayerRef {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly personaId?: string;
}

export interface HandLedger {
  readonly id: string;
  readonly stage: HandStage;
  readonly deckSeed: DeckSeed;
  readonly buttonSeat: SeatIndex;
  readonly blinds: BlindPosting;
  readonly ante: AntePosting | null;
  readonly bettingRounds: readonly BettingRound[];
  readonly showdown?: ShowdownSummary;
  readonly payouts?: PayoutSummary;
}

export interface BlindPosting {
  readonly smallBlind: BlindCommitment;
  readonly bigBlind: BlindCommitment;
  readonly straddles?: readonly BlindCommitment[];
}

export interface BlindCommitment {
  readonly playerId: PlayerId;
  readonly amount: Chips;
  readonly isDead?: boolean;
}

export interface AntePosting {
  readonly type: 'everyone' | 'button' | 'big-blind';
  readonly amount: Chips;
  readonly contributors: readonly PlayerId[];
}

export interface BettingRound {
  readonly stage: HandStage;
  readonly turnOrder: readonly SeatIndex[];
  readonly turns: readonly TurnEvent[];
  readonly roundPot: Chips;
  readonly highestBet: Chips;
  readonly lastAggressor?: PlayerId;
}

export interface ShowdownSummary {
  readonly evaluatedHands: readonly EvaluatedHand[];
  readonly board: readonly Card[];
  readonly evaluatorId: string;
  readonly equities?: readonly EquityBreakdown[];
}

export interface EvaluatedHand {
  readonly playerId: PlayerId;
  readonly rankClass: string;
  readonly rankValue: number;
  readonly bestFive: readonly Card[];
  readonly kickers: readonly Card[];
}

export interface EquityBreakdown {
  readonly playerId: PlayerId;
  readonly winPct: number;
  readonly tiePct: number;
  readonly lossPct: number;
  readonly iterations: number;
}

export interface PayoutSummary {
  readonly entries: readonly PayoutEntry[];
  readonly rake?: Chips;
}

export interface PayoutEntry {
  readonly playerId: PlayerId;
  readonly amount: Chips;
  readonly potIds: readonly string[];
}

export interface PotLedger {
  readonly main: PotBucket;
  readonly sides: readonly PotBucket[];
  readonly rake: Chips;
}

export interface PotBucket {
  readonly id: string;
  readonly amount: Chips;
  readonly eligiblePlayers: readonly PlayerId[];
  readonly contributions: Record<PlayerId, Chips>;
}

export interface CardLedger {
  readonly remainingDeck: readonly Card[];
  readonly burnPile: readonly Card[];
  readonly community: CommunityBoard;
  readonly holeCards: Record<PlayerId, readonly Card[] | null>;
}

export interface CommunityBoard {
  readonly flop?: readonly [Card, Card, Card];
  readonly turn?: Card;
  readonly river?: Card;
  readonly revealSchedule: readonly RevealEvent[];
}

export interface RevealEvent {
  readonly stage: HandStage;
  readonly cards: readonly Card[];
  readonly timestamp: Timestamp;
  readonly reason: 'deal' | 'burn' | 'expose' | 'rollback';
}

export interface ActionClock {
  readonly currentActor?: PlayerId;
  readonly deadline?: Timestamp;
  readonly perTurnMs: Milliseconds;
  readonly bankMs: Record<PlayerId, Milliseconds>;
  readonly pauses: readonly PauseWindow[];
}

export interface PauseWindow {
  readonly reason: PauseReason;
  readonly startedAt: Timestamp;
  readonly resumedAt?: Timestamp;
}

export interface HandFlags {
  readonly showdownLocked: boolean;
  readonly autoRunout: boolean;
  readonly pendingEliminations: readonly PlayerId[];
  readonly rebuyAvailable: boolean;
  readonly advisoryPending: boolean;
  readonly recoveryMode: boolean;
}
