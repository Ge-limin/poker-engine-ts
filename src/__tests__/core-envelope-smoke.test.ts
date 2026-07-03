import { describe, expect, test } from 'vitest';

import {
  EnvelopeUpcaster,
  SNAPSHOT_ENVELOPE_VERSION,
  TURN_EVENT_ENVELOPE_VERSION,
  fromSnapshotEnvelope,
  fromTurnEventEnvelope,
  reduce,
  toSnapshotEnvelope,
  toTurnEventEnvelope,
  validateIntent,
} from '..';
import { createTableSnapshot, createTurnIntent } from '../testing';
import type { TurnEvent } from '../types/events';
import type { TableSnapshot } from '../types/snapshot';

describe('intent validation', () => {
  test('accepts a legal check when it is the actors turn', () => {
    const snapshot = createTableSnapshot();
    const intent = createTurnIntent({
      expectedSnapshotVersion: snapshot.index,
      requested: { type: 'check' },
    });

    const result = validateIntent(snapshot, intent);

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.event.action.type).toBe('check');
    expect(result.event.stackAfter).toBe(result.event.stackBefore);
  });

  test('rejects intents that target an unexpected snapshot version', () => {
    const snapshot = createTableSnapshot();
    const intent = createTurnIntent({
      expectedSnapshotVersion: snapshot.index + 1,
    });

    const result = validateIntent(snapshot, intent);

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('version-mismatch');
  });

  test('rejects actions that fall outside of the legal option set', () => {
    const snapshot = createTableSnapshot();
    const intent = createTurnIntent({
      requested: { type: 'call', amount: 10 },
      expectedSnapshotVersion: snapshot.index,
    });

    const result = validateIntent(snapshot, intent);

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.reason).toBe('illegal-action');
  });
});

describe('reducer', () => {
  test('applies contributions immutably and advances the snapshot version', () => {
    const snapshot = createTableSnapshot();
    const intent = createTurnIntent({
      requested: { type: 'bet', amount: 10 },
      expectedSnapshotVersion: snapshot.index,
    });
    const validation = validateIntent(snapshot, intent);
    expect(validation.kind).toBe('accepted');
    if (validation.kind !== 'accepted') return;

    const updated = reduce(snapshot, validation.event);

    expect(updated.index).toBe(snapshot.index + 1);
    const updatedTurns = updated.hand.bettingRounds[0]
      ? updated.hand.bettingRounds[0]!.turns
      : [];
    const lastTurn = updatedTurns[updatedTurns.length - 1];
    expect(lastTurn?.id).toBe(validation.event.id);
    expect(updated.pots.main.amount).toBe(10);
    expect(updated.seating.seats[0]?.stack).toBe(
      snapshot.seating.seats[0]!.stack - 10,
    );
    expect(snapshot.hand.bettingRounds[0]?.turns.length).toBe(0);
  });

  test('initializes the next actor deadline using only the per-turn window', () => {
    const snapshot = createTableSnapshot();
    const configuredSnapshot = {
      ...snapshot,
      clock: {
        ...snapshot.clock,
        perTurnMs: 5_000,
        bankMs: {
          ...snapshot.clock.bankMs,
          'player-a': 10_000,
          'player-b': 15_000,
        },
      },
    } satisfies TableSnapshot;

    const intent = createTurnIntent({
      requested: { type: 'bet', amount: 10 },
      expectedSnapshotVersion: configuredSnapshot.index,
      issuedAt: 25_000,
    });
    const validation = validateIntent(configuredSnapshot, intent);
    expect(validation.kind).toBe('accepted');
    if (validation.kind !== 'accepted') return;

    const updated = reduce(configuredSnapshot, validation.event);

    expect(updated.clock.currentActor).toBe('player-b');
    expect(updated.clock.deadline).toBe(
      25_000 + configuredSnapshot.clock.perTurnMs,
    );
    expect(updated.clock.bankMs['player-b']).toBe(
      configuredSnapshot.clock.bankMs['player-b'],
    );
  });
});

describe('envelopes', () => {
  test('serializes, deserializes, and upcasts turn events deterministically', () => {
    const snapshot = createTableSnapshot();
    const intent = createTurnIntent({
      expectedSnapshotVersion: snapshot.index,
      requested: { type: 'check' },
    });
    const result = validateIntent(snapshot, intent);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;

    const turnUpcaster = new EnvelopeUpcaster<TurnEvent>(
      TURN_EVENT_ENVELOPE_VERSION,
    );
    turnUpcaster.register(0, (legacy: unknown) => {
      const event = legacy as TurnEvent;
      return {
        ...event,
        id: 'upcast-event',
      } satisfies TurnEvent;
    });

    const envelope = toTurnEventEnvelope(result.event);
    const serialized = JSON.stringify(envelope);
    const parsed = JSON.parse(serialized) as typeof envelope;
    const upgraded = fromTurnEventEnvelope(
      {
        ...parsed,
        envelopeVersion: 0,
      },
      turnUpcaster,
    );

    expect(upgraded.id).toBe('upcast-event');
  });

  test('serializes and upcasts snapshots using registered adapters', () => {
    const snapshot = createTableSnapshot();

    const snapshotUpcaster = new EnvelopeUpcaster<TableSnapshot>(
      SNAPSHOT_ENVELOPE_VERSION,
    );
    snapshotUpcaster.register(0, (legacy: unknown) => {
      const snapshotPayload = legacy as TableSnapshot;
      return {
        ...snapshotPayload,
        index: snapshot.index,
      } satisfies TableSnapshot;
    });

    const envelope = toSnapshotEnvelope(snapshot);
    const serialized = JSON.stringify(envelope);
    const parsed = JSON.parse(serialized) as typeof envelope;
    const upgraded = fromSnapshotEnvelope(
      {
        ...parsed,
        envelopeVersion: 0,
      },
      snapshotUpcaster,
    );

    expect(upgraded.index).toBe(snapshot.index);
  });
});
