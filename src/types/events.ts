import type {
  ActionOrigin,
  Card,
  Chips,
  HandStage,
  Milliseconds,
  PlayerId,
  Timestamp,
  ValidationWarningCode,
} from './common';
import type {
  HandFlags,
  PayoutSummary,
  RevealEvent,
  ShowdownSummary,
} from './snapshot';

export type PlayerAction =
  | { readonly type: 'fold' }
  | { readonly type: 'check' }
  | {
      readonly type: 'call';
      readonly amount: Chips;
      readonly isAllIn?: boolean;
    }
  | { readonly type: 'bet'; readonly amount: Chips; readonly isAllIn?: boolean }
  | {
      readonly type: 'raise';
      readonly amount: Chips;
      readonly to?: Chips;
      readonly isAllIn?: boolean;
    }
  | {
      readonly type: 'all-in';
      readonly amount: Chips;
      readonly from: 'bet' | 'call' | 'raise';
    }
  | {
      readonly type: 'post-blind';
      readonly blind: 'small' | 'big' | 'straddle';
      readonly amount: Chips;
    }
  | { readonly type: 'post-ante'; readonly amount: Chips }
  | { readonly type: 'timeout'; readonly fallback: 'fold' | 'check' }
  | { readonly type: 'resume' };

export type PlayerOption =
  | { readonly type: 'fold'; readonly disabled?: boolean }
  | { readonly type: 'check'; readonly disabled?: boolean }
  | {
      readonly type: 'call';
      readonly amount: Chips;
      readonly disabled?: boolean;
    }
  | {
      readonly type: 'bet';
      readonly min: Chips;
      readonly max: Chips;
      readonly increment: Chips;
      readonly disabled?: boolean;
    }
  | {
      readonly type: 'raise';
      readonly min: Chips;
      readonly max: Chips;
      readonly increment: Chips;
      readonly disabled?: boolean;
    }
  | {
      readonly type: 'all-in';
      readonly amount: Chips;
      readonly disabled?: boolean;
    };

export interface TurnEvent {
  readonly id: string;
  readonly actor: PlayerId;
  readonly action: PlayerAction;
  readonly legalOptions: readonly PlayerOption[];
  readonly stackBefore: Chips;
  readonly stackAfter: Chips;
  readonly contribution: Chips;
  readonly timestamp: Timestamp;
  readonly metadata?: TurnMetadata;
}

export interface CommunityRevealMetadata {
  readonly stage: Extract<HandStage, 'flop' | 'turn' | 'river'>;
  readonly cards: readonly Card[];
  readonly reason?: RevealEvent['reason'];
}

export interface CardRevealMetadata {
  readonly community?: readonly CommunityRevealMetadata[];
  readonly holeCards?: Partial<Record<PlayerId, readonly Card[]>>;
}

export interface TurnMetadata {
  readonly advisorSnapshotId?: string;
  readonly misclickProtection?: boolean;
  readonly networkLatencyMs?: Milliseconds;
  readonly validationMs?: Milliseconds;
  readonly engineVersion: string;
  readonly availableActionsAtDecision: readonly PlayerOption[];
  readonly retryCount?: number;
  readonly nextHandStage?: HandStage;
  readonly nextActorId?: PlayerId;
  readonly showdownSummary?: ShowdownSummary;
  readonly payoutSummary?: PayoutSummary;
  readonly cardReveals?: CardRevealMetadata;
  readonly personaFlagUpdates?: Partial<HandFlags>;
}

export interface TurnIntent {
  readonly id: string;
  readonly actor: PlayerId;
  readonly requested: PlayerAction;
  readonly amount?: Chips;
  readonly issuedAt: Timestamp;
  readonly origin: ActionOrigin;
  readonly latencyMs?: Milliseconds;
  readonly expectedSnapshotVersion?: number;
}

export type ValidationResult =
  | {
      readonly kind: 'accepted';
      readonly event: TurnEvent;
      readonly warnings?: readonly ValidationWarning[];
    }
  | {
      readonly kind: 'rejected';
      readonly reason: string;
      readonly recovery?: RecoveryDirective;
    };

export interface ValidationWarning {
  readonly code: ValidationWarningCode;
  readonly message: string;
}

export interface RecoveryDirective {
  readonly advise: 'retry' | 'stand_pat' | 'auto_fold';
  readonly substitution?: PlayerId;
}

export interface TurnEventEnvelope {
  readonly envelopeVersion: number;
  readonly event: TurnEvent;
}

export interface SnapshotEnvelope<TSnapshot = unknown> {
  readonly envelopeVersion: number;
  readonly snapshot: TSnapshot;
}

export type Upcaster<TTarget> = (legacy: unknown) => TTarget;
