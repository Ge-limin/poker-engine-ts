import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import {
  EnvelopeUpcaster,
  fromSnapshotEnvelope,
  fromTurnEventEnvelope,
  toSnapshotEnvelope,
  toTurnEventEnvelope,
} from '../core/envelopes';
import { ENGINE_VERSION, IllegalIntentError } from '../core/errors';
import { validateIntent } from '../core/intent';
import type { ValidationConfig } from '../core/intent/types';
import { reduce } from '../core/reducer';
import {
  collectAllInPlayers,
  collectFoldedPlayers,
  findSeatByPlayerId,
  sumPotAmounts,
} from '../core/utils/snapshot';
import { evaluateShowdown } from '../evaluation/showdown-evaluator';
import { invokeEngineHooks } from '../hooks/invoke';
import { settlePots } from '../reducer';
import { updateSessionMetrics } from '../telemetry/metrics';
import type { TelemetryUpdateContext } from '../telemetry/metrics';
import {
  type ChannelDispatches,
  createRuntimeDispatchMetadata,
} from '../telemetry/runtime-dispatch';
import type {
  Card,
  HandStage,
  Milliseconds,
  PlayerId,
  UUID,
} from '../types/common';
import type {
  CardRevealMetadata,
  CommunityRevealMetadata,
  SnapshotEnvelope,
  TurnEvent,
  TurnEventEnvelope,
  TurnIntent,
  TurnMetadata,
  ValidationResult,
} from '../types/events';
import type {
  EngineHooks,
  RuntimeContext,
  Session,
  SessionConfig,
  SessionMetrics,
  SimulationRequest,
} from '../types/session';
import type {
  BettingRound,
  HandFlags,
  PayoutSummary,
  Seat,
  TableSnapshot,
} from '../types/snapshot';
import { applyAutoRunout } from './auto-runout';
import {
  createValidationConfig,
  deriveLegalOptionsForActor,
} from './legal-options';
import type { SeatBootstrapConfig, SessionBootstrapOptions } from './lifecycle';
import {
  applyCommunityDistribution,
  bootstrapSession,
  completeHand,
} from './lifecycle';
import {
  assertReplayTimeline,
  assertScenarioInteractive,
  assertSimulationControl,
  createRuntimeModeViolation,
} from './runtime-guards';
import {
  computePersonaAdjustments,
  selectDecisionContext,
  selectTelemetryEvent,
} from './selectors';

export type SessionManagerHooks = EngineHooks;

export interface SessionManagerOptions {
  readonly now?: () => Milliseconds;
  readonly idFactory?: () => string;
}

export interface CreateSessionOptions
  extends SessionBootstrapOptions,
    SessionManagerOptions {
  readonly hooks?: SessionManagerHooks;
}

export interface ResumeSessionOptions extends SessionManagerOptions {
  readonly turnEventUpcaster?: EnvelopeUpcaster<TurnEvent>;
  readonly snapshotUpcaster?: EnvelopeUpcaster<TableSnapshot>;
}

export interface ApplyIntentOptions {
  readonly validationConfig?: Partial<ValidationConfig>;
}

export interface HookError {
  readonly stage: keyof EngineHooks;
  readonly cause: unknown;
}

export interface ApplyIntentResult {
  readonly validation: ValidationResult;
  readonly session: Session;
  readonly eventEnvelope?: TurnEventEnvelope;
  readonly snapshotEnvelope?: SnapshotEnvelope<TableSnapshot>;
  readonly hookErrors: readonly HookError[];
  readonly channels: ChannelDispatches;
}

export interface AdvanceHandResult {
  readonly session: Session;
  readonly snapshotEnvelope: SnapshotEnvelope<TableSnapshot>;
}

interface SnapshotWithMetadata {
  readonly snapshot: TableSnapshot;
  readonly metadata?: Partial<TurnMetadata>;
}

interface ManagerState {
  session: Session;
  readonly eventLog: TurnEventEnvelope[];
  readonly checkpoints: Map<number, SnapshotEnvelope<TableSnapshot>>;
  telemetry: TelemetryUpdateContext;
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;
const ULID_RANDOM_BYTES = 10;
const ULID_TIME_MAX = 281_474_976_710_655;

function defaultNow(): Milliseconds {
  return Date.now();
}

function autoAdvanceHandStage(
  baseSession: Session,
  events: readonly TurnEvent[],
  snapshot: TableSnapshot,
  config: SessionConfig,
  timestamp: Milliseconds,
): SnapshotWithMetadata {
  if (!config.autoAdvance) {
    return { snapshot } satisfies SnapshotWithMetadata;
  }

  let workingSnapshot = snapshot;
  let aggregatedMetadata: Partial<TurnMetadata> | undefined;
  const maxIterations = Math.max(1, config.ruleSet.streets.length);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const nextStage = resolveNextStage(workingSnapshot.hand.stage, config);
    if (!nextStage) {
      break;
    }

    const sessionView: Session = {
      ...baseSession,
      events,
      activeSnapshot: workingSnapshot,
    };

    const decision = selectDecisionContext(sessionView);
    if (
      decision.playersLeftToAct.length > 0 ||
      decision.availableActions.length > 0
    ) {
      break;
    }

    const activePlayers = resolveActivePlayers(workingSnapshot);
    if (activePlayers.size <= 1) {
      break;
    }

    const advanced = advanceSnapshotToStage(
      workingSnapshot,
      config,
      nextStage,
      timestamp,
    );

    if (
      !advanced ||
      advanced.snapshot.hand.stage === workingSnapshot.hand.stage
    ) {
      break;
    }

    if (advanced.metadata) {
      aggregatedMetadata = mergeMetadataPartials(
        aggregatedMetadata,
        advanced.metadata,
      );
    }

    workingSnapshot = advanced.snapshot;
  }

  const sessionView: Session = {
    ...baseSession,
    events,
    activeSnapshot: workingSnapshot,
  };

  const settledSnapshot = settleHandWhenSinglePlayerRemains(workingSnapshot);
  if (settledSnapshot !== workingSnapshot) {
    const settledSessionView: Session = {
      ...sessionView,
      activeSnapshot: settledSnapshot,
    };
    const finalSnapshot = autoSettleShowdown(
      settledSessionView,
      settledSnapshot,
    );
    return {
      snapshot: finalSnapshot,
      metadata: aggregatedMetadata,
    } satisfies SnapshotWithMetadata;
  }

