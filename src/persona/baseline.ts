import type { PersonaArchetype, PersonaId, Timestamp } from '../types/common';
import type { PersonaProfile, PersonaTelemetry } from '../types/persona';

interface PersonaTraitBaseline {
  readonly aggression: number;
  readonly tightness: number;
  readonly bluffIndex: number;
  readonly riskTolerance: number;
}

const DEFAULT_TRAITS: PersonaTraitBaseline = {
  aggression: 50,
  tightness: 50,
  bluffIndex: 50,
  riskTolerance: 50,
};

const TRAIT_BASELINES: Record<PersonaArchetype, PersonaTraitBaseline> = {
  balanced: DEFAULT_TRAITS,
  'tight-aggressive': {
    aggression: 72,
    tightness: 85,
    bluffIndex: 32,
    riskTolerance: 44,
  },
  'loose-aggressive': {
    aggression: 88,
    tightness: 28,
    bluffIndex: 82,
    riskTolerance: 78,
  },
  'tight-passive': {
    aggression: 34,
    tightness: 82,
    bluffIndex: 18,
    riskTolerance: 30,
  },
  'loose-passive': {
    aggression: 42,
    tightness: 24,
    bluffIndex: 26,
    riskTolerance: 36,
  },
  exploitative: {
    aggression: 65,
    tightness: 58,
    bluffIndex: 68,
    riskTolerance: 62,
  },
};

const TELEMETRY_BASELINE: PersonaTelemetry = {
  vpip: 0,
  pfr: 0,
  aggressionFactor: 0,
  showdownRate: 0,
  tiltIndicator: 0,
};

function clampPercent(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

function resolveTraits(style: PersonaArchetype): PersonaTraitBaseline {
  return TRAIT_BASELINES[style] ?? DEFAULT_TRAITS;
}

function buildFeatureVector(traits: PersonaTraitBaseline): readonly number[] {
  return [
    clampPercent(traits.aggression) / 100,
    clampPercent(traits.tightness) / 100,
    clampPercent(traits.bluffIndex) / 100,
    clampPercent(traits.riskTolerance) / 100,
  ];
}

export interface PersonaProfileOptions {
  readonly personaId?: PersonaId;
  readonly timestampOverride?: Timestamp;
}

export function createPersonaProfile(
  style: PersonaArchetype,
  timestamp: Timestamp,
  options: PersonaProfileOptions = {},
): PersonaProfile {
  const traits = resolveTraits(style);
  const aggression = clampPercent(traits.aggression);
  const tightness = clampPercent(traits.tightness);
  const bluffIndex = clampPercent(traits.bluffIndex);
  const riskTolerance = clampPercent(traits.riskTolerance);

  const profile: PersonaProfile = {
    style,
    aggression,
    tightness,
    bluffIndex,
    riskTolerance,
    adaptation: {
      trackedMetrics: { ...TELEMETRY_BASELINE },
      lastUpdated: options.timestampOverride ?? timestamp,
      featureVector: buildFeatureVector({
        aggression,
        tightness,
        bluffIndex,
        riskTolerance,
      }),
    },
  };

  if (!options.personaId) {
    return profile;
  }

  return {
    ...profile,
    personaId: options.personaId,
  } satisfies PersonaProfile;
}

export function normalizePersonaTelemetry(
  telemetry: PersonaTelemetry,
): PersonaTelemetry {
  return {
    vpip: clampPercent(telemetry.vpip),
    pfr: clampPercent(telemetry.pfr),
    aggressionFactor: clampPercent(telemetry.aggressionFactor),
    showdownRate: clampPercent(telemetry.showdownRate),
    tiltIndicator:
      telemetry.tiltIndicator === undefined
        ? 0
        : clampPercent(telemetry.tiltIndicator),
  } satisfies PersonaTelemetry;
}
