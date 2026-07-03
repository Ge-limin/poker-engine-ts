import { SnapshotIntegrityError } from '../errors';
import type {
  SnapshotEnvelope,
  TableSnapshot,
  TurnEvent,
  TurnEventEnvelope,
} from '../../types/index';

import { EnvelopeUpcaster } from './envelope-registry';

export const TURN_EVENT_ENVELOPE_VERSION = 1;
export const SNAPSHOT_ENVELOPE_VERSION = 1;

export type { SnapshotEnvelope } from '../../types/index';

export function toTurnEventEnvelope(event: TurnEvent): TurnEventEnvelope {
  return {
    envelopeVersion: TURN_EVENT_ENVELOPE_VERSION,
    event,
  } satisfies TurnEventEnvelope;
}

export function fromTurnEventEnvelope(
  envelope: TurnEventEnvelope | { envelopeVersion: number; event: unknown },
  upcaster?: EnvelopeUpcaster<TurnEvent>,
): TurnEvent {
  if (envelope.envelopeVersion === TURN_EVENT_ENVELOPE_VERSION) {
    return envelope.event as TurnEvent;
  }

  if (!upcaster) {
    throw new SnapshotIntegrityError('Missing upcaster for legacy turn event', {
      version: envelope.envelopeVersion,
    });
  }

  return upcaster.upcast(envelope.envelopeVersion, envelope.event);
}

export function toSnapshotEnvelope(
  snapshot: TableSnapshot,
): SnapshotEnvelope<TableSnapshot> {
  return {
    envelopeVersion: SNAPSHOT_ENVELOPE_VERSION,
    snapshot,
  } satisfies SnapshotEnvelope<TableSnapshot>;
}

export function fromSnapshotEnvelope(
  envelope: SnapshotEnvelope | { envelopeVersion: number; snapshot: unknown },
  upcaster?: EnvelopeUpcaster<TableSnapshot>,
): TableSnapshot {
  if (envelope.envelopeVersion === SNAPSHOT_ENVELOPE_VERSION) {
    return envelope.snapshot as TableSnapshot;
  }

  if (!upcaster) {
    throw new SnapshotIntegrityError('Missing upcaster for legacy snapshot', {
      version: envelope.envelopeVersion,
    });
  }

  return upcaster.upcast(envelope.envelopeVersion, envelope.snapshot);
}

export { EnvelopeUpcaster };