  const finalSnapshot = autoSettleShowdown(sessionView, workingSnapshot);
  return {
    snapshot: finalSnapshot,
    metadata: aggregatedMetadata,
  } satisfies SnapshotWithMetadata;
}

function autoSettleShowdown(
  session: Session,
  snapshot: TableSnapshot,
): TableSnapshot {
  if (snapshot.hand.stage !== 'showdown') {
    return snapshot;
  }
  if (snapshot.hand.payouts) {
    return snapshot;
  }

  const decision = selectDecisionContext({
    ...session,
    activeSnapshot: snapshot,
  });
  if (
    decision.playersLeftToAct.length > 0 ||
    decision.availableActions.length > 0
  ) {
    return snapshot;
  }

  const summary = evaluateShowdown(snapshot);
  if (!summary) {
    return snapshot;
  }

  const payout = settlePots(snapshot, summary);
  const settled = applyAutomaticPayout(snapshot, payout);

  return {
    ...settled,
    hand: {
      ...settled.hand,
      showdown: summary,
    },
  } satisfies TableSnapshot;
}

function resolveNextStage(
  stage: HandStage,
  config: SessionConfig,
): HandStage | null {
  const streets = config.ruleSet.streets;
  const index = streets.indexOf(stage);
  if (index === -1) {
    return null;
  }
  return (streets[index + 1] as HandStage | undefined) ?? null;
}

function resolveActivePlayers(snapshot: TableSnapshot): Set<PlayerId> {
  const folded = collectFoldedPlayers(snapshot.hand);
  const pending = new Set(snapshot.flags.pendingEliminations);
  const active = new Set<PlayerId>();

  for (const seat of snapshot.seating.seats) {
    const playerId = seat.occupant?.playerId;
    if (!playerId) {
      continue;
    }
    if (seat.status !== 'occupied') {
      continue;
    }
    if (folded.has(playerId) || pending.has(playerId)) {
      continue;
    }
    active.add(playerId);
  }

  return active;
}

function settleHandWhenSinglePlayerRemains(
  snapshot: TableSnapshot,
): TableSnapshot {
  if (snapshot.hand.stage === 'settled') {
    return snapshot;
  }

  const activePlayers = Array.from(resolveActivePlayers(snapshot));
  if (activePlayers.length !== 1) {
    return snapshot;
  }

  const [winner] = activePlayers;
  if (!winner) {
    return snapshot;
  }

  const payout = buildSinglePlayerPayout(snapshot, winner);
  return applyAutomaticPayout(snapshot, payout);
}

function buildSinglePlayerPayout(
  snapshot: TableSnapshot,
  playerId: PlayerId,
): PayoutSummary {
  const buckets = [snapshot.pots.main, ...snapshot.pots.sides];
  let total = 0;
  const potIds = new Set<string>();

  for (const bucket of buckets) {
    if (bucket.amount <= 0) {
      continue;
    }
    // Everyone else has folded, so the last remaining player takes the whole
    // pot, including any uncontested side pots they were not eligible to
    // contest at showdown. Awarding every non-empty bucket keeps chips
    // conserved.
    total += bucket.amount;
    potIds.add(bucket.id);
  }

  return {
    entries:
      total > 0
        ? [
            {
              playerId,
              amount: total,
              potIds: Array.from(potIds),
            },
          ]
        : [],
    rake: snapshot.pots.rake,
  } satisfies PayoutSummary;
}

function applyAutomaticPayout(
  snapshot: TableSnapshot,
  payout: PayoutSummary,
): TableSnapshot {
  const awards = new Map<PlayerId, number>();
  for (const entry of payout.entries) {
    awards.set(entry.playerId, entry.amount);
  }

  const seats = snapshot.seating.seats.map((seat) => {
    const occupant = seat.occupant;
    if (!occupant) {
      return seat;
    }
    const award = awards.get(occupant.playerId);
    if (!award || award === 0) {
      return seat;
    }
    return {
      ...seat,
      stack: seat.stack + award,
      status: 'occupied',
    } satisfies Seat;
  });

  const mainContributions = { ...snapshot.pots.main.contributions };
  for (const key of Object.keys(mainContributions)) {
    mainContributions[key] = 0;
  }

  const sideBuckets = snapshot.pots.sides.map((bucket) => {
    const contributions = { ...bucket.contributions };
    for (const key of Object.keys(contributions)) {
      contributions[key] = 0;
    }
    return {
      ...bucket,
      amount: 0,
      contributions,
    };
  });

  const pendingEliminations = collectPendingEliminationsFromSeats(seats);

  return {
    ...snapshot,
    index: snapshot.index + 1,
    seating: { ...snapshot.seating, seats },
    pots: {
      ...snapshot.pots,
      main: {
        ...snapshot.pots.main,
        amount: 0,
        contributions: mainContributions,
      },
      sides: sideBuckets,
      rake: payout.rake ?? snapshot.pots.rake,
    },
    hand: {
      ...snapshot.hand,
      stage: 'settled',
      payouts: payout,
    },
    flags: {
      ...snapshot.flags,
      showdownLocked: true,
      pendingEliminations,
    },
    clock: {
      ...snapshot.clock,
      currentActor: undefined,
      deadline: undefined,
    },
  } satisfies TableSnapshot;
}

function collectPendingEliminationsFromSeats(
  seats: readonly Seat[],
): PlayerId[] {
  const pending = new Set<PlayerId>();
  for (const seat of seats) {
    const occupant = seat.occupant;
    if (!occupant) {
      continue;
    }
    if (seat.stack <= 0) {
      pending.add(occupant.playerId);
    }
  }
  return Array.from(pending);
}

