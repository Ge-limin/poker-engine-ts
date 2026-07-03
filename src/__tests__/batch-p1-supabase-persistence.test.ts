import type { SupabaseClient } from '@supabase/supabase-js';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  type SeatBootstrapConfig,
  type Session,
  type SessionConfig,
  createServerSessionAdapter,
  toSnapshotEnvelope,
  toTurnEventEnvelope,
} from '../index';
import { selectDecisionContext } from '../session/selectors';
import { createRuntimeDispatchBus } from '../telemetry/runtime-dispatch';
import type {
  PersonaProfile,
  TurnEvent,
  TurnIntent,
} from '../types/index';
import type { TableSnapshot } from '../types/snapshot';
import type { Database } from '../persistence/supabase/database';

import { createSupabaseEngineHandStore } from '../persistence/supabase/engine-hand-store';
import { createSupabaseSessionRepository } from '../persistence/supabase/session-repository';
import type { SessionDefinition } from '../persistence/supabase/session-repository';

const TEST_TIMESTAMP = new Date('2025-02-05T08:15:00.000Z');

describe('@batch(P1) supabase persistence store', () => {
  let store: InMemorySupabase;
  let baseline: Map<string, SessionDefinition>;

  beforeEach(() => {
    store = new InMemorySupabase();
    baseline = new Map();
  });

  it('persists initial snapshot and appends events atomically', async () => {
    const handStore = createSupabaseEngineHandStore({ client: store.client });
    const snapshotEnvelope = toSnapshotEnvelope(createSnapshot());
    await handStore.persistInitialSnapshot({
      handId: 'hand-1',
      snapshotEnvelope,
    });

    store.failNext('engine_hand_events', 'insert', new Error('fail'));
    const eventEnvelope = toTurnEventEnvelope(createEvent());

    await expect(
      handStore.appendEvent({
        handId: 'hand-1',
        eventIndex: 0,
        eventEnvelope,
        snapshotEnvelope,
      }),
    ).rejects.toThrow('fail');

    expect(store.getTable('engine_hand_events')).toHaveLength(0);

    await handStore.appendEvent({
      handId: 'hand-1',
      eventIndex: 0,
      eventEnvelope,
      snapshotEnvelope,
    });

    expect(store.getTable('engine_hand_events')).toHaveLength(1);
  });

  it('reloads session state from stored snapshot and events', async () => {
    const repository = createRepository();
    const adapter = createServerSessionAdapter({
      repository,
      dispatchBus: createRuntimeDispatchBus(),
    });

    const session = await adapter.createSession(createConfig(), createSeats());

    const decision = selectDecisionContext(session);
    const intent = buildIntent(decision, session, Date.now());
    await adapter.applyTurnIntent(session.id, intent);

    const reloadedRepository = createRepository();
    const freshAdapter = createServerSessionAdapter({
      repository: reloadedRepository,
      dispatchBus: createRuntimeDispatchBus(),
    });

    const loaded = await freshAdapter.getSession(session.id);
    expect(loaded).toBeDefined();
    expect(loaded?.events).toHaveLength(1);
    expect(loaded?.activeSnapshot.index).toBeGreaterThan(
      session.activeSnapshot.index,
    );
  });

  it('rolls back appended events when session definition persistence fails', async () => {
    let failNextDefinitionWrite = true;
    const repository = createSupabaseSessionRepository({
      client: store.client,
      handStore: createSupabaseEngineHandStore({ client: store.client }),
      loadSessionDefinition: async (sessionId) => baseline.get(sessionId),
      persistSessionDefinition: async (session) => {
        if (failNextDefinitionWrite && session.events.length > 0) {
          failNextDefinitionWrite = false;
          throw new Error('definition write failed');
        }
        await persistDefinitionSnapshot(session);
      },
    });

    const adapter = createServerSessionAdapter({
      repository,
      dispatchBus: createRuntimeDispatchBus(),
    });

    const session = await adapter.createSession(createConfig(), createSeats());
    const initialDecision = selectDecisionContext(session);
    const initialIntent = buildIntent(initialDecision, session, Date.now());

    await expect(
      adapter.applyTurnIntent(session.id, initialIntent),
    ).rejects.toThrow('definition write failed');

    expect(store.getTable('engine_hand_events')).toHaveLength(0);

    const postFailureSession = await adapter.getSession(session.id);
    expect(postFailureSession?.events).toHaveLength(0);

    const retryDecision = selectDecisionContext(postFailureSession!);
    const retryIntent = buildIntent(
      retryDecision,
      postFailureSession!,
      Date.now() + 1,
    );
    await adapter.applyTurnIntent(session.id, retryIntent);

    expect(store.getTable('engine_hand_events')).toHaveLength(1);
  });

  function createRepository() {
    const client = store.client;
    return createSupabaseSessionRepository({
      client,
      loadSessionDefinition: async (sessionId) => baseline.get(sessionId),
      persistSessionDefinition: persistDefinitionSnapshot,
    });
  }

  async function persistDefinitionSnapshot(session: Session): Promise<void> {
    baseline.set(session.id, {
      config: session.config,
      runtimeContext: session.runtimeContext,
      metrics: session.metrics,
      channels: session.channels,
      hooks: session.hooks,
    });
  }

  function createConfig(): SessionConfig {
    return {
      tableVariant: 'texas-holdem',
      bettingStructure: 'no-limit',
      maxSeats: 2,
      startingStack: 100,
      blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
      antePolicy: undefined,
      personaPolicy: { defaultStyle: 'balanced' },
      ruleSet: {
        streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
        postingOrder: ['small-blind', 'big-blind'],
        minRaisePolicy: 'double-last-bet',
        cardDistribution: {
          holeCardsPerPlayer: 2,
          burnPerStreet: [0, 1, 1],
          communityReveal: [0, 3, 1, 1],
        },
        showdownOrdering: 'high-card',
      },
      evaluationPolicy: {
        engine: 'lookup-table',
        evaluatorId: 'default',
        supportsHiLo: false,
        cacheSize: 1024,
      },
      simulationPolicy: undefined,
      autoAdvance: true,
    } satisfies SessionConfig;
  }

  function createSnapshot(): TableSnapshot {
    return {
      index: 0,
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
        deadline: TEST_TIMESTAMP.getTime() + 5_000,
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

  function createEvent(): TurnEvent {
    return {
      id: 'event-1',
      actor: 'hero',
      action: { type: 'check' },
      legalOptions: [{ type: 'check' }],
      stackBefore: 100,
      stackAfter: 100,
      contribution: 0,
      timestamp: TEST_TIMESTAMP.getTime(),
      metadata: {
        engineVersion: 'test',
        availableActionsAtDecision: [{ type: 'check' }],
      },
    } satisfies TurnEvent;
  }

  function createPersonaProfileEntry(playerId: string): PersonaProfile {
    const lastUpdated = TEST_TIMESTAMP.getTime();
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
        lastUpdated,
        featureVector: [0.5, 0.5, 0.5, 0.5],
      },
    } satisfies PersonaProfile;
  }

  function createSeats(): SeatBootstrapConfig[] {
    return [
      { playerId: 'hero', stack: 100, seatIndex: 0 },
      { playerId: 'villain', stack: 100, seatIndex: 1 },
    ];
  }

  function buildIntent(
    decision: ReturnType<typeof selectDecisionContext>,
    session: Session,
    issuedAt: number,
  ): TurnIntent {
    const actor = decision.actor;
    if (!actor) {
      throw new Error('Expected actor to be present.');
    }
    const option = decision.availableActions.find((entry) => !entry.disabled);
    if (!option) {
      throw new Error('Expected available action.');
    }
    switch (option.type) {
      case 'fold':
        return {
          id: `${actor}-fold-${issuedAt}`,
          actor,
          requested: { type: 'fold' },
          origin: 'ui',
          issuedAt,
          expectedSnapshotVersion: session.activeSnapshot.index,
        } satisfies TurnIntent;
      case 'check':
        return {
          id: `${actor}-check-${issuedAt}`,
          actor,
          requested: { type: 'check' },
          origin: 'ui',
          issuedAt,
          expectedSnapshotVersion: session.activeSnapshot.index,
        } satisfies TurnIntent;
      case 'call':
        return {
          id: `${actor}-call-${issuedAt}`,
          actor,
          requested: { type: 'call', amount: option.amount },
          origin: 'ui',
          issuedAt,
          expectedSnapshotVersion: session.activeSnapshot.index,
        } satisfies TurnIntent;
      case 'bet':
        return {
          id: `${actor}-bet-${issuedAt}`,
          actor,
          requested: { type: 'bet', amount: option.min },
          origin: 'ui',
          issuedAt,
          expectedSnapshotVersion: session.activeSnapshot.index,
        } satisfies TurnIntent;
      case 'raise':
        return {
          id: `${actor}-raise-${issuedAt}`,
          actor,
          requested: { type: 'raise', amount: option.min },
          origin: 'ui',
          issuedAt,
          expectedSnapshotVersion: session.activeSnapshot.index,
        } satisfies TurnIntent;
      default:
        throw new Error(`Unsupported option: ${option.type}`);
    }
  }

  type TableName = 'engine_hands' | 'engine_hand_events';
  type MutationOperation = 'insert' | 'upsert' | 'delete';

  type FailureRule = {
    readonly table: TableName;
    readonly operation: MutationOperation;
    readonly error: Error;
  };

  class InMemorySupabase {
    readonly client: SupabaseClient<Database>;
    private readonly tables: Record<TableName, Array<Record<string, unknown>>> =
      {
        engine_hands: [],
        engine_hand_events: [],
      };
    private readonly failures: FailureRule[] = [];
    private idSequence = 0;

    constructor() {
      this.client = {
        from: <TName extends TableName>(table: TName) =>
          this.createQueryBuilder(table),
      } as unknown as SupabaseClient<Database>;
    }

    getTable(name: TableName) {
      return this.tables[name].map((row) => structuredClone(row));
    }

    failNext(
      table: TableName,
      operation: MutationOperation,
      error: Error,
    ): void {
      this.failures.push({ table, operation, error });
    }

    private createQueryBuilder<TName extends TableName>(table: TName) {
      return {
        upsert: (payload: Record<string, unknown>) =>
          this.handleInsert(table, payload, 'upsert'),
        insert: (
          payload: Record<string, unknown> | Record<string, unknown>[],
        ) => this.handleInsert(table, payload, 'insert'),
        delete: () => ({
          eq: async (column: string, value: unknown) => {
            this.consumeFailure(table, 'delete');
            const current = this.tables[table];
            const remaining = current.filter((row) => row[column] !== value);
            this.tables[table] = remaining;
            return this.createResponse([]);
          },
        }),
        select: () => {
          const filters: Array<(row: Record<string, unknown>) => boolean> = [];
          const builder = {
            eq: (column: string, value: unknown) => {
              filters.push((row) => row[column] === value);
              return builder;
            },
            order: async (column: string, config: { ascending: boolean }) => {
              const rows = this.tables[table]
                .filter((row) => filters.every((predicate) => predicate(row)))
                .slice()
                .sort((a, b) => {
                  const first = Number(a[column]);
                  const second = Number(b[column]);
                  return config.ascending ? first - second : second - first;
                })
                .map((row) => structuredClone(row));
              return this.createResponse(rows);
            },
            single: async () => {
              const rows = this.tables[table].filter((row) =>
                filters.every((predicate) => predicate(row)),
              );
              const match = rows.at(0);
              if (!match) {
                return this.createSingleResponse(null, 404);
              }
              return this.createSingleResponse(structuredClone(match));
            },
          };
          return builder;
        },
      };
    }

    private handleInsert(
      table: TableName,
      payload: Record<string, unknown> | Record<string, unknown>[],
      operation: MutationOperation,
    ) {
      return {
        select: () => {
          const rows = Array.isArray(payload) ? payload : [payload];
          const inserted = rows.map((row) =>
            this.insertRow(table, row, operation),
          );
          const multi = this.createResponse(
            inserted.map((row) => structuredClone(row)),
          );
          const promise = Promise.resolve(multi);
          return Object.assign(promise, {
            single: async () =>
              this.createSingleResponse(inserted.at(-1) ?? null),
          });
        },
      };
    }

    private insertRow(
      table: TableName,
      row: Record<string, unknown>,
      operation: MutationOperation,
    ): Record<string, unknown> {
      this.consumeFailure(table, operation);
      const clone = structuredClone(row);
      const now = TEST_TIMESTAMP.toISOString();
      if (!clone.id) {
        this.idSequence += 1;
        clone.id = `${table}-${this.idSequence}`;
      }
      if (table === 'engine_hands') {
        clone.created_at ??= now;
      }
      if (table === 'engine_hand_events') {
        clone.occurred_at ??= now;
      }
      const existingIndex = this.tables[table].findIndex(
        (candidate) => candidate.id === clone.id,
      );
      if (existingIndex >= 0) {
        this.tables[table][existingIndex] = clone;
      } else {
        this.tables[table].push(clone);
      }
      return structuredClone(clone);
    }

    private createResponse<T>(rows: T[]) {
      return {
        data: rows,
        error: null,
        status: 200,
      } as const;
    }

    private createSingleResponse<T>(row: T | null, status = row ? 200 : 404) {
      return {
        data: row,
        error: row ? null : status === 404 ? null : new Error('Not Found'),
        status,
      } as const;
    }

    private consumeFailure(table: TableName, operation: MutationOperation) {
      const index = this.failures.findIndex(
        (candidate) =>
          candidate.table === table && candidate.operation === operation,
      );
      if (index >= 0) {
        const [failure] = this.failures.splice(index, 1);
        if (failure) {
          throw failure.error;
        }
      }
    }
  }
});
