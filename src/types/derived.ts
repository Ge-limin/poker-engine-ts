import type {
  Card,
  Chips,
  DeckSeed,
  HandStage,
  Milliseconds,
  PlayerId,
  RuntimeMode,
  SeatIndex,
  Timestamp,
} from './common';
import type { PlayerAction, PlayerOption, TurnMetadata } from './events';
import type { PersonaProfile } from './persona';
import type { SessionConfig } from './session';
import type {
  ActionClock,
  CommunityBoard,
  HandFlags,
  HandLedger,
  PotLedger,
  SeatStatus,
  TableSnapshot,
} from './snapshot';

export interface TableSeatView {
  readonly seatIndex: SeatIndex;
  readonly status: SeatStatus;
  readonly playerId?: PlayerId;
  readonly displayName?: string;
  readonly stack: Chips;
  readonly contribution: Chips;
  readonly isActive: boolean;
  readonly isAllIn: boolean;
}

export interface TableView {
  readonly handNumber: number;
  readonly dealerButton: SeatIndex;
  readonly seats: readonly TableSeatView[];
  readonly board: BoardView;
  readonly potTotal: Chips;
  readonly pots: PotLedger;
  readonly handStage: HandStage;
  readonly currentActor?: PlayerId;
  readonly availableActions: readonly PlayerOption[];
  readonly clock: ActionClock;
  readonly flags: HandFlags;
}

export interface BoardView {
  readonly flop?: readonly Card[];
  readonly turn?: Card;
  readonly river?: Card;
  readonly revealSchedule: TableSnapshot['cards']['community']['revealSchedule'];
}

export interface DecisionContextView {
  readonly handNumber: number;
  readonly actor?: PlayerId;
  readonly handStage: HandStage;
  readonly potSize: Chips;
  readonly effectiveStack: Chips;
  readonly playersLeftToAct: readonly PlayerId[];
  readonly availableActions: readonly PlayerOption[];
}

export interface HandSummaryView {
  readonly handNumber: number;
  readonly winners: readonly PayoutView[];
  readonly pendingEliminations: readonly PlayerId[];
  readonly showdown?: HandLedger['showdown'];
}

export interface PayoutView {
  readonly playerId: PlayerId;
  readonly amount: Chips;
  readonly potIds: readonly string[];
}

export interface PersonaSnapshotView {
  readonly personaId?: PersonaProfile['personaId'];
  readonly style: PersonaProfile['style'];
  readonly aggression: PersonaProfile['aggression'];
  readonly tightness: PersonaProfile['tightness'];
  readonly bluffIndex: PersonaProfile['bluffIndex'];
  readonly riskTolerance: PersonaProfile['riskTolerance'];
  readonly trackedMetrics: PersonaProfile['adaptation']['trackedMetrics'];
  readonly featureVector: PersonaProfile['adaptation']['featureVector'];
  readonly lastUpdated: Timestamp;
  readonly notes?: PersonaProfile['adaptation']['notes'];
}

export interface PersonaAdjustmentView {
  readonly playerId: PlayerId;
  readonly before?: PersonaSnapshotView;
  readonly after: PersonaSnapshotView;
}

export interface TelemetryClockView {
  readonly currentActor?: PlayerId;
  readonly deadline?: Timestamp;
  readonly perTurnMs: Milliseconds;
  readonly bankMs: Record<PlayerId, Milliseconds>;
}

export interface TelemetryEventView {
  readonly sessionId: string;
  readonly eventId: string;
  readonly eventIndex?: number;
  readonly handNumber: number;
  readonly handStage: HandStage;
  readonly snapshotVersion: number;
  readonly actor: PlayerId;
  readonly action: PlayerAction;
  readonly stackBefore: Chips;
  readonly stackAfter: Chips;
  readonly contribution: Chips;
  readonly potBefore: Chips;
  readonly potTotal: Chips;
  readonly potDelta: Chips;
  readonly latencyMs?: Milliseconds;
  readonly runtimeMode: RuntimeMode;
  readonly occurredAt: Timestamp;
  readonly metadata?: TurnMetadata;
  readonly legalOptions: readonly PlayerOption[];
  readonly availableActionsAtDecision: readonly PlayerOption[];
  readonly personaAdjustments: readonly PersonaAdjustmentView[];
  readonly clock: TelemetryClockView;
  readonly handFlags: {
    readonly showdownLocked: boolean;
    readonly autoRunout: boolean;
    readonly advisoryPending: boolean;
  };
}

export interface SimulationView {
  readonly handNumber: number;
  readonly deckSeed: DeckSeed;
  readonly remainingDeck: readonly Card[];
  readonly community: CommunityBoard;
  readonly seatStacks: Record<PlayerId, Chips>;
  readonly ruleSet: SessionConfig['ruleSet'];
  readonly personas: readonly PersonaDigestView[];
}

export interface PersonaDigestView {
  readonly playerId: PlayerId;
  readonly profile: PersonaProfile;
}