function advanceSnapshotToStage(
  snapshot: TableSnapshot,
  config: SessionConfig,
  nextStage: HandStage,
  timestamp: Milliseconds,
): SnapshotWithMetadata | null {
  const revealStage = toCommunityStage(nextStage);
  let cards = snapshot.cards;
  const reveals: CommunityRevealMetadata[] = [];

  if (
    revealStage &&
    !isCommunityStageRevealed(snapshot.cards.community, revealStage)
  ) {
    try {
      const scheduleStart = cards.community.revealSchedule.length;
      const result = applyCommunityDistribution({
        ledger: cards,
        config,
        stage: revealStage,
        timestamp,
      });
      cards = result.ledger;
      const newEntries =
        result.ledger.community.revealSchedule.slice(scheduleStart);
      for (const entry of newEntries) {
        if (
          entry.stage === 'flop' ||
          entry.stage === 'turn' ||
          entry.stage === 'river'
        ) {
          reveals.push({
            stage: entry.stage,
            cards: entry.cards,
            reason: entry.reason,
          });
        }
      }
    } catch (error) {
      if (!isDeckExhaustedError(error)) {
        return null;
      }
    }
  }

  const folded = collectFoldedPlayers(snapshot.hand);
  const allIn = collectAllInPlayers(snapshot);
  const pending = new Set(snapshot.flags.pendingEliminations);
  const inactive = mergeInactivePlayers(folded, allIn, pending);

  const turnOrder = deriveTurnOrderForStage(
    nextStage,
    snapshot.seating.seats,
    snapshot.hand,
    inactive,
  );

  const existingRoundIndex = snapshot.hand.bettingRounds.findIndex(
    (round) => round.stage === nextStage,
  );

  const bettingRounds: BettingRound[] = snapshot.hand.bettingRounds.map(
    (round) => ({ ...round }),
  );

  const requiresBettingRound =
    nextStage === 'preflop' ||
    nextStage === 'flop' ||
    nextStage === 'turn' ||
    nextStage === 'river';

  if (requiresBettingRound) {
    const baseRound: BettingRound = {
      stage: nextStage,
      turnOrder,
      turns: [],
      roundPot: 0,
      highestBet: 0,
    } satisfies BettingRound;

    if (existingRoundIndex === -1) {
      bettingRounds.push(baseRound);
    } else {
      bettingRounds[existingRoundIndex] = baseRound;
    }
  }

  const nextActorId = requiresBettingRound
    ? resolveOpeningActor(turnOrder, snapshot.seating.seats)
    : undefined;
  const perTurnMs = snapshot.clock.perTurnMs;
  const hasDeadline = perTurnMs > 0;
  const clock = {
    ...snapshot.clock,
    currentActor: nextActorId,
    deadline: nextActorId && hasDeadline ? timestamp + perTurnMs : undefined,
  } satisfies TableSnapshot['clock'];

  const hand = {
    ...snapshot.hand,
    stage: nextStage,
    bettingRounds,
  } satisfies TableSnapshot['hand'];

  const advancedSnapshot: TableSnapshot = {
    ...snapshot,
    index: snapshot.index + 1,
    hand,
    cards,
    clock,
  } satisfies TableSnapshot;

  const metadata =
    reveals.length > 0
      ? ({
          cardReveals: { community: reveals },
        } satisfies Partial<TurnMetadata>)
      : undefined;

  return {
    snapshot: advancedSnapshot,
    metadata,
  } satisfies SnapshotWithMetadata;
}

function toCommunityStage(
  stage: HandStage,
): Extract<HandStage, 'flop' | 'turn' | 'river'> | null {
  if (stage === 'flop' || stage === 'turn' || stage === 'river') {
    return stage;
  }
  return null;
}

function isCommunityStageRevealed(
  community: TableSnapshot['cards']['community'],
  stage: Extract<HandStage, 'flop' | 'turn' | 'river'>,
): boolean {
  if (stage === 'flop') {
    return Boolean(community.flop);
  }
  if (stage === 'turn') {
    return Boolean(community.turn);
  }
  return Boolean(community.river);
}

function isDeckExhaustedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Insufficient cards');
}

function mergeInactivePlayers(
  folded: Set<PlayerId>,
  allIn: Set<PlayerId>,
  pending: Set<PlayerId>,
): Set<PlayerId> {
  const inactive = new Set<PlayerId>();
  for (const id of folded) inactive.add(id);
  for (const id of allIn) inactive.add(id);
  for (const id of pending) inactive.add(id);
  return inactive;
}

function deriveTurnOrderForStage(
  stage: HandStage,
  seats: readonly Seat[],
  hand: TableSnapshot['hand'],
  inactivePlayers: ReadonlySet<PlayerId>,
): number[] {
  const eligible = seats.filter((seat) => {
    const playerId = seat.occupant?.playerId;
    if (!playerId) {
      return false;
    }
    if (seat.status !== 'occupied') {
      return false;
    }
    return !inactivePlayers.has(playerId);
  });

  if (eligible.length === 0) {
    return [];
  }

  if (stage === 'preflop') {
    const bigBlindSeat = seats.find(
      (seat) => seat.occupant?.playerId === hand.blinds.bigBlind.playerId,
    );
    if (!bigBlindSeat) {
      return eligible.map((seat) => seat.index);
    }
    return rotateSeatIndices(seats, bigBlindSeat.index, inactivePlayers);
  }

  const startIndex = findNextOccupiedSeatIndex(
    seats,
    hand.buttonSeat,
    inactivePlayers,
  );
  if (startIndex === null) {
    return [];
  }
  const rotationStart =
    (startIndex + seats.length - 1) % (seats.length === 0 ? 1 : seats.length);
  return rotateSeatIndices(seats, rotationStart, inactivePlayers);
}

function rotateSeatIndices(
  seats: readonly Seat[],
  startIndex: number,
  inactivePlayers: ReadonlySet<PlayerId>,
): number[] {
  const result: number[] = [];
  const total = seats.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const index = (startIndex + offset) % total;
    const seat = seats[index];
    const playerId = seat?.occupant?.playerId;
    if (!playerId) {
      continue;
    }
    if (seat.status !== 'occupied') {
      continue;
    }
    if (inactivePlayers.has(playerId)) {
      continue;
    }
    result.push(index);
  }
  return result;
}

function findNextOccupiedSeatIndex(
  seats: readonly Seat[],
  startIndex: number,
  inactivePlayers: ReadonlySet<PlayerId>,
): number | null {
  const total = seats.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const index = (startIndex + offset) % total;
    const seat = seats[index];
    const playerId = seat?.occupant?.playerId;
    if (!playerId) {
      continue;
    }
    if (seat.status !== 'occupied') {
      continue;
    }
    if (inactivePlayers.has(playerId)) {
      continue;
    }
    return index;
  }
  return null;
}

function resolveOpeningActor(
  turnOrder: readonly number[],
  seats: readonly Seat[],
): PlayerId | undefined {
  for (const index of turnOrder) {
    const seat = seats[index];
    const playerId = seat?.occupant?.playerId;
    if (playerId && seat?.status === 'occupied') {
      return playerId;
    }
  }
  return undefined;
}

export class SessionManager {
  private readonly now: () => Milliseconds;
  private readonly idFactory: () => string;

  private state: ManagerState;
  private mutex: Promise<void> = Promise.resolve();

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.mutex;
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutex = previous.then(() => next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.withLock(fn);
  }

