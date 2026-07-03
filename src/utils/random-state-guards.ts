import type { SnapshotEnvelope } from '../types/events';
import type {
  PokerStateFixtureOrigin,
  RandomStateSummary,
  SerializableSessionState,
  UniversalPokerStateFixture,
} from '../types/random-state';
import type { TableSnapshot } from '../types/snapshot';

const FIXTURE_ORIGINS: readonly PokerStateFixtureOrigin[] = [
  'headed-ui',
  'headless-script',
  'test-suite',
  'manual',
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isSnapshotEnvelope<T>(
  value: unknown,
): value is SnapshotEnvelope<T> {
  return (
    isRecord(value) &&
    typeof (value as Record<string, unknown>).envelopeVersion === 'number' &&
    'snapshot' in (value as Record<string, unknown>)
  );
}

export function isSerializableSessionState(
  value: unknown,
): value is SerializableSessionState {
  if (!isRecord(value)) {
    return false;
  }

  const {
    id,
    config,
    runtimeContext,
    initialSnapshot,
    activeSnapshot,
    metrics,
    channels,
    events,
  } = value as Record<string, unknown>;

  return (
    typeof id === 'string' &&
    config !== undefined &&
    runtimeContext !== undefined &&
    isSnapshotEnvelope<TableSnapshot>(initialSnapshot) &&
    activeSnapshot !== undefined &&
    metrics !== undefined &&
    channels !== undefined &&
    Array.isArray(events)
  );
}

export function isRandomStateSummary(
  value: unknown,
): value is RandomStateSummary {
  if (!isRecord(value)) {
    return false;
  }

  const { session, decision, stepsApplied } = value as Record<string, unknown>;

  if (!isSerializableSessionState(session)) {
    return false;
  }

  if (!isRecord(decision) || typeof stepsApplied !== 'number') {
    return false;
  }

  return typeof (decision as Record<string, unknown>).handStage === 'string';
}

export function isUniversalPokerStateFixture(
  value: unknown,
): value is UniversalPokerStateFixture {
  if (!isRecord(value)) {
    return false;
  }

  const { id, description, origin, payload } = value as Record<string, unknown>;

  if (
    typeof id !== 'string' ||
    typeof description !== 'string' ||
    typeof origin !== 'string' ||
    !FIXTURE_ORIGINS.includes(origin as PokerStateFixtureOrigin)
  ) {
    return false;
  }

  return isRandomStateSummary(payload);
}
