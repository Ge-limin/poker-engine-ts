import { deriveRoundComputation } from '../core/intent/round-context';
import {
  calculateHandContributions,
  collectAllInPlayers,
  collectFoldedPlayers,
  deriveTurnOrderActors,
  findSeatByPlayerId,
  sumPotAmounts,
} from '../core/utils/snapshot';
import type { Chips, PlayerId } from '../types/common';
import type {
  DecisionContextView,
  HandSummaryView,
  PersonaAdjustmentView,
  PersonaSnapshotView,
  SimulationView,
  TableSeatView,
  TableView,
  TelemetryClockView,
  TelemetryEventView,
} from '../types/derived';
import type { TurnEvent } from '../types/events';
import type { PersonaProfile } from '../types/persona';
import type { Session } from '../types/session';
import type { TableSnapshot } from '../types/snapshot';
import { deriveLegalOptionsForActor } from './legal-options';

function memoizeBySnapshot<TValue>(
  projector: (session: Session) => TValue,
): (session: Session) => TValue {
  // Keyed on the immutable activeSnapshot object, not (id, index). Each
  // reduction produces a fresh snapshot, so a cache hit means the exact same
  // state; two distinct sessions always hold distinct snapshot objects, so
  // there is no cross-session bleed even when they share an id. The WeakMap
  // drops entries once a snapshot is unreachable, so a long-running backend
  // never accumulates stale projections.
  const cache = new WeakMap<TableSnapshot, TValue>();
  return (session) => {
    const snapshot = session.activeSnapshot;
    if (cache.has(snapshot)) {
      return cache.get(snapshot) as TValue;
    }
    const value = projector(session);
    cache.set(snapshot, value);
    return value;
  };
}

export interface TelemetryEventBuildContext {
  readonly snapshotBefore: TableSnapshot;
  readonly snapshotAfter?: TableSnapshot;
  readonly potBefore?: Chips;
  readonly potAfter?: Chips;
  readonly eventIndex?: number;
  readonly personaAdjustments?: readonly PersonaAdjustmentView[];
  readonly latencyMs?: number;
}

function createTelemetryClockView(
  clock: TableSnapshot['clock'],
): TelemetryClockView {
  return {
    currentActor: clock.currentActor,
    deadline: clock.deadline,
    perTurnMs: clock.perTurnMs,
    bankMs: { ...clock.bankMs },
  } satisfies TelemetryClockView;
}

function createPersonaSnapshotView(
  profile: PersonaProfile,
): PersonaSnapshotView {
  return {
    personaId: profile.personaId,
    style: profile.style,
    aggression: profile.aggression,
    tightness: profile.tightness,
    bluffIndex: profile.bluffIndex,
    riskTolerance: profile.riskTolerance,
    trackedMetrics: profile.adaptation.trackedMetrics,
    featureVector: [...profile.adaptation.featureVector],
    lastUpdated: profile.adaptation.lastUpdated,
    notes: profile.adaptation.notes,
  } satisfies PersonaSnapshotView;
}

function personaProfilesEqual(
  previous: PersonaProfile,
  next: PersonaProfile,
): boolean {
  if (previous.personaId !== next.personaId) return false;
  if (previous.style !== next.style) return false;
  if (previous.aggression !== next.aggression) return false;
  if (previous.tightness !== next.tightness) return false;
  if (previous.bluffIndex !== next.bluffIndex) return false;
  if (previous.riskTolerance !== next.riskTolerance) return false;
  if (!personaTelemetryEqual(previous, next)) return false;
  if (!featureVectorsEqual(previous, next)) return false;
  if (previous.adaptation.notes !== next.adaptation.notes) return false;
  return true;
}

function personaTelemetryEqual(
  previous: PersonaProfile,
  next: PersonaProfile,
): boolean {
  const prev = previous.adaptation.trackedMetrics;
  const nextMetrics = next.adaptation.trackedMetrics;
  return (
    prev.vpip === nextMetrics.vpip &&
    prev.pfr === nextMetrics.pfr &&
    prev.aggressionFactor === nextMetrics.aggressionFactor &&
    prev.showdownRate === nextMetrics.showdownRate &&
    prev.tiltIndicator === nextMetrics.tiltIndicator &&
    previous.adaptation.lastUpdated === next.adaptation.lastUpdated
  );
}

