import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  SnapshotEnvelope,
  TurnEventEnvelope,
} from '../../types/index';
import type { TableSnapshot } from '../../types/snapshot';
import type { Database, Json } from './database';

export interface EngineHandEventPayload {
  readonly event: TurnEventEnvelope;
  readonly snapshot: SnapshotEnvelope<TableSnapshot>;
}

export interface EngineHandEventRecord {
  readonly id: string;
  readonly engineHandId: string;
  readonly eventIndex: number;
  readonly occurredAt: string;
  readonly eventEnvelope: TurnEventEnvelope;
  readonly snapshotEnvelope: SnapshotEnvelope<TableSnapshot>;
}

export interface EngineHandSnapshotRecord {
  readonly handId: string;
  readonly snapshotEnvelope: SnapshotEnvelope<TableSnapshot>;
}

export interface EngineHandStoreLoadResult {
  readonly snapshot: EngineHandSnapshotRecord;
  readonly events: readonly EngineHandEventRecord[];
}

export interface AppendEngineHandEventParams {
  readonly handId: string;
  readonly eventIndex: number;
  readonly eventEnvelope: TurnEventEnvelope;
  readonly snapshotEnvelope: SnapshotEnvelope<TableSnapshot>;
}

export interface ReplaceEngineHandEventLogParams {
  readonly handId: string;
  readonly events: readonly {
    readonly eventIndex: number;
    readonly eventEnvelope: TurnEventEnvelope;
    readonly snapshotEnvelope: SnapshotEnvelope<TableSnapshot>;
  }[];
}

export interface SupabaseEngineHandStoreOptions {
  readonly client: SupabaseClient<Database>;
}

export interface SupabaseEngineHandStore {
  readonly load: (
    handId: string,
  ) => Promise<EngineHandStoreLoadResult | undefined>;
  readonly persistInitialSnapshot: (
    record: EngineHandSnapshotRecord,
  ) => Promise<void>;
  readonly appendEvent: (
    params: AppendEngineHandEventParams,
  ) => Promise<EngineHandEventRecord>;
  readonly deleteEventById: (eventId: string) => Promise<void>;
  readonly replaceEventLog: (
    params: ReplaceEngineHandEventLogParams,
  ) => Promise<void>;
  readonly deleteHand: (handId: string) => Promise<void>;
}

export class SupabasePersistenceError extends Error {
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    options?: { cause?: unknown; context?: Record<string, unknown> },
  ) {
    super(message);
    if (options?.cause) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    this.context = options?.context;
    this.name = 'SupabasePersistenceError';
  }
}