  private constructor(
    session: Session,
    options: SessionManagerOptions,
    eventLog: TurnEventEnvelope[] = [],
    telemetry: TelemetryUpdateContext = { intentSamples: 0 },
    checkpoints = new Map<number, SnapshotEnvelope<TableSnapshot>>(),
  ) {
    this.now = options.now ?? defaultNow;
    this.idFactory = options.idFactory ?? (() => session.id);

    this.state = {
      session,
      eventLog,
      telemetry,
      checkpoints,
    };
  }

  static create(
    config: SessionConfig,
    seats: readonly SeatBootstrapConfig[],
    options: CreateSessionOptions = {},
  ): SessionManager {
    const session = bootstrapSession(config, seats, {
      ...options,
      hooks: options.hooks,
    });
    const initialSnapshot = toSnapshotEnvelope(session.activeSnapshot);
    const checkpoints = new Map<number, SnapshotEnvelope<TableSnapshot>>();
    checkpoints.set(session.events.length, initialSnapshot);
    return new SessionManager(
      session,
      options,
      [],
      { intentSamples: 0 },
      checkpoints,
    );
  }

  static resume(
    payload: {
      readonly sessionId: UUID;
      readonly config: SessionConfig;
      readonly runtimeContext: RuntimeContext;
      readonly initialSnapshot: SnapshotEnvelope<TableSnapshot>;
      readonly events: readonly TurnEventEnvelope[];
      readonly metrics: SessionMetrics;
      readonly channels: Session['channels'];
      readonly hooks?: SessionManagerHooks;
    },
    options: ResumeSessionOptions = {},
  ): SessionManager {
    const snapshot = fromSnapshotEnvelope(
      payload.initialSnapshot,
      options.snapshotUpcaster,
    );
    const events = payload.events.map((entry) =>
      fromTurnEventEnvelope(entry, options.turnEventUpcaster),
    );
    const now = options.now ?? defaultNow;
    const base: Session = {
      id: payload.sessionId,
      config: payload.config,
      runtimeContext: payload.runtimeContext,
      initialSnapshot: snapshot,
      events: [],
      activeSnapshot: snapshot,
      metrics: payload.metrics,
      channels: payload.channels,
      hooks: payload.hooks ?? {},
    };
    const appliedEvents: TurnEvent[] = [];
    let activeSnapshot = snapshot;
    for (const event of events) {
      appliedEvents.push(event);
      activeSnapshot = SessionManager.replayEvent(
        base,
        appliedEvents,
        activeSnapshot,
        event,
        now(),
      );
    }
    const session: Session = {
      id: payload.sessionId,
      config: payload.config,
      runtimeContext: payload.runtimeContext,
      initialSnapshot: snapshot,
      events,
      activeSnapshot,
      metrics: payload.metrics,
      channels: payload.channels,
      hooks: payload.hooks ?? {},
    };

    SessionManager.assertResumeContext(session.runtimeContext, events.length);

    const manager = new SessionManager(
      session,
      options,
      payload.events.slice(),
      { intentSamples: 0 },
    );
    // Historical replays depend on rewinding all the way back to the
    // initial stack distribution. Seed checkpoint index 0 with the deserialised
    // initial snapshot so resume operations can replay early events without
    // starting from a later checkpoint.
    manager.state.checkpoints.set(0, payload.initialSnapshot);
    manager.state.checkpoints.set(
      events.length,
      toSnapshotEnvelope(activeSnapshot),
    );
    return manager;
  }

  get session(): Session {
    return this.state.session;
  }

  get eventLog(): readonly TurnEventEnvelope[] {
    return this.state.eventLog.slice();
  }

