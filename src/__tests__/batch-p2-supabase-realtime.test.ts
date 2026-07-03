import type { RealtimeChannel } from '@supabase/supabase-js';

import { describe, expect, it, vi } from 'vitest';

import {
  createRuntimeDispatchBus,
  createRuntimeDispatchMetadata,
  toSnapshotEnvelope,
  toTurnEventEnvelope,
} from '../index';
import type {
  PersonaProfile,
  TelemetryEventView,
  TurnEvent,
} from '../types/index';
import type { TableSnapshot } from '../types/snapshot';

import { createSupabaseRealtimeSink } from '../persistence/supabase/realtime-sink';

const TEST_METADATA = createRuntimeDispatchMetadata({ mode: 'live' });
const TEST_TIMESTAMP = Date.UTC(2025, 1, 5, 8, 15, 0);

describe('@batch(P2) supabase realtime sink', () => {
  it('broadcasts telemetry, replay, and advisory events with namespaced topics', async () => {
    const channel = createFakeChannel();
    const sink = createSupabaseRealtimeSink({
      client: { channel: () => channel },
      channelName: 'engine:session:123',
      eventPrefix: 'engine-test',
    });

    const bus = createRuntimeDispatchBus();
    bus.register(sink);

    const snapshot = createSnapshot();
    const telemetryEvent = createTelemetryEvent(snapshot);
    const turnEvent = createTurnEvent();

    await bus.dispatch({
      telemetry: {
        channel: {
          provider: 'noop',
          streamId: 'stream',
          batching: { maxBatch: 1, flushMs: 1 },
        },
        event: telemetryEvent,
        metadata: TEST_METADATA,
      },
      replay: {
        channel: { transport: 'filesystem', retentionHands: 1 },
        event: toTurnEventEnvelope(turnEvent),
        snapshot: toSnapshotEnvelope(snapshot),
        metadata: TEST_METADATA,
      },
      advisory: {
        channel: { requestTopic: 'req', responseTopic: 'res', timeoutMs: 1 },
        metadata: TEST_METADATA,
      },
    });

    expect(channel.sent).toEqual([
      {
        type: 'broadcast',
        event: 'engine-test.telemetry',
        payload: expect.objectContaining({ metadata: TEST_METADATA }),
      },
      {
        type: 'broadcast',
        event: 'engine-test.replay',
        payload: expect.objectContaining({ metadata: TEST_METADATA }),
      },
      {
        type: 'broadcast',
        event: 'engine-test.advisory',
        payload: expect.objectContaining({ metadata: TEST_METADATA }),
      },
    ]);
  });
});

function createFakeChannel(): RealtimeChannel & { sent: unknown[] } {
  const sent: unknown[] = [];
  const channel = {
    send: vi.fn(async (payload: unknown) => {
      sent.push(payload);
      return { status: 'ok' };
    }),
    subscribe: vi.fn((callback?: (status: string) => void) => {
      if (callback) {
        queueMicrotask(() => callback('SUBSCRIBED'));
      }
      return channel as unknown as RealtimeChannel;
    }),
    sent,
  };

  return channel as unknown as RealtimeChannel & { sent: unknown[] };
}

function createSnapshot(): TableSnapshot {
  return {
    index: 1,
    handNumber: 1,
    seating: {
      dealerButton: 0,
      seats: [
        {
          index: 0,
          occupant: { playerId: 'hero', displayName: 'Hero' },
          status: 'occupied',
          stack: 99,
        },
        {
          index: 1,
          occupant: { playerId: 'villain', displayName: 'Villain' },
          status: 'occupied',
          stack: 98,
        },
      ],
    },
    hand: {
      id: 'hand-1',
      stage: 'preflop',
      deckSeed: 'seed',
      buttonSeat: 0,
      blinds: {
        smallBlind: { playerId: 'hero', amount: 1 },
        bigBlind: { playerId: 'villain', amount: 2 },
      },
      ante: null,
      bettingRounds: [
        {
          stage: 'preflop',
          turnOrder: [1, 0],
          turns: [],
          roundPot: 3,
          highestBet: 2,
          lastAggressor: 'villain',
        },
      ],
    },
    pots: {
      main: {
        id: 'main',
        amount: 3,
        eligiblePlayers: ['hero', 'villain'],
        contributions: { hero: 1, villain: 2 },
      },
      sides: [],
      rake: 0,
    },
    cards: {
      remainingDeck: [],
      burnPile: [],
      community: { revealSchedule: [] },
      holeCards: {
        hero: ['Ah', 'Kd'],
        villain: ['Qc', 'Qs'],
      },
    },
    personas: {
      entries: {
        hero: createPersonaProfileEntry('hero'),
        villain: createPersonaProfileEntry('villain'),
      },
    },
    clock: {
      currentActor: 'hero',
      deadline: TEST_TIMESTAMP + 5_000,
      perTurnMs: 0,
      bankMs: { hero: 0, villain: 0 },
      pauses: [],
    },
    flags: {
      showdownLocked: false,
      autoRunout: false,
      pendingEliminations: [],
      rebuyAvailable: false,
      advisoryPending: false,
      recoveryMode: false,
    },
  } satisfies TableSnapshot;
}

function createTurnEvent(): TurnEvent {
  return {
    id: 'turn-1',
    actor: 'hero',
    action: { type: 'check' },
    legalOptions: [{ type: 'check' }],
    stackBefore: 100,
    stackAfter: 100,
    contribution: 0,
    timestamp: TEST_TIMESTAMP,
    metadata: {
      engineVersion: 'test',
      availableActionsAtDecision: [{ type: 'check' }],
    },
  } satisfies TurnEvent;
}

function createTelemetryEvent(snapshot: TableSnapshot): TelemetryEventView {
  return {
    sessionId: 'session-1',
    eventId: 'turn-1',
    eventIndex: 0,
    handNumber: snapshot.handNumber,
    handStage: snapshot.hand.stage,
    snapshotVersion: snapshot.index,
    actor: 'hero',
    action: { type: 'check' },
    stackBefore: 100,
    stackAfter: 100,
    contribution: 0,
    potBefore: snapshot.pots.main.amount,
    potTotal: snapshot.pots.main.amount,
    potDelta: 0,
    runtimeMode: 'live',
    occurredAt: TEST_TIMESTAMP,
    metadata: {
      engineVersion: 'test',
      availableActionsAtDecision: [{ type: 'check' }],
    },
    legalOptions: [{ type: 'check' }],
    availableActionsAtDecision: [{ type: 'check' }],
    personaAdjustments: [],
    clock: {
      currentActor: snapshot.clock.currentActor,
      deadline: snapshot.clock.deadline,
      perTurnMs: snapshot.clock.perTurnMs,
      bankMs: snapshot.clock.bankMs,
    },
    handFlags: {
      showdownLocked: snapshot.flags.showdownLocked,
      autoRunout: snapshot.flags.autoRunout,
      advisoryPending: snapshot.flags.advisoryPending,
    },
  } satisfies TelemetryEventView;
}

function createPersonaProfileEntry(playerId: string): PersonaProfile {
  return {
    personaId: `persona-${playerId}`,
    style: 'balanced',
    aggression: 50,
    tightness: 50,
    bluffIndex: 50,
    riskTolerance: 50,
    adaptation: {
      trackedMetrics: {
        vpip: 0,
        pfr: 0,
        aggressionFactor: 0,
        showdownRate: 0,
        tiltIndicator: 0,
      },
      lastUpdated: TEST_TIMESTAMP,
      featureVector: [0.5, 0.5, 0.5, 0.5],
    },
  } satisfies PersonaProfile;
}
