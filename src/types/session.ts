import type {
  AnalyticsProvider,
  BettingStructure,
  Chips,
  Milliseconds,
  PersonaArchetype,
  PlayerId,
  ReplayTransport,
  RuntimeMode,
  TableVariant,
  UUID,
} from './common';
import type {
  AntePolicy,
  BlindLevel,
  EvaluationPolicy,
  RuleSetDescriptor,
  SimulationPolicy,
} from './config';
import type { DecisionContextView } from './derived';
import type { TurnEvent, TurnIntent, ValidationResult } from './events';
import type { TableSnapshot } from './snapshot';

export interface Session {
  readonly id: UUID;
  readonly config: SessionConfig;
  readonly runtimeContext: RuntimeContext;
  readonly initialSnapshot: TableSnapshot;
  readonly events: readonly TurnEvent[];
  readonly activeSnapshot: TableSnapshot;
  readonly metrics: SessionMetrics;
  readonly channels: SessionChannels;
  readonly hooks: EngineHooks;
}

export interface SessionConfig {
  readonly tableVariant: TableVariant;
  readonly bettingStructure: BettingStructure;
  readonly maxSeats: 2 | 6 | 9;
  readonly startingStack: Chips;
  readonly blindSchedule: readonly BlindLevel[];
  readonly antePolicy?: AntePolicy;
  readonly personaPolicy: PersonaPolicy;
  readonly ruleSet: RuleSetDescriptor;
  readonly evaluationPolicy: EvaluationPolicy;
  readonly simulationPolicy?: SimulationPolicy;
  readonly autoAdvance: boolean;
}

export interface PersonaPolicy {
  readonly defaultStyle: PersonaArchetype;
  readonly fallbackStyle?: PersonaArchetype;
  readonly overrides?: Record<PlayerId, PersonaArchetype>;
}

export type RuntimeContext =
  | { readonly mode: Extract<RuntimeMode, 'live'> }
  | {
      readonly mode: Extract<RuntimeMode, 'replay'>;
      readonly timelineIndex: number;
      readonly isPlaying: boolean;
      readonly speed: number;
    }
  | {
      readonly mode: Extract<RuntimeMode, 'simulation'>;
      readonly simulationId: string;
      readonly handsToRun: number;
      readonly handsCompleted: number;
    }
  | {
      readonly mode: Extract<RuntimeMode, 'scenario'>;
      readonly scenarioId: string;
      readonly isCompleted: boolean;
      readonly viewingIndex: number | null;
    };

export interface SessionMetrics {
  readonly handsDealt: number;
  readonly potsAwarded: number;
  readonly averagePot: number;
  readonly avgIntentLatencyMs: Milliseconds;
  readonly maxIntentLatencyMs: Milliseconds;
  readonly timeoutsHard: number;
  readonly recoveries: number;
  readonly simulationsRun: number;
  readonly advisoryEquityRequests: number;
}

export interface SessionChannels {
  readonly realtime: string;
  readonly analytics: AnalyticsEndpoint;
  readonly replay: ReplayQueue;
  readonly advisory: AdvisorBridge;
}

export interface AnalyticsEndpoint {
  readonly provider: AnalyticsProvider;
  readonly streamId: string;
  readonly batching: {
    readonly maxBatch: number;
    readonly flushMs: Milliseconds;
  };
}

export interface ReplayQueue {
  readonly transport: ReplayTransport;
  readonly retentionHands: number;
}

export interface AdvisorBridge {
  readonly requestTopic: string;
  readonly responseTopic: string;
  readonly timeoutMs: Milliseconds;
}

export type HookCollection<TPayload> =
  | HookRegistration<TPayload>
  | readonly HookRegistration<TPayload>[];

export interface EngineHooks {
  readonly beforeIntent?: HookCollection<TurnIntent>;
  readonly afterValidation?: HookCollection<ValidationResult>;
  readonly afterReduction?: HookCollection<TableSnapshot>;
  readonly handCompleted?: HookCollection<TableSnapshot['hand']>;
  readonly simulationRequested?: HookCollection<SimulationRequest>;
}

export interface HookRegistration<TPayload> {
  readonly id: string;
  readonly priority: number;
  readonly handler: (
    payload: TPayload,
    session: Session,
  ) => void | Promise<void>;
}

export interface SimulationRequest {
  readonly context: DecisionContextView;
  readonly policy: SimulationPolicy;
  readonly iterations: number;
  readonly resultChannel: string;
}
