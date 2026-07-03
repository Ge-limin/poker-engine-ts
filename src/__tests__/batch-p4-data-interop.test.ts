import { describe, expect, test } from 'vitest';

import {
  SNAPSHOT_ENVELOPE_VERSION,
  TURN_EVENT_ENVELOPE_VERSION,
  createTableSnapshot,
  fromSnapshotEnvelope,
  fromTurnEventEnvelope,
  toSnapshotEnvelope,
  toTurnEventEnvelope,
} from '..';
import type { TurnEvent } from '..';

/**
 * @batch(P4) Data Interoperability & Tooling
 *
 * The persistence layer serializes snapshots and turn events through versioned
 * envelopes. These tests exercise the real envelope API end to end: a value
 * survives a JSON round-trip unchanged, the envelope carries its schema version,
 * and an unknown version fails loudly unless an upcaster is supplied.
 */

describe('@batch(P4) data interoperability', () => {
  test('a snapshot survives a JSON round-trip through its envelope', () => {
    const snapshot = createTableSnapshot({
      handId: 'hand-roundtrip',
      players: [
        { id: 'player-a', stack: 200 },
        { id: 'player-b', stack: 180 },
      ],
    });

    const envelope = toSnapshotEnvelope(snapshot);
    expect(envelope.envelopeVersion).toBe(SNAPSHOT_ENVELOPE_VERSION);

    const restored = fromSnapshotEnvelope(JSON.parse(JSON.stringify(envelope)));
    expect(restored).toEqual(snapshot);
  });

  test('a turn event survives a JSON round-trip through its envelope', () => {
    const event: TurnEvent = {
      id: 'evt-1',
      actor: 'player-a',
      action: { type: 'call', amount: 20 },
      legalOptions: [],
      stackBefore: 200,
      stackAfter: 180,
      contribution: 20,
      timestamp: 1_000,
    };

    const envelope = toTurnEventEnvelope(event);
    expect(envelope.envelopeVersion).toBe(TURN_EVENT_ENVELOPE_VERSION);

    const restored = fromTurnEventEnvelope(JSON.parse(JSON.stringify(envelope)));
    expect(restored).toEqual(event);
  });

  test('an unknown snapshot envelope version fails loudly without an upcaster', () => {
    const snapshot = createTableSnapshot({
      handId: 'hand-unknown-version',
      players: [{ id: 'player-a', stack: 100 }],
    });

    expect(() => fromSnapshotEnvelope({ envelopeVersion: 999, snapshot })).toThrow();
  });

  test('an unknown turn-event envelope version fails loudly without an upcaster', () => {
    const event: TurnEvent = {
      id: 'evt-stale',
      actor: 'player-a',
      action: { type: 'fold' },
      legalOptions: [],
      stackBefore: 100,
      stackAfter: 100,
      contribution: 0,
      timestamp: 1_000,
    };

    expect(() => fromTurnEventEnvelope({ envelopeVersion: 999, event })).toThrow();
  });
});