export function createSupabaseEngineHandStore(
  options: SupabaseEngineHandStoreOptions,
): SupabaseEngineHandStore {
  const client = options.client;

  async function load(
    handId: string,
  ): Promise<EngineHandStoreLoadResult | undefined> {
    const snapshot = await fetchSnapshot(handId);
    if (!snapshot) {
      return undefined;
    }

    const events = await fetchEvents(handId);
    return { snapshot, events } satisfies EngineHandStoreLoadResult;
  }

  async function persistInitialSnapshot(
    record: EngineHandSnapshotRecord,
  ): Promise<void> {
    const payload = toJson(record.snapshotEnvelope);
    const response = await client
      .from('engine_hands')
      .upsert({
        id: record.handId,
        initial_snapshot: payload,
      })
      .select('*')
      .single();

    if (response.error) {
      throw new SupabasePersistenceError(
        'Failed to persist engine hand snapshot.',
        {
          cause: response.error,
          context: { handId: record.handId },
        },
      );
    }
  }

  async function appendEvent(
    params: AppendEngineHandEventParams,
  ): Promise<EngineHandEventRecord> {
    const payload: EngineHandEventPayload = {
      event: params.eventEnvelope,
      snapshot: params.snapshotEnvelope,
    };
    const clonedPayload = toJson(payload);

    const response = await client
      .from('engine_hand_events')
      .insert({
        engine_hand_id: params.handId,
        event_index: params.eventIndex,
        payload: clonedPayload,
      })
      .select('*')
      .single();

    if (response.error || !response.data) {
      throw new SupabasePersistenceError(
        'Failed to append engine hand event.',
        {
          cause: response.error,
          context: { handId: params.handId, eventIndex: params.eventIndex },
        },
      );
    }

    return mapEventRow(response.data);
  }

  async function deleteEventById(eventId: string): Promise<void> {
    const response = await client
      .from('engine_hand_events')
      .delete()
      .eq('id', eventId);
    if (response.error) {
      throw new SupabasePersistenceError(
        'Failed to delete engine hand event.',
        {
          cause: response.error,
          context: { eventId },
        },
      );
    }
  }

  async function replaceEventLog(
    params: ReplaceEngineHandEventLogParams,
  ): Promise<void> {
    const existing = await fetchEventRows(params.handId);

    const cleanup = async (): Promise<void> => {
      await client
        .from('engine_hand_events')
        .delete()
        .eq('engine_hand_id', params.handId);
      if (existing.length === 0) {
        return;
      }
      const restored = existing.map((row) => ({
        engine_hand_id: row.engine_hand_id,
        event_index: row.event_index,
        payload: toJson(row.payload),
        id: row.id,
        occurred_at: row.occurred_at,
      }));
      const restoreResponse = await client
        .from('engine_hand_events')
        .insert(restored)
        .select();
      if (restoreResponse.error) {
        throw new SupabasePersistenceError(
          'Failed to restore prior engine hand events.',
          {
            cause: restoreResponse.error,
            context: { handId: params.handId },
          },
        );
      }
    };

    const inserts = params.events.map((entry) => ({
      engine_hand_id: params.handId,
      event_index: entry.eventIndex,
      payload: toJson({
        event: entry.eventEnvelope,
        snapshot: entry.snapshotEnvelope,
      }),
    }));

    try {
      await client
        .from('engine_hand_events')
        .delete()
        .eq('engine_hand_id', params.handId);

      if (inserts.length === 0) {
        return;
      }

      const response = await client
        .from('engine_hand_events')
        .insert(inserts)
        .select();
      if (response.error) {
        throw response.error;
      }
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new SupabasePersistenceError(
          'Failed to restore engine hand events after error.',
          {
            cause: cleanupError,
            context: { handId: params.handId, originalError: error },
          },
        );
      }
      throw new SupabasePersistenceError(
        'Failed to replace engine hand events.',
        {
          cause: error,
          context: { handId: params.handId },
        },
      );
    }
  }

  async function deleteHand(handId: string): Promise<void> {
    const response = await client
      .from('engine_hands')
      .delete()
      .eq('id', handId);
    if (response.error) {
      throw new SupabasePersistenceError('Failed to delete engine hand.', {
        cause: response.error,
        context: { handId },
      });
    }
  }

  async function fetchSnapshot(
    handId: string,
  ): Promise<EngineHandSnapshotRecord | undefined> {
    const response = await client
      .from('engine_hands')
      .select('*')
      .eq('id', handId)
      .single();

    if (response.error) {
      if (response.status === 406 || response.status === 404) {
        return undefined;
      }
      throw new SupabasePersistenceError(
        'Failed to load engine hand snapshot.',
        {
          cause: response.error,
          context: { handId },
        },
      );
    }

    const envelope = parseSnapshotEnvelope(
      handId,
      response.data?.initial_snapshot,
    );

    return {
      handId,
      snapshotEnvelope: envelope,
    } satisfies EngineHandSnapshotRecord;
  }

  async function fetchEvents(handId: string): Promise<EngineHandEventRecord[]> {
    const response = await fetchEventRows(handId);
    return response.map(mapEventRow);
  }

  async function fetchEventRows(
    handId: string,
  ): Promise<Database['public']['Tables']['engine_hand_events']['Row'][]> {
    const response = await client
      .from('engine_hand_events')
      .select('*')
      .eq('engine_hand_id', handId)
      .order('event_index', { ascending: true });

    if (response.error) {
      throw new SupabasePersistenceError('Failed to load engine hand events.', {
        cause: response.error,
        context: { handId },
      });
    }

    return (response.data ??
      []) as Database['public']['Tables']['engine_hand_events']['Row'][];
  }

  return {
    load,
    persistInitialSnapshot,
    appendEvent,
    deleteEventById,
    replaceEventLog,
    deleteHand,
  } satisfies SupabaseEngineHandStore;
}

