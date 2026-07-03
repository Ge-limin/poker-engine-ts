import type { Chips, HandStage, SimulationTrigger } from './common';

export interface BlindLevel {
  readonly level: number;
  readonly smallBlind: Chips;
  readonly bigBlind: Chips;
  readonly durationMinutes?: number;
  readonly ante?: Chips;
}

export type AntePolicy =
  | { readonly type: 'none' }
  | {
      readonly type: 'uniform';
      readonly amount: Chips;
      readonly appliesTo: 'everyone' | 'button' | 'big-blind';
    }
  | {
      readonly type: 'progressive';
      readonly levels: readonly AnteLevel[];
    };

export interface AnteLevel {
  readonly level: number;
  readonly amount: Chips;
}

export interface RuleSetDescriptor {
  readonly streets: readonly HandStage[];
  readonly postingOrder: readonly (
    | 'small-blind'
    | 'big-blind'
    | 'straddle'
    | 'ante'
  )[];
  readonly minRaisePolicy: 'double-last-bet' | 'fixed-increment' | 'pot-limit';
  readonly maxRaisePolicy?: 'pot' | 'all-in';
  readonly cardDistribution: DistributionRule;
  readonly showdownOrdering: 'high-card' | 'lowball' | 'hi-lo';
}

export interface DistributionRule {
  readonly holeCardsPerPlayer: number;
  readonly burnPerStreet: readonly number[];
  readonly communityReveal: readonly number[];
}

export interface EvaluationPolicy {
  readonly engine: 'lookup-table' | 'monte-carlo' | 'hybrid';
  readonly evaluatorId: string;
  readonly supportsHiLo: boolean;
  readonly cacheSize: number;
}

export interface SimulationPolicy {
  readonly maxIterations: number;
  readonly convergenceEpsilon: number;
  readonly supportsPartialInformation: boolean;
  readonly scenarioHooks?: readonly SimulationHookDescriptor[];
}

export interface SimulationHookDescriptor {
  readonly id: string;
  readonly trigger: SimulationTrigger;
  readonly payloadSchema: Record<string, unknown>;
}