  async applyIntent(
    intent: TurnIntent,
    options: ApplyIntentOptions = {},
  ): Promise<ApplyIntentResult> {
    return this.runExclusive(async () => {
      const { session } = this.state;
      const hookErrors: HookError[] = [];

      this.assertIntentAcceptance(intent);

      await this.safeInvokeHook('beforeIntent', intent, session, hookErrors);

      const baseValidationConfig = createValidationConfig(
        session.activeSnapshot,
        session.config,
      );
      const mergedValidationConfig = options.validationConfig
        ? ({
            ...baseValidationConfig,
            ...options.validationConfig,
          } satisfies ValidationConfig)
        : baseValidationConfig;

      const validationOptions = { config: mergedValidationConfig } as const;

      const validation =
        intent.requested.type === 'timeout'
          ? this.acceptTimeoutIntent(intent)
          : validateIntent(session.activeSnapshot, intent, validationOptions);

      await this.safeInvokeHook(
        'afterValidation',
        validation,
        session,
        hookErrors,
      );

      if (validation.kind !== 'accepted') {
        return {
          validation,
          session,
          hookErrors,
          channels: {},
        };
      }

      let event = this.prepareEvent(validation.event);
      const potBefore = sumPotAmounts(session.activeSnapshot.pots);
      const reduced = reduce(session.activeSnapshot, event);
      const postReduceResult = this.postReduce(reduced, event, session.config);
      let workingSnapshot = postReduceResult.snapshot;
      let metadataPatch = postReduceResult.metadata;

      const eventsAfterEvent = session.events.concat(event);
      const stageAdvanceResult = autoAdvanceHandStage(
        session,
        eventsAfterEvent,
        workingSnapshot,
        session.config,
        this.now(),
      );
      workingSnapshot = stageAdvanceResult.snapshot;
      metadataPatch = mergeMetadataPartials(
        metadataPatch,
        stageAdvanceResult.metadata,
      );

      if (metadataPatch) {
        event = {
          ...event,
          metadata: mergeTurnMetadata(event.metadata, metadataPatch),
        } satisfies TurnEvent;
      }

      const updatedEvents = session.events.concat(event);
      const potAfter = sumPotAmounts(workingSnapshot.pots);
      const personaAdjustments = computePersonaAdjustments(
        session.activeSnapshot.personas,
        workingSnapshot.personas,
      );

      const updatedSession: Session = {
        ...session,
        events: updatedEvents,
        activeSnapshot: workingSnapshot,
      };

      const telemetryResult = updateSessionMetrics(
        session.metrics,
        {
          potDelta: potAfter - potBefore,
          latencyMs: intent.latencyMs,
          personaAdjustments,
        },
        this.state.telemetry,
      );

      let metrics = telemetryResult.metrics;
      if (event.action.type === 'timeout' && event.action.fallback === 'fold') {
        metrics = {
          ...metrics,
          timeoutsHard: metrics.timeoutsHard + 1,
        };
      }

      let sessionDraft: Session = {
        ...updatedSession,
        metrics,
      };

      const simulationRequest = this.resolveSimulationRequest(sessionDraft);

      if (simulationRequest) {
        sessionDraft = {
          ...sessionDraft,
          metrics: {
            ...sessionDraft.metrics,
            advisoryEquityRequests:
              sessionDraft.metrics.advisoryEquityRequests + 1,
          },
        };
      }

      const sessionWithMetrics = sessionDraft;

      const eventEnvelope = toTurnEventEnvelope(event);
      const snapshotEnvelope = toSnapshotEnvelope(workingSnapshot);
      const eventIndex = updatedEvents.length - 1;
      const dispatchMetadata = createRuntimeDispatchMetadata(
        sessionWithMetrics.runtimeContext,
        eventIndex >= 0 ? eventIndex : undefined,
      );
      const telemetryEvent = selectTelemetryEvent(sessionWithMetrics, event, {
        snapshotBefore: session.activeSnapshot,
        snapshotAfter: workingSnapshot,
        potBefore,
        potAfter,
        eventIndex: eventIndex >= 0 ? eventIndex : undefined,
        personaAdjustments,
        latencyMs: intent.latencyMs,
      });

      this.state = {
        session: sessionWithMetrics,
        eventLog: this.state.eventLog.concat(eventEnvelope),
        checkpoints: this.persistCheckpoint(
          updatedEvents.length,
          snapshotEnvelope,
        ),
        telemetry: telemetryResult.context,
      };

      await this.safeInvokeHook(
        'afterReduction',
        sessionWithMetrics.activeSnapshot,
        sessionWithMetrics,
        hookErrors,
      );

      if (simulationRequest) {
        await this.safeInvokeHook(
          'simulationRequested',
          simulationRequest,
          sessionWithMetrics,
          hookErrors,
        );
      }

      if (
        sessionWithMetrics.activeSnapshot.hand.stage === 'showdown' &&
        sessionWithMetrics.hooks.handCompleted
      ) {
        await this.safeInvokeHook(
          'handCompleted',
          sessionWithMetrics.activeSnapshot.hand,
          sessionWithMetrics,
          hookErrors,
        );
      }

      const channels: ChannelDispatches = simulationRequest
        ? {
            telemetry: {
              channel: sessionWithMetrics.channels.analytics,
              event: telemetryEvent,
              metadata: dispatchMetadata,
            },
            replay: {
              channel: sessionWithMetrics.channels.replay,
              event: eventEnvelope,
              snapshot: snapshotEnvelope,
              metadata: dispatchMetadata,
            },
            advisory: {
              channel: sessionWithMetrics.channels.advisory,
              simulation: simulationRequest,
              metadata: dispatchMetadata,
            },
          }
        : {
            telemetry: {
              channel: sessionWithMetrics.channels.analytics,
              event: telemetryEvent,
              metadata: dispatchMetadata,
            },
            replay: {
              channel: sessionWithMetrics.channels.replay,
              event: eventEnvelope,
              snapshot: snapshotEnvelope,
              metadata: dispatchMetadata,
            },
          };

      return {
        validation,
        session: sessionWithMetrics,
        eventEnvelope,
        snapshotEnvelope,
        hookErrors,
        channels,
      };
    });
  }

  async advanceHand(deck?: readonly Card[]): Promise<AdvanceHandResult> {
    return this.withLock(() => {
      this.assertMutableSession('advance hand');
      const session = this.state.session;
      const settledSnapshot = settleHandWhenSinglePlayerRemains(
        session.activeSnapshot,
      );
      const withSettlement =
        settledSnapshot === session.activeSnapshot
          ? session
          : { ...session, activeSnapshot: settledSnapshot };
      const next = completeHand(withSettlement, {
        deck,
        timestamp: this.now(),
      });
      const envelope = toSnapshotEnvelope(next.activeSnapshot);
      const checkpoints = new Map<number, SnapshotEnvelope<TableSnapshot>>();
      checkpoints.set(0, toSnapshotEnvelope(next.initialSnapshot));
      checkpoints.set(next.events.length, envelope);

      this.state = {
        session: next,
        eventLog: [],
        telemetry: this.state.telemetry,
        checkpoints,
      };

      return {
        session: next,
        snapshotEnvelope: envelope,
      };
    });
  }

  async rewindTo(eventIndex: number): Promise<Session> {
    return this.withLock(() => {
      this.assertTimelineControl('rewind session');
      if (eventIndex < 0) {
        throw new IllegalIntentError('Event index must be non-negative');
      }

      const { snapshot: checkpointSnapshot, index: start } =
        this.locateCheckpoint(eventIndex);
      const replaySegment = this.state.session.events.slice(start, eventIndex);
      const appliedEvents = this.state.session.events.slice(0, start);
      let replayed = checkpointSnapshot;
      for (const event of replaySegment) {
        appliedEvents.push(event);
        replayed = SessionManager.replayEvent(
          this.state.session,
          appliedEvents,
          replayed,
          event,
          this.now(),
        );
      }
      const restoredEvents = this.state.session.events
        .slice(0, start)
        .concat(replaySegment);

      const metrics: SessionMetrics = {
        ...this.state.session.metrics,
        recoveries: this.state.session.metrics.recoveries + 1,
      };

      const session: Session = {
        ...this.state.session,
        events: restoredEvents,
        activeSnapshot: replayed,
        metrics,
      };

      this.state = {
        ...this.state,
        session,
        eventLog: this.state.eventLog.slice(0, eventIndex),
      };

      return session;
    });
  }

  async replaceFrom(
    eventIndex: number,
    envelopes: readonly TurnEventEnvelope[],
  ): Promise<Session> {
    return this.withLock(() => {
      this.assertTimelineControl('replace session timeline');
      if (eventIndex < 0 || eventIndex > this.state.session.events.length) {
        throw new IllegalIntentError('Event index out of range', {
          index: eventIndex,
        });
      }

      const prefixEvents = this.state.session.events.slice(0, eventIndex);
      const replayedEvents: TurnEvent[] = [];
      let baseSnapshot = this.state.session.initialSnapshot;
      for (const event of prefixEvents) {
        replayedEvents.push(event);
        baseSnapshot = SessionManager.replayEvent(
          this.state.session,
          replayedEvents,
          baseSnapshot,
          event,
          this.now(),
        );
      }
      const events = envelopes.map((entry) => fromTurnEventEnvelope(entry));
      const mergedEvents = prefixEvents.concat(events);
      let activeSnapshot = baseSnapshot;
      const checkpoints = new Map<number, SnapshotEnvelope<TableSnapshot>>(
        [...this.state.checkpoints.entries()].filter(
          ([index]) => index < eventIndex,
        ),
      );
      checkpoints.set(eventIndex, toSnapshotEnvelope(baseSnapshot));

      let checkpointIndex = eventIndex;
      for (const event of events) {
        checkpointIndex += 1;
        replayedEvents.push(event);
        activeSnapshot = SessionManager.replayEvent(
          this.state.session,
          replayedEvents,
          activeSnapshot,
          event,
          this.now(),
        );
        checkpoints.set(checkpointIndex, toSnapshotEnvelope(activeSnapshot));
      }

      const session: Session = {
        ...this.state.session,
        events: mergedEvents,
        activeSnapshot,
      };

      this.state = {
        ...this.state,
        session,
        eventLog: this.state.eventLog.slice(0, eventIndex).concat(envelopes),
        checkpoints,
      };

      return session;
    });
  }