function cloneJson<TValue>(value: TValue): TValue {
  return structuredClone(value);
}

function toJson<TValue>(value: TValue): Json {
  return cloneJson(value) as unknown as Json;
}

function mapEventRow(
  row: Database['public']['Tables']['engine_hand_events']['Row'],
): EngineHandEventRecord {
  const payload = parseEventPayload(row.engine_hand_id, row.id, row.payload);
  return {
    id: row.id,
    engineHandId: row.engine_hand_id,
    eventIndex: row.event_index,
    occurredAt: row.occurred_at,
    eventEnvelope: payload.event,
    snapshotEnvelope: payload.snapshot,
  } satisfies EngineHandEventRecord;
}

function parseSnapshotEnvelope(
  handId: string,
  raw: unknown,
): SnapshotEnvelope<TableSnapshot> {
  if (!isRecord(raw)) {
    throw new SupabasePersistenceError(
      'Engine hand snapshot payload malformed.',
      {
        context: { handId },
      },
    );
  }

  const envelopeVersion = raw.envelopeVersion;
  const snapshot = (raw as { snapshot?: unknown }).snapshot;

  if (typeof envelopeVersion !== 'number' || !isRecord(snapshot)) {
    throw new SupabasePersistenceError(
      'Engine hand snapshot payload malformed.',
      {
        context: { handId },
      },
    );
  }

  const typedSnapshot = snapshot as unknown as TableSnapshot;
  if (typeof typedSnapshot.index !== 'number') {
    throw new SupabasePersistenceError(
      'Engine hand snapshot payload malformed.',
      {
        context: { handId },
      },
    );
  }

  return {
    envelopeVersion,
    snapshot: typedSnapshot,
  } satisfies SnapshotEnvelope<TableSnapshot>;
}

function parseEventPayload(
  handId: string,
  rowId: string,
  raw: unknown,
): EngineHandEventPayload {
  if (!isRecord(raw)) {
    throw new SupabasePersistenceError('Engine hand event payload malformed.', {
      context: { handId, rowId },
    });
  }

  const eventEnvelope = (raw as { event?: unknown }).event;
  const snapshotEnvelope = (raw as { snapshot?: unknown }).snapshot;

  if (!isRecord(eventEnvelope) || !isRecord(snapshotEnvelope)) {
    throw new SupabasePersistenceError('Engine hand event payload malformed.', {
      context: { handId, rowId },
    });
  }

  const eventVersion = eventEnvelope.envelopeVersion;
  const event = (eventEnvelope as { event?: unknown }).event;
  const snapshotVersion = snapshotEnvelope.envelopeVersion;
  const snapshot = (snapshotEnvelope as { snapshot?: unknown }).snapshot;

  if (
    typeof eventVersion !== 'number' ||
    !isRecord(event) ||
    typeof snapshotVersion !== 'number' ||
    !isRecord(snapshot)
  ) {
    throw new SupabasePersistenceError('Engine hand event payload malformed.', {
      context: { handId, rowId },
    });
  }

  const typedSnapshot = snapshot as unknown as TableSnapshot;
  if (typeof typedSnapshot.index !== 'number') {
    throw new SupabasePersistenceError('Engine hand event payload malformed.', {
      context: { handId, rowId },
    });
  }

  const eventEnvelopeTyped = {
    envelopeVersion: eventVersion,
    event: event as unknown as TurnEventEnvelope['event'],
  } satisfies TurnEventEnvelope;

  const snapshotEnvelopeTyped = {
    envelopeVersion: snapshotVersion,
    snapshot: typedSnapshot,
  } satisfies SnapshotEnvelope<TableSnapshot>;

  return {
    event: eventEnvelopeTyped,
    snapshot: snapshotEnvelopeTyped,
  } satisfies EngineHandEventPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
