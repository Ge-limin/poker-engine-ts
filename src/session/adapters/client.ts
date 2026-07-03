'use client';

import { useMemo } from 'react';

import {
  selectDecisionContext,
  selectHandSummary,
  selectTableView,
} from '../selectors';
import type {
  RuntimeContext,
  Session,
  TurnEvent,
} from '../../types/index';
import type {
  DecisionContextView,
  HandSummaryView,
  TableView,
} from '../../types/index';

export interface SessionViewModel {
  readonly table: TableView;
  readonly decision: DecisionContextView;
  readonly summary: HandSummaryView;
  readonly runtime: RuntimeContext;
}

export interface ScenarioTimelineEntry {
  readonly index: number;
  readonly event: TurnEvent;
  readonly isCurrent: boolean;
  readonly isFuture: boolean;
}

const EMPTY_TIMELINE: readonly ScenarioTimelineEntry[] = [];

export function deriveSessionView(session: Session): SessionViewModel {
  return {
    table: selectTableView(session),
    decision: selectDecisionContext(session),
    summary: selectHandSummary(session),
    runtime: session.runtimeContext,
  } satisfies SessionViewModel;
}

export function deriveScenarioTimeline(
  session: Session,
): readonly ScenarioTimelineEntry[] {
  const events = session.events;

  if (events.length === 0) {
    return [];
  }

  const pointer = resolveTimelinePointer(session.runtimeContext, events.length);

  const effectivePointer =
    pointer === null ? null : Math.min(pointer, events.length - 1);

  return events.map((event, index) => ({
    index,
    event,
    isCurrent:
      effectivePointer === null
        ? index === events.length - 1
        : index === effectivePointer,
    isFuture: effectivePointer === null ? false : index > effectivePointer,
  }));
}

export function isInteractiveRuntime(session: Session): boolean {
  const context = session.runtimeContext;
  if (context.mode === 'live') {
    return true;
  }
  if (context.mode === 'scenario') {
    return !context.isCompleted && context.viewingIndex === null;
  }
  return false;
}

export function useSessionView(
  session: Session | null,
): SessionViewModel | null {
  return useSessionMemo(session, null, deriveSessionView);
}

export function useScenarioTimeline(
  session: Session | null,
): readonly ScenarioTimelineEntry[] {
  return useSessionMemo(session, EMPTY_TIMELINE, deriveScenarioTimeline);
}

export interface ClientSessionAdapter {
  readonly view: SessionViewModel | null;
  readonly timeline: readonly ScenarioTimelineEntry[];
  readonly interactive: boolean;
}

export function createClientSessionAdapter(
  session: Session | null,
): ClientSessionAdapter {
  const view = session ? deriveSessionView(session) : null;
  return {
    view,
    timeline: session ? deriveScenarioTimeline(session) : [],
    interactive: session ? isInteractiveRuntime(session) : false,
  } satisfies ClientSessionAdapter;
}

function resolveTimelinePointer(
  context: RuntimeContext,
  eventCount: number,
): number | null {
  switch (context.mode) {
    case 'replay':
      return Math.min(Math.max(context.timelineIndex, 0), eventCount);
    case 'scenario':
      return context.viewingIndex;
    default:
      return null;
  }
}

function resolveRuntimeSignature(context: RuntimeContext): string {
  switch (context.mode) {
    case 'replay':
      return [
        context.mode,
        context.timelineIndex,
        context.isPlaying,
        context.speed,
      ].join(':');
    case 'simulation':
      return [
        context.mode,
        context.simulationId,
        context.handsToRun,
        context.handsCompleted,
      ].join(':');
    case 'scenario':
      return [
        context.mode,
        context.scenarioId,
        context.isCompleted,
        context.viewingIndex,
      ].join(':');
    case 'live':
    default:
      return context.mode;
  }
}

function useSessionMemo<T>(
  session: Session | null,
  fallback: T,
  projector: (session: Session) => T,
): T {
  const snapshotIndex = session?.activeSnapshot.index;
  const runtimeSignature = session
    ? resolveRuntimeSignature(session.runtimeContext)
    : null;
  const eventCount = session?.events.length ?? 0;

  return useMemo(() => {
    if (!session) {
      return fallback;
    }
    void snapshotIndex;
    void runtimeSignature;
    void eventCount;
    return projector(session);
  }, [
    session,
    snapshotIndex,
    runtimeSignature,
    eventCount,
    fallback,
    projector,
  ]);
}
