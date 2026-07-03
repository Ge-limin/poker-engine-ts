import type {
  PersonaArchetype,
  PersonaId,
  PlayerId,
  Timestamp,
} from './common';

export interface PersonaMatrix {
  readonly entries: Record<PlayerId, PersonaProfile>;
}

export interface PersonaProfile {
  readonly personaId?: PersonaId;
  readonly style: PersonaArchetype;
  readonly aggression: number;
  readonly tightness: number;
  readonly bluffIndex: number;
  readonly riskTolerance: number;
  readonly adaptation: PersonaAdaptation;
}

export interface PersonaAdaptation {
  readonly trackedMetrics: PersonaTelemetry;
  readonly lastUpdated: Timestamp;
  readonly featureVector: readonly number[];
  readonly notes?: string;
}

export interface PersonaTelemetry {
  readonly vpip: number;
  readonly pfr: number;
  readonly aggressionFactor: number;
  readonly showdownRate: number;
  readonly tiltIndicator?: number;
}
