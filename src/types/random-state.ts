import type { UUID } from './common';
import type { DecisionContextView } from './derived';
import type { SnapshotEnvelope, TurnEventEnvelope } from './events';
import type {
  RuntimeContext,
  SessionChannels,
  SessionConfig,
  SessionMetrics,
} from './session';
import type { TableSnapshot } from './snapshot';

export interface SerializableSessionState {
  readonly id: UUID;
  readonly config: SessionConfig;
  readonly runtimeContext: RuntimeContext;
  readonly initialSnapshot: SnapshotEnvelope<TableSnapshot>;
  readonly activeSnapshot: TableSnapshot;
  readonly metrics: SessionMetrics;
  readonly channels: SessionChannels;
  readonly events: readonly TurnEventEnvelope[];
}

export interface RandomStateSummary {
  readonly session: SerializableSessionState;
  readonly decision: DecisionContextView;
  readonly stepsApplied: number;
}

export type PokerStateFixtureOrigin =
  | 'headed-ui'
  | 'headless-script'
  | 'test-suite'
  | 'manual';

export interface UniversalPokerStateFixture {
  readonly id: string;
  readonly description: string;
  readonly origin: PokerStateFixtureOrigin;
  readonly payload: RandomStateSummary;
}

export interface StepRangeConfig {
  readonly min?: number;
  readonly max?: number;
}