  updateRuntimeContext(context: RuntimeContext): Session {
    const session: Session = {
      ...this.state.session,
      runtimeContext: context,
    };
    this.state = { ...this.state, session };
    return session;
  }

  enterReplay(timelineIndex?: number): Session {
    const index =
      timelineIndex ?? Math.max(0, this.state.session.events.length - 1);
    const context: RuntimeContext = {
      mode: 'replay',
      timelineIndex: index,
      isPlaying: false,
      speed: 1,
    };
    return this.updateRuntimeContext(context);
  }

  exitReplay(): Session {
    return this.updateRuntimeContext({ mode: 'live' });
  }

  startSimulation(simulationId: string, handsToRun: number): Session {
    const context: RuntimeContext = {
      mode: 'simulation',
      simulationId,
      handsToRun,
      handsCompleted: 0,
    };
    return this.updateRuntimeContext(context);
  }

  trackSimulationProgress(handsCompleted: number): Session {
    const context = this.state.session.runtimeContext;
    if (context.mode !== 'simulation') {
      return this.state.session;
    }
    const updatedContext: RuntimeContext = {
      ...context,
      handsCompleted,
    };

    let metrics = this.state.session.metrics;
    if (handsCompleted >= context.handsToRun) {
      metrics = {
        ...metrics,
        simulationsRun: metrics.simulationsRun + 1,
      };
    }

    const session: Session = {
      ...this.state.session,
      runtimeContext: updatedContext,
      metrics,
    };

    this.state = { ...this.state, session };
    return session;
  }

  completeScenario(): Session {
    const context = this.state.session.runtimeContext;
    if (context.mode !== 'scenario') {
      return this.state.session;
    }
    return this.updateRuntimeContext({
      ...context,
      isCompleted: true,
    });
  }

  resetScenarioView(): Session {
    const context = this.state.session.runtimeContext;
    if (context.mode !== 'scenario') {
      return this.state.session;
    }
    return this.updateRuntimeContext({
      ...context,
      viewingIndex: null,
    });
  }

  async closeSession(): Promise<Session> {
    return this.withLock(() => {
      const replayContext: RuntimeContext = {
        mode: 'replay',
        timelineIndex: this.state.session.events.length,
        isPlaying: false,
        speed: 1,
      };
      return this.updateRuntimeContext(replayContext);
    });
  }

  private resolveSimulationRequest(
    session: Session,
  ): SimulationRequest | undefined {
    if (session.runtimeContext.mode !== 'live') {
      return undefined;
    }
    const policy = session.config.simulationPolicy;
    if (!policy) {
      return undefined;
    }
    if (!session.hooks.simulationRequested) {
      return undefined;
    }

    const decision = selectDecisionContext(session);
    if (!decision.actor) {
      return undefined;
    }

    const iterations = Math.max(1, policy.maxIterations);

    return {
      context: decision,
      policy,
      iterations,
      resultChannel: session.channels.advisory.responseTopic,
    } satisfies SimulationRequest;
  }

  private prepareEvent(event: TurnEvent): TurnEvent {
    const session = this.state.session;
    const counter = session.events.length + 1;
    const handNumber = session.activeSnapshot.handNumber;
    const timestamp = Number.isFinite(event.timestamp)
      ? Math.trunc(event.timestamp)
      : this.now();
    return {
      ...event,
      id: this.idFactoryForEvent(session.id, handNumber, counter, timestamp),
    } satisfies TurnEvent;
  }

  private idFactoryForEvent(
    sessionId: string,
    handNumber: number,
    counter: number,
    timestamp: number,
  ): string {
    const entropy = this.idFactory();
    return createDeterministicUlid({
      sessionId,
      handNumber,
      counter,
      timestamp,
      entropy,
    });
  }

  // Replays one persisted event through the same reduce, post-reduce, and
  // auto-advance pipeline that live intents go through. Every code path that
  // rebuilds snapshots from the log (resume, rewindTo, replaceFrom) must use
  // this, or replayed timelines miss street advancement and settlement.
  // `events` is the full event list up to and including `event`.
  private static replayEvent(
    base: Session,
    events: readonly TurnEvent[],
    snapshot: TableSnapshot,
    event: TurnEvent,
    timestamp: Milliseconds,
  ): TableSnapshot {
    const reduced = reduce(snapshot, event);
    const postReduceResult = SessionManager.runPostReduce(
      reduced,
      event,
      base.config,
    );
    const advanced = autoAdvanceHandStage(
      { ...base, events, activeSnapshot: postReduceResult.snapshot },
      events,
      postReduceResult.snapshot,
      base.config,
      timestamp,
    );
    return advanced.snapshot;
  }

  private static runPostReduce(
    snapshot: TableSnapshot,
    event: TurnEvent,
    config: SessionConfig,
  ): SnapshotWithMetadata {
    const runout = applyAutoRunout({
      snapshot,
      config,
      recentEvent: event,
      timestamp: event.timestamp,
    });
    const metadata = runout.cardReveals
      ? ({ cardReveals: runout.cardReveals } satisfies Partial<TurnMetadata>)
      : undefined;
    return {
      snapshot: runout.snapshot,
      metadata,
    } satisfies SnapshotWithMetadata;
  }

  private postReduce(
    snapshot: TableSnapshot,
    event: TurnEvent,
    config: SessionConfig,
  ): SnapshotWithMetadata {
    return SessionManager.runPostReduce(snapshot, event, config);
  }