function featureVectorsEqual(
  previous: PersonaProfile,
  next: PersonaProfile,
): boolean {
  const left = previous.adaptation.featureVector;
  const right = next.adaptation.featureVector;
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function computePersonaAdjustments(
  before: TableSnapshot['personas'],
  after: TableSnapshot['personas'],
): PersonaAdjustmentView[] {
  const adjustments: PersonaAdjustmentView[] = [];
  const players = new Set([
    ...Object.keys(before.entries),
    ...Object.keys(after.entries),
  ]);

  for (const playerId of players) {
    const previousProfile = before.entries[playerId];
    const nextProfile = after.entries[playerId];
    if (!nextProfile) {
      continue;
    }
    if (!previousProfile) {
      adjustments.push({
        playerId,
        after: createPersonaSnapshotView(nextProfile),
      });
      continue;
    }
    if (personaProfilesEqual(previousProfile, nextProfile)) {
      continue;
    }
    adjustments.push({
      playerId,
      before: createPersonaSnapshotView(previousProfile),
      after: createPersonaSnapshotView(nextProfile),
    });
  }

  return adjustments;
}

export const selectTableView = memoizeBySnapshot<TableView>(
  (session) => {
    const snapshot = session.activeSnapshot;
    const contributions = calculateHandContributions(snapshot.pots);
    const foldedPlayers = collectFoldedPlayers(snapshot.hand);
    const allInPlayers = collectAllInPlayers(snapshot);
    const currentActor = snapshot.clock.currentActor;
    const availableActions = deriveLegalOptionsForActor(
      snapshot,
      currentActor,
      {
        sessionConfig: session.config,
      },
    );

    const seats: TableSeatView[] = snapshot.seating.seats.map((seat) => {
      const occupant = seat.occupant;
      const playerId = occupant?.playerId;
      const contribution = playerId ? (contributions.get(playerId) ?? 0) : 0;
      const isAllIn = Boolean(playerId && allInPlayers.has(playerId));
      const isActive = Boolean(
        playerId &&
          !foldedPlayers.has(playerId) &&
          seat.status === 'occupied' &&
          !snapshot.flags.pendingEliminations.includes(playerId),
      );

      return {
        seatIndex: seat.index,
        status: seat.status,
        playerId,
        displayName: occupant?.displayName,
        stack: seat.stack,
        contribution,
        isActive,
        isAllIn,
      } satisfies TableSeatView;
    });

    const board = snapshot.cards.community;

    return {
      handNumber: snapshot.handNumber,
      dealerButton: snapshot.seating.dealerButton,
      seats,
      board: {
        flop: board.flop,
        turn: board.turn,
        river: board.river,
        revealSchedule: board.revealSchedule,
      },
      potTotal: sumPotAmounts(snapshot.pots),
      pots: snapshot.pots,
      handStage: snapshot.hand.stage,
      currentActor,
      availableActions,
      clock: snapshot.clock,
      flags: snapshot.flags,
    } satisfies TableView;
  },
);

export const selectDecisionContext =
  memoizeBySnapshot<DecisionContextView>((session) => {
    const snapshot = session.activeSnapshot;
    const round = snapshot.hand.bettingRounds.at(-1);
    const foldedPlayers = collectFoldedPlayers(snapshot.hand);
    const allInPlayers = collectAllInPlayers(snapshot);
    const actor = snapshot.clock.currentActor;
    const availableActions = deriveLegalOptionsForActor(snapshot, actor, {
      sessionConfig: session.config,
    });
    const potSize = sumPotAmounts(snapshot.pots);

    const playersLeftToAct = round
      ? derivePlayersLeftToAct(snapshot, round, foldedPlayers, allInPlayers)
      : [];

    const effectiveStack = actor
      ? resolveEffectiveStack(snapshot, actor, foldedPlayers, allInPlayers)
      : 0;

    return {
      handNumber: snapshot.handNumber,
      actor,
      handStage: snapshot.hand.stage,
      potSize,
      effectiveStack,
      playersLeftToAct,
      availableActions,
    } satisfies DecisionContextView;
  });

export const selectHandSummary = memoizeBySnapshot<HandSummaryView>(
  (session) => {
    const snapshot = session.activeSnapshot;
    const payouts = snapshot.hand.payouts?.entries ?? [];

    return {
      handNumber: snapshot.handNumber,
      winners: payouts.map((entry) => ({
        playerId: entry.playerId,
        amount: entry.amount,
        potIds: entry.potIds,
      })),
      pendingEliminations: snapshot.flags.pendingEliminations,
      showdown: snapshot.hand.showdown,
    } satisfies HandSummaryView;
  },
);

export function selectTelemetryEvent(
  session: Session,
  event: TurnEvent,
  context?: TelemetryEventBuildContext,
): TelemetryEventView {
  const snapshotAfter = context?.snapshotAfter ?? session.activeSnapshot;
  const snapshotBefore = context?.snapshotBefore;
  const potAfter = context?.potAfter ?? sumPotAmounts(snapshotAfter.pots);
  const providedPotBefore =
    context?.potBefore ??
    (snapshotBefore ? sumPotAmounts(snapshotBefore.pots) : undefined);
  const potBefore =
    providedPotBefore !== undefined
      ? providedPotBefore
      : potAfter - event.contribution;
  const potDelta = potAfter - potBefore;
  const personaAdjustments =
    context?.personaAdjustments ??
    (snapshotBefore
      ? computePersonaAdjustments(
          snapshotBefore.personas,
          snapshotAfter.personas,
        )
      : []);
  const metadata = event.metadata;
  const availableActionsAtDecision =
    metadata?.availableActionsAtDecision ?? event.legalOptions;
  const latencyMs =
    context?.latencyMs ?? metadata?.networkLatencyMs ?? metadata?.validationMs;

  return {
    sessionId: session.id,
    eventId: event.id,
    eventIndex: context?.eventIndex,
    handNumber: snapshotAfter.handNumber,
    handStage: snapshotAfter.hand.stage,
    snapshotVersion: snapshotAfter.index,
    actor: event.actor,
    action: event.action,
    stackBefore: event.stackBefore,
    stackAfter: event.stackAfter,
    contribution: event.contribution,
    potBefore,
    potTotal: potAfter,
    potDelta,
    latencyMs,
    runtimeMode: session.runtimeContext.mode,
    occurredAt: event.timestamp,
    metadata,
    legalOptions: event.legalOptions,
    availableActionsAtDecision,
    personaAdjustments,
    clock: createTelemetryClockView(snapshotAfter.clock),
    handFlags: {
      showdownLocked: snapshotAfter.flags.showdownLocked,
      autoRunout: snapshotAfter.flags.autoRunout,
      advisoryPending: snapshotAfter.flags.advisoryPending,
    },
  } satisfies TelemetryEventView;
}

export const selectSimulationView = memoizeBySnapshot<SimulationView>(
  (session) => {
    const snapshot = session.activeSnapshot;
    const personas = Object.entries(snapshot.personas.entries).map(
      ([playerId, profile]) => ({
        playerId,
        profile,
      }),
    );

    const seatStacks: Record<PlayerId, number> = {};
    for (const seat of snapshot.seating.seats) {
      const occupant = seat.occupant;
      if (!occupant) continue;
      seatStacks[occupant.playerId] = seat.stack;
    }

    return {
      handNumber: snapshot.handNumber,
      deckSeed: snapshot.hand.deckSeed,
      remainingDeck: snapshot.cards.remainingDeck,
      community: snapshot.cards.community,
      seatStacks,
      ruleSet: session.config.ruleSet,
      personas,
    } satisfies SimulationView;
  },
);

function derivePlayersLeftToAct(
  snapshot: TableSnapshot,
  round: TableSnapshot['hand']['bettingRounds'][number],
  foldedPlayers: Set<PlayerId>,
  allInPlayers: Set<PlayerId>,
): PlayerId[] {
  const computation = deriveRoundComputation(round);
  const actorsThisRound = new Set(round.turns.map((turn) => turn.actor));
  const actorOrder = deriveTurnOrderActors(round, snapshot.seating);
  const pendingEliminations = new Set(snapshot.flags.pendingEliminations);
  const eligiblePlayers = actorOrder.filter((playerId) => {
    if (foldedPlayers.has(playerId)) {
      return false;
    }
    if (allInPlayers.has(playerId)) {
      return false;
    }
    if (pendingEliminations.has(playerId)) {
      return false;
    }
    return true;
  });

  if (eligiblePlayers.length <= 1) {
    return [];
  }

  const playersLeft: PlayerId[] = [];

  for (const playerId of eligiblePlayers) {
    const hasActed = actorsThisRound.has(playerId);
    const contribution = computation.contributions.get(playerId) ?? 0;
    const owesCall = contribution < computation.highestContribution;
    if (!hasActed || owesCall) {
      playersLeft.push(playerId);
    }
  }

  return playersLeft;
}

function resolveEffectiveStack(
  snapshot: TableSnapshot,
  actor: PlayerId,
  foldedPlayers: Set<PlayerId>,
  allInPlayers: Set<PlayerId>,
): number {
  const seat = findSeatByPlayerId(snapshot.seating, actor);
  if (!seat) return 0;

  let effective = seat.seat.stack;
  for (const otherSeat of snapshot.seating.seats) {
    const occupant = otherSeat.occupant;
    if (!occupant) continue;
    if (foldedPlayers.has(occupant.playerId)) continue;
    if (allInPlayers.has(occupant.playerId)) continue;
    if (occupant.playerId === actor) continue;
    effective = Math.min(effective, otherSeat.stack);
  }
  return effective;
}
