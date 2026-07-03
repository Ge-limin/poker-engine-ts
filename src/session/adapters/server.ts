import {
  toSnapshotEnvelope,
  toTurnEventEnvelope,
} from '../../core/envelopes/index';
import { IllegalIntentError } from '../../core/errors';
import { reduce } from '../../core/reducer/index';
import { applyAutoRunout } from '../auto-runout';
import type { SeatBootstrapConfig } from '../lifecycle';
import {
  type AdvanceHandResult,
  type ApplyIntentOptions,
  type ApplyIntentResult,
  type CreateSessionOptions,
  type ResumeSessionOptions,
  SessionManager,
  type SessionManagerOptions,
} from '../session-manager';
import type {
  ChannelDispatches,
  RuntimeDispatchBus,
} from '../../telemetry/runtime-dispatch';
import type {
  Card,
  Session,
  SessionConfig,
  SnapshotEnvelope,
  TurnEventEnvelope,
  TurnIntent,
  UUID,
} from '../../types/index';
import type { TableSnapshot } from '../../types/snapshot';

export interface SessionRepository {
  readonly get: (
    sessionId: UUID,
  ) => Promise<Session | undefined> | Session | undefined;
  readonly set: (session: Session) => Promise<void> | void;
  readonly persistInitialSession?: (
    params: SessionInitialPersistenceParams,
  ) => Promise<void> | void;
  readonly appendTurnEvent?: (
    params: SessionTurnEventPersistenceParams,
  ) => Promise<void> | void;
  readonly replaceEventsFromIndex?: (
    params: SessionReplaceEventsParams,
  ) => Promise<void> | void;
  readonly closeSessionRecord?: (session: Session) => Promise<void> | void;
}

export interface SessionInitialPersistenceParams {
  readonly session: Session;
  readonly snapshotEnvelope: SnapshotEnvelope<TableSnapshot>;
}

export interface SessionTurnEventPersistenceParams {
  readonly session: Session;
  readonly eventEnvelope: TurnEventEnvelope;
  readonly snapshotEnvelope: SnapshotEnvelope<TableSnapshot>;
  readonly eventIndex: number;
}

export interface SessionReplaceEventsParams {
  readonly session: Session;
  readonly eventIndex: number;
  readonly eventEnvelopes: readonly TurnEventEnvelope[];
  readonly snapshotEnvelopes: readonly SnapshotEnvelope<TableSnapshot>[];
}

export interface ServerSessionAdapterOptions {
  readonly repository: SessionRepository;
  readonly dispatchBus?: RuntimeDispatchBus;
  readonly managerOptions?: SessionManagerOptions;
  readonly resumeOptions?: ResumeSessionOptions;
}

export interface ServerSessionAdapter {
  readonly dispatchBus?: RuntimeDispatchBus;
  readonly createSession: (
    config: SessionConfig,
    seats: readonly SeatBootstrapConfig[],
    options?: CreateSessionOptions,
  ) => Promise<Session>;
  readonly resumeSession: (
    session: Session,
    options?: ResumeSessionOptions,
  ) => Promise<Session>;
  readonly applyTurnIntent: (
    sessionId: UUID,
    intent: TurnIntent,
    options?: ApplyIntentOptions,
  ) => Promise<ApplyIntentResult>;
  readonly advanceHand: (
    sessionId: UUID,
    deck?: readonly Card[],
  ) => Promise<AdvanceHandResult>;
  readonly rewindTo: (sessionId: UUID, eventIndex: number) => Promise<Session>;
  readonly replaceFrom: (
    sessionId: UUID,
    eventIndex: number,
    envelopes: readonly TurnEventEnvelope[],
  ) => Promise<Session>;
  readonly closeSession: (sessionId: UUID) => Promise<Session>;
  readonly getSession: (sessionId: UUID) => Promise<Session | undefined>;
}

