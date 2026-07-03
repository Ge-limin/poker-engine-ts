import type { SupabaseClient } from '@supabase/supabase-js';

import {
  toSnapshotEnvelope,
  toTurnEventEnvelope,
} from '../../core/envelopes/index';
import { reduce } from '../../core/reducer/index';
import { applyAutoRunout } from '../../session/auto-runout';
import type {
  Session,
  SessionChannels,
  SessionConfig,
  SessionMetrics,
  SnapshotEnvelope,
  TurnEventEnvelope,
  UUID,
} from '../../types/index';
import type {
  EngineHooks,
  RuntimeContext,
} from '../../types/session';
import type { TableSnapshot } from '../../types/snapshot';
import type { Database } from './database';

import type {
  SessionInitialPersistenceParams,
  SessionReplaceEventsParams,
  SessionRepository,
  SessionTurnEventPersistenceParams,
} from '../../session/adapters/server';
import {
  type AppendEngineHandEventParams,
  type EngineHandEventRecord,
  type EngineHandSnapshotRecord,
  type SupabaseEngineHandStore,
  type SupabaseEngineHandStoreOptions,
  createSupabaseEngineHandStore,
} from './engine-hand-store';

export interface SessionDefinition {
  readonly config: SessionConfig;
  readonly runtimeContext: RuntimeContext;
  readonly metrics: SessionMetrics;
  readonly channels: SessionChannels;
  readonly hooks?: EngineHooks;
}

export interface SupabaseSessionRepositoryOptions {
  readonly client: SupabaseClient<Database>;
  readonly loadSessionDefinition: (
    sessionId: UUID,
  ) => Promise<SessionDefinition | undefined>;
  readonly persistSessionDefinition?: (session: Session) => Promise<void>;
  readonly handStore?: SupabaseEngineHandStore;
}

interface SessionEventEntry {
  readonly eventIndex: number;
  readonly eventEnvelope: TurnEventEnvelope;
  readonly snapshotEnvelope: SnapshotEnvelope<TableSnapshot>;
}

export function createSupabaseSessionRepository(
  options: SupabaseSessionRepositoryOptions,
): SessionRepository {
  const handStore =
    options.handStore ??
    createSupabaseEngineHandStore({
      client: options.client,
    } satisfies SupabaseEngineHandStoreOptions);

  async function get(sessionId: UUID): Promise<Session | undefined> {
    const definition = await options.loadSessionDefinition(sessionId);
    if (!definition) {
      return undefined;
    }

    const persisted = await handStore.load(sessionId);
    if (!persisted) {
      return undefined;
    }

    return resumeSessionFromStorage(sessionId, definition, persisted);
  }

  async function set(session: Session): Promise<void> {
    const snapshotRecord: EngineHandSnapshotRecord = {
      handId: session.id,
      snapshotEnvelope: toSnapshotEnvelope(session.initialSnapshot),
    };
    await handStore.persistInitialSnapshot(snapshotRecord);

    const events = deriveSessionEventEntries(session);
    await handStore.replaceEventLog({ handId: session.id, events });
    await persistDefinition(session);
  }

  async function persistInitialSession(
    params: SessionInitialPersistenceParams,
  ): Promise<void> {
    await handStore.persistInitialSnapshot({
      handId: params.session.id,
      snapshotEnvelope: params.snapshotEnvelope,
    });
    await persistDefinition(params.session);
  }

  async function appendTurnEvent(
    params: SessionTurnEventPersistenceParams,
  ): Promise<void> {
    const appendParams: AppendEngineHandEventParams = {
      handId: params.session.id,
      eventIndex: params.eventIndex,
      eventEnvelope: params.eventEnvelope,
      snapshotEnvelope: params.snapshotEnvelope,
    };
    const appendedEvent = await handStore.appendEvent(appendParams);
    try {
      await persistDefinition(params.session);
    } catch (persistError) {
      try {
        await handStore.deleteEventById(appendedEvent.id);
      } catch (cleanupError) {
        const rollbackError = new Error(
          'Failed to roll back engine hand event after session definition persistence error.',
        );
        (rollbackError as { cause?: unknown }).cause = {
          persistError,
          cleanupError,
        };
        throw rollbackError;
      }
      throw persistError;
    }
  }

  async function replaceEventsFromIndex(
    params: SessionReplaceEventsParams,
  ): Promise<void> {
    const events = deriveSessionEventEntries(params.session);
    await handStore.replaceEventLog({ handId: params.session.id, events });
    await persistDefinition(params.session);
  }

  async function closeSessionRecord(session: Session): Promise<void> {
    await persistDefinition(session);
  }

  async function persistDefinition(session: Session): Promise<void> {
    if (!options.persistSessionDefinition) {
      return;
    }
    await options.persistSessionDefinition(session);
  }

  return {
    get,
    set,
    persistInitialSession,
    appendTurnEvent,
    replaceEventsFromIndex,
    closeSessionRecord,
  } satisfies SessionRepository;
}

function resumeSessionFromStorage(
  sessionId: UUID,
  definition: SessionDefinition,
  persisted: {
    readonly snapshot: EngineHandSnapshotRecord;
    readonly events: readonly EngineHandEventRecord[];
  },
): Session {
  const initialSnapshotEnvelope = persisted.snapshot.snapshotEnvelope;
  const events = persisted.events.map((event) => event.eventEnvelope.event);
  const activeSnapshotEnvelope = persisted.events.length
    ? persisted.events[persisted.events.length - 1]!.snapshotEnvelope
    : initialSnapshotEnvelope;

  const session: Session = {
    id: sessionId,
    config: definition.config,
    runtimeContext: definition.runtimeContext,
    initialSnapshot: initialSnapshotEnvelope.snapshot,
    events,
    activeSnapshot: activeSnapshotEnvelope.snapshot,
    metrics: definition.metrics,
    channels: definition.channels,
    hooks: definition.hooks ?? {},
  } satisfies Session;

  return session;
}

function deriveSessionEventEntries(session: Session): SessionEventEntry[] {
  const entries: SessionEventEntry[] = [];
  let workingSnapshot = session.initialSnapshot;

  session.events.forEach((event, index) => {
    const reduced = reduce(workingSnapshot, event);
    const runout = applyAutoRunout({
      snapshot: reduced,
      config: session.config,
      recentEvent: event,
      timestamp: event.timestamp,
    });
    workingSnapshot = runout.snapshot;
    entries.push({
      eventIndex: index,
      eventEnvelope: toTurnEventEnvelope(event),
      snapshotEnvelope: toSnapshotEnvelope(runout.snapshot),
    });
  });

  return entries;
}