  private persistCheckpoint(
    eventCount: number,
    envelope: SnapshotEnvelope<TableSnapshot>,
  ): Map<number, SnapshotEnvelope<TableSnapshot>> {
    const checkpoints = new Map(this.state.checkpoints);
    checkpoints.set(eventCount, envelope);
    return checkpoints;
  }

  private locateCheckpoint(eventIndex: number): {
    index: number;
    snapshot: TableSnapshot;
  } {
    const checkpoints = [...this.state.checkpoints.entries()].sort(
      (a, b) => a[0] - b[0],
    );
    let chosenIndex = 0;
    let chosen = checkpoints[0]?.[1];
    for (const [index, snapshot] of checkpoints) {
      if (index <= eventIndex) {
        chosen = snapshot;
        chosenIndex = index;
      } else {
        break;
      }
    }
    if (!chosen) {
      return { index: 0, snapshot: this.state.session.initialSnapshot };
    }
    return { index: chosenIndex, snapshot: fromSnapshotEnvelope(chosen) };
  }

  private async safeInvokeHook(
    stage: keyof EngineHooks,
    payload: unknown,
    session: Session,
    accumulator: HookError[],
  ): Promise<void> {
    try {
      await invokeEngineHooks(session.hooks, stage, payload, session);
    } catch (error) {
      accumulator.push({ stage, cause: error });
    }
  }

  private assertIntentAcceptance(intent: TurnIntent): void {
    const context = this.state.session.runtimeContext;
    if (context.mode === 'simulation') {
      if (intent.origin === 'automation' || intent.origin === 'ai') {
        assertSimulationControl(context, 'apply simulation intent');
        return;
      }
      throw createRuntimeModeViolation(
        context,
        'apply turn intent',
        ['simulation'],
        {
          origin: intent.origin,
        },
      );
    }
    this.assertMutableSession('apply turn intent');
  }

  private assertMutableSession(action: string): void {
    const context = this.state.session.runtimeContext;
    if (context.mode === 'live') {
      return;
    }
    if (context.mode === 'scenario') {
      assertScenarioInteractive(context, action);
      return;
    }
    if (context.mode === 'simulation') {
      assertSimulationControl(context, action);
      return;
    }
    throw createRuntimeModeViolation(context, action, [
      'live',
      'scenario',
      'simulation',
    ]);
  }

  private assertTimelineControl(action: string): void {
    const context = this.state.session.runtimeContext;
    if (context.mode === 'replay') {
      assertReplayTimeline(context, action, {
        eventCount: this.state.session.events.length,
      });
      return;
    }
    if (context.mode === 'scenario') {
      const eventCount = this.state.session.events.length;
      if (
        context.viewingIndex !== null &&
        (context.viewingIndex < 0 || context.viewingIndex > eventCount)
      ) {
        throw createRuntimeModeViolation(context, action, ['scenario'], {
          viewingIndex: context.viewingIndex,
          eventCount,
        });
      }
      return;
    }
    throw createRuntimeModeViolation(context, action, ['replay', 'scenario']);
  }

  private static assertResumeContext(
    context: RuntimeContext,
    eventCount: number,
  ): void {
    if (context.mode === 'replay') {
      assertReplayTimeline(context, 'resume session', { eventCount });
      return;
    }
    if (context.mode === 'scenario') {
      if (
        context.viewingIndex !== null &&
        (context.viewingIndex < 0 || context.viewingIndex > eventCount)
      ) {
        throw createRuntimeModeViolation(
          context,
          'resume session',
          ['scenario'],
          {
            viewingIndex: context.viewingIndex,
            eventCount,
          },
        );
      }
      if (context.isCompleted && context.viewingIndex === null) {
        throw createRuntimeModeViolation(
          context,
          'resume session',
          ['scenario'],
          {
            state: 'completed',
          },
        );
      }
      return;
    }
    if (context.mode === 'simulation') {
      assertSimulationControl(context, 'resume session');
    }
  }

  private acceptTimeoutIntent(intent: TurnIntent): ValidationResult {
    const snapshot = this.state.session.activeSnapshot;
    const seatLookup = findSeatByPlayerId(snapshot.seating, intent.actor);
    if (!seatLookup) {
      return {
        kind: 'rejected',
        reason: 'timeout-actor-missing',
        recovery: { advise: 'retry' },
      };
    }

    if (snapshot.clock.currentActor !== intent.actor) {
      return {
        kind: 'rejected',
        reason: 'not-actors-turn',
        recovery: { advise: 'retry' },
      };
    }

    const legalOptions = deriveLegalOptionsForActor(snapshot, intent.actor, {
      sessionConfig: this.state.session.config,
    });

    const event: TurnEvent = {
      id: intent.id,
      actor: intent.actor,
      action: intent.requested,
      legalOptions,
      stackBefore: seatLookup.seat.stack,
      stackAfter: seatLookup.seat.stack,
      contribution: 0,
      timestamp: intent.issuedAt,
      metadata: {
        engineVersion: ENGINE_VERSION,
        availableActionsAtDecision: legalOptions,
        ...(intent.latencyMs !== undefined
          ? { networkLatencyMs: intent.latencyMs }
          : {}),
      },
    };

    return {
      kind: 'accepted',
      event,
    };
  }
}

/**
 * Merges a base turn metadata record with a delta payload, producing a
 * complete {@link TurnMetadata} instance. Optional fields in the delta are
 * combined with the existing metadata so card reveals and persona flags are
 * preserved while allowing the new values to override the base snapshot.
 */
function mergeTurnMetadata(
  base: TurnMetadata | undefined,
  delta: Partial<TurnMetadata>,
): TurnMetadata {
  const baseMetadata =
    base ??
    ({
      engineVersion: ENGINE_VERSION,
      availableActionsAtDecision: [],
    } satisfies TurnMetadata);

  const mergedCardReveals = mergeCardRevealMetadata(
    base?.cardReveals,
    delta.cardReveals,
  );
  const mergedPersonaFlags = mergePersonaFlagUpdates(
    base?.personaFlagUpdates,
    delta.personaFlagUpdates,
  );

  let partial: Partial<TurnMetadata> = {
    ...delta,
    availableActionsAtDecision:
      delta.availableActionsAtDecision ??
      baseMetadata.availableActionsAtDecision,
  };

  if (mergedCardReveals) {
    partial = {
      ...partial,
      cardReveals: mergedCardReveals,
    } satisfies Partial<TurnMetadata>;
  } else if (delta.cardReveals === undefined && baseMetadata.cardReveals) {
    partial = {
      ...partial,
      cardReveals: baseMetadata.cardReveals,
    } satisfies Partial<TurnMetadata>;
  }

  if (mergedPersonaFlags) {
    partial = {
      ...partial,
      personaFlagUpdates: mergedPersonaFlags,
    } satisfies Partial<TurnMetadata>;
  } else if (
    delta.personaFlagUpdates === undefined &&
    baseMetadata.personaFlagUpdates
  ) {
    partial = {
      ...partial,
      personaFlagUpdates: baseMetadata.personaFlagUpdates,
    } satisfies Partial<TurnMetadata>;
  }

  return {
    ...baseMetadata,
    ...partial,
  } satisfies TurnMetadata;
}