export function createServerSessionAdapter(
  options: ServerSessionAdapterOptions,
): ServerSessionAdapter {
  const managers = new Map<UUID, SessionManager>();

  async function persist(session: Session): Promise<void> {
    await Promise.resolve(options.repository.set(session));
  }

  async function persistInitial(session: Session): Promise<void> {
    const snapshotEnvelope = toSnapshotEnvelope(session.initialSnapshot);
    if (options.repository.persistInitialSession) {
      await Promise.resolve(
        options.repository.persistInitialSession({
          session,
          snapshotEnvelope,
        }),
      );
      return;
    }
    await persist(session);
  }

  async function appendTurnEvent(
    params: SessionTurnEventPersistenceParams,
  ): Promise<void> {
    if (options.repository.appendTurnEvent) {
      await Promise.resolve(options.repository.appendTurnEvent(params));
      return;
    }
    await persist(params.session);
  }

  async function replaceEventsFromIndex(
    params: SessionReplaceEventsParams,
  ): Promise<void> {
    if (options.repository.replaceEventsFromIndex) {
      await Promise.resolve(options.repository.replaceEventsFromIndex(params));
      return;
    }
    await persist(params.session);
  }

  async function closeSessionRecord(session: Session): Promise<void> {
    if (options.repository.closeSessionRecord) {
      await Promise.resolve(options.repository.closeSessionRecord(session));
      return;
    }
    await persist(session);
  }

  function deriveSnapshotEnvelopes(
    session: Session,
    startIndex = 0,
  ): SnapshotEnvelope<TableSnapshot>[] {
    let workingSnapshot = session.initialSnapshot;
    const envelopes: SnapshotEnvelope<TableSnapshot>[] = [];
    session.events.forEach((event, index) => {
      const reduced = reduce(workingSnapshot, event);
      const runout = applyAutoRunout({
        snapshot: reduced,
        config: session.config,
        recentEvent: event,
        timestamp: event.timestamp,
      });
      workingSnapshot = runout.snapshot;
      if (index >= startIndex) {
        envelopes.push(toSnapshotEnvelope(runout.snapshot));
      }
    });
    return envelopes;
  }

  async function loadSession(sessionId: UUID): Promise<SessionManager> {
    const existing = managers.get(sessionId);
    if (existing) {
      return existing;
    }

    const stored = await Promise.resolve(options.repository.get(sessionId));
    if (!stored) {
      throw new IllegalIntentError('Session not found', { sessionId });
    }

    const manager = SessionManager.resume(
      {
        sessionId: stored.id,
        config: stored.config,
        runtimeContext: stored.runtimeContext,
        initialSnapshot: toSnapshotEnvelope(stored.initialSnapshot),
        events: stored.events.map((event) => toTurnEventEnvelope(event)),
        metrics: stored.metrics,
        channels: stored.channels,
        hooks: stored.hooks,
      },
      options.resumeOptions,
    );
    managers.set(stored.id, manager);
    return manager;
  }

  async function dispatch(envelopes: ChannelDispatches): Promise<void> {
    if (!options.dispatchBus) {
      return;
    }
    await options.dispatchBus.dispatch(envelopes);
  }

  async function createSession(
    config: SessionConfig,
    seats: readonly SeatBootstrapConfig[],
    callOptions: CreateSessionOptions = {},
  ): Promise<Session> {
    const manager = SessionManager.create(config, seats, {
      ...options.managerOptions,
      ...callOptions,
    });
    managers.set(manager.session.id, manager);
    await persistInitial(manager.session);
    return manager.session;
  }

  async function resumeSession(
    session: Session,
    callOptions: ResumeSessionOptions = {},
  ): Promise<Session> {
    const manager = SessionManager.resume(
      {
        sessionId: session.id,
        config: session.config,
        runtimeContext: session.runtimeContext,
        initialSnapshot: toSnapshotEnvelope(session.initialSnapshot),
        events: session.events.map((event) => toTurnEventEnvelope(event)),
        metrics: session.metrics,
        channels: session.channels,
        hooks: session.hooks,
      },
      { ...options.resumeOptions, ...callOptions },
    );
    managers.set(session.id, manager);
    await persist(manager.session);
    return manager.session;
  }

  async function applyTurnIntent(
    sessionId: UUID,
    intent: TurnIntent,
    callOptions: ApplyIntentOptions = {},
  ): Promise<ApplyIntentResult> {
    const manager = await loadSession(sessionId);
    const revertPayload = {
      sessionId: manager.session.id,
      config: manager.session.config,
      runtimeContext: manager.session.runtimeContext,
      initialSnapshot: toSnapshotEnvelope(manager.session.initialSnapshot),
      events: manager.eventLog.slice(),
      metrics: manager.session.metrics,
      channels: manager.session.channels,
      hooks: manager.session.hooks,
    };
    const result = await manager.applyIntent(intent, callOptions);
    if (result.eventEnvelope && result.snapshotEnvelope) {
      try {
        await appendTurnEvent({
          session: manager.session,
          eventEnvelope: result.eventEnvelope,
          snapshotEnvelope: result.snapshotEnvelope,
          eventIndex: manager.session.events.length - 1,
        });
      } catch (error) {
        const restoredManager = SessionManager.resume(
          {
            sessionId: revertPayload.sessionId,
            config: revertPayload.config,
            runtimeContext: revertPayload.runtimeContext,
            initialSnapshot: revertPayload.initialSnapshot,
            events: revertPayload.events,
            metrics: revertPayload.metrics,
            channels: revertPayload.channels,
            hooks: revertPayload.hooks,
          },
          options.resumeOptions,
        );
        managers.set(sessionId, restoredManager);
        throw error;
      }
    } else {
      await persist(manager.session);
    }
    await dispatch(result.channels);
    return result;
  }

  async function advanceHand(
    sessionId: UUID,
    deck?: readonly Card[],
  ): Promise<AdvanceHandResult> {
    const manager = await loadSession(sessionId);
    const result = await manager.advanceHand(deck);
    await persistInitial(manager.session);
    return result;
  }

  async function rewindTo(
    sessionId: UUID,
    eventIndex: number,
  ): Promise<Session> {
    const manager = await loadSession(sessionId);
    const session = await manager.rewindTo(eventIndex);
    const eventEnvelopes = session.events
      .slice(eventIndex)
      .map((event) => toTurnEventEnvelope(event));
    const snapshotEnvelopes = deriveSnapshotEnvelopes(session, eventIndex);
    await replaceEventsFromIndex({
      session,
      eventIndex,
      eventEnvelopes,
      snapshotEnvelopes,
    });
    return session;
  }

  async function replaceFrom(
    sessionId: UUID,
    eventIndex: number,
    envelopes: readonly TurnEventEnvelope[],
  ): Promise<Session> {
    const manager = await loadSession(sessionId);
    const session = await manager.replaceFrom(eventIndex, envelopes);
    const eventEnvelopes = session.events
      .slice(eventIndex)
      .map((event) => toTurnEventEnvelope(event));
    const snapshotEnvelopes = deriveSnapshotEnvelopes(session, eventIndex);
    await replaceEventsFromIndex({
      session,
      eventIndex,
      eventEnvelopes,
      snapshotEnvelopes,
    });
    return session;
  }

  async function closeSession(sessionId: UUID): Promise<Session> {
    const manager = await loadSession(sessionId);
    const session = await manager.closeSession();
    await closeSessionRecord(session);
    return session;
  }

  async function getSession(sessionId: UUID): Promise<Session | undefined> {
    const manager = managers.get(sessionId);
    if (manager) {
      return manager.session;
    }
    return Promise.resolve(options.repository.get(sessionId));
  }

  return {
    dispatchBus: options.dispatchBus,
    createSession,
    resumeSession,
    applyTurnIntent,
    advanceHand,
    rewindTo,
    replaceFrom,
    closeSession,
    getSession,
  } satisfies ServerSessionAdapter;
}