/**
 * Merges two partial turn-metadata objects, returning `undefined` only when
 * both inputs are `undefined`. When both partials are present the incoming
 * fields take precedence, while nested metadata (card reveals, persona flags)
 * are merged via their dedicated helpers.
 */
function mergeMetadataPartials(
  base: Partial<TurnMetadata> | undefined,
  incoming: Partial<TurnMetadata> | undefined,
): Partial<TurnMetadata> | undefined {
  if (!incoming) {
    return base;
  }
  if (!base) {
    return incoming;
  }

  const cardReveals = mergeCardRevealMetadata(
    base.cardReveals,
    incoming.cardReveals,
  );
  const personaFlags = mergePersonaFlagUpdates(
    base.personaFlagUpdates,
    incoming.personaFlagUpdates,
  );

  const cardRevealsEntry =
    cardReveals ??
    (incoming.cardReveals === undefined
      ? base.cardReveals
      : incoming.cardReveals);

  const personaEntry =
    personaFlags ??
    (incoming.personaFlagUpdates === undefined
      ? base.personaFlagUpdates
      : incoming.personaFlagUpdates);

  return {
    ...base,
    ...incoming,
    ...(cardRevealsEntry ? { cardReveals: cardRevealsEntry } : {}),
    ...(personaEntry ? { personaFlagUpdates: personaEntry } : {}),
  } satisfies Partial<TurnMetadata>;
}

/**
 * Combines two card-reveal metadata objects by appending community reveals and
 * merging hole-card entries, returning `undefined` when no reveals exist in
 * either input. Incoming entries overwrite existing player reveals.
 */
function mergeCardRevealMetadata(
  base: CardRevealMetadata | undefined,
  incoming: CardRevealMetadata | undefined,
): CardRevealMetadata | undefined {
  if (!incoming) {
    return base;
  }
  if (!base) {
    return incoming;
  }

  const communityEntries = [
    ...(base.community ?? []),
    ...(incoming.community ?? []),
  ];

  const combinedHoleCards: Partial<Record<PlayerId, readonly Card[]>> = {
    ...(base.holeCards ?? {}),
  };

  if (incoming.holeCards) {
    for (const [playerId, cards] of Object.entries(incoming.holeCards)) {
      if (cards && cards.length > 0) {
        combinedHoleCards[playerId as PlayerId] = cards;
      }
    }
  }

  const holeCardEntries = Object.entries(combinedHoleCards).filter(
    ([, cards]) => Boolean(cards && cards.length > 0),
  );

  if (communityEntries.length === 0 && holeCardEntries.length === 0) {
    return undefined;
  }

  const metadata: CardRevealMetadata = {
    ...(communityEntries.length > 0 ? { community: communityEntries } : {}),
    ...(holeCardEntries.length > 0
      ? {
          holeCards: holeCardEntries.reduce<
            Partial<Record<PlayerId, readonly Card[]>>
          >((acc, [playerId, cards]) => {
            if (cards) {
              acc[playerId as PlayerId] = cards;
            }
            return acc;
          }, {}),
        }
      : {}),
  } satisfies CardRevealMetadata;

  return metadata;
}

/**
 * Merges partial persona/hand flag updates with incoming updates taking
 * precedence. Returns `undefined` when both inputs are `undefined`.
 */
function mergePersonaFlagUpdates(
  base: Partial<HandFlags> | undefined,
  incoming: Partial<HandFlags> | undefined,
): Partial<HandFlags> | undefined {
  if (!incoming) {
    return base;
  }
  if (!base) {
    return incoming;
  }
  return { ...base, ...incoming } satisfies Partial<HandFlags>;
}

interface EventIdContext {
  readonly sessionId: string;
  readonly handNumber: number;
  readonly counter: number;
  readonly timestamp: number;
  readonly entropy: string;
}

function createDeterministicUlid(context: EventIdContext): string {
  const timeComponent = encodeTimeComponent(context.timestamp);
  const randomComponent = encodeRandomComponent(deriveEntropyBytes(context));
  return `${timeComponent}${randomComponent}`;
}

function encodeTimeComponent(timestamp: number): string {
  let value = Math.max(0, Math.trunc(timestamp));
  if (value > ULID_TIME_MAX) {
    value = ULID_TIME_MAX;
  }
  const chars = new Array<string>(ULID_TIME_LENGTH);
  for (let index = ULID_TIME_LENGTH - 1; index >= 0; index -= 1) {
    const charIndex = value % 32;
    chars[index] = ULID_ALPHABET.charAt(charIndex);
    value = Math.floor(value / 32);
  }
  return chars.join('');
}

function encodeRandomComponent(bytes: Uint8Array): string {
  const chars = new Array<string>(ULID_RANDOM_LENGTH);
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5 && index < ULID_RANDOM_LENGTH) {
      bits -= 5;
      const charIndex = (buffer >> bits) & 0b11111;
      chars[index] = ULID_ALPHABET.charAt(charIndex);
      index += 1;
      buffer &= (1 << bits) - 1;
    }
  }

  if (index < ULID_RANDOM_LENGTH && bits > 0) {
    const charIndex = (buffer << (5 - bits)) & 0b11111;
    chars[index] = ULID_ALPHABET.charAt(charIndex);
    index += 1;
  }

  while (index < ULID_RANDOM_LENGTH) {
    chars[index] = ULID_ALPHABET.charAt(0);
    index += 1;
  }

  return chars.join('');
}

function deriveEntropyBytes(context: EventIdContext): Uint8Array {
  const payload = [
    context.sessionId,
    context.handNumber.toString(10),
    context.counter.toString(10),
    Math.trunc(context.timestamp).toString(10),
    context.entropy,
  ].join(':');

  const hash = sha256(utf8ToBytes(payload));
  return hash.slice(0, ULID_RANDOM_BYTES);
}

export {
  createValidationConfig,
  deriveLegalOptionsForActor,
} from './legal-options';
