import type { PersonaAdjustmentView } from '../types/derived';
import type { SessionMetrics } from '../types/session';

export interface TelemetryPayload {
  readonly potDelta?: number;
  readonly latencyMs?: number;
  readonly personaAdjustments?: readonly PersonaAdjustmentView[];
}

export interface TelemetryUpdateContext {
  readonly intentSamples: number;
}

export interface TelemetryUpdateResult {
  readonly metrics: SessionMetrics;
  readonly context: TelemetryUpdateContext;
}

export function updateSessionMetrics(
  metrics: SessionMetrics,
  payload: TelemetryPayload,
  context: TelemetryUpdateContext,
): TelemetryUpdateResult {
  const potDelta = payload.potDelta ?? 0;
  const personaAdjustments = payload.personaAdjustments ?? [];
  const latency = payload.latencyMs ?? 0;

  const potsAwardedIncrement = potDelta > 0 ? 1 : 0;
  const totalPotValue =
    metrics.averagePot * metrics.potsAwarded + Math.max(potDelta, 0);
  const updatedPotsAwarded = metrics.potsAwarded + potsAwardedIncrement;
  const averagePot =
    updatedPotsAwarded === 0
      ? metrics.averagePot
      : totalPotValue / updatedPotsAwarded;

  const totalLatency =
    metrics.avgIntentLatencyMs * context.intentSamples + latency;
  const intentSamples = context.intentSamples + 1;
  const avgIntentLatencyMs =
    intentSamples === 0 ? 0 : totalLatency / intentSamples;
  const maxIntentLatencyMs = Math.max(metrics.maxIntentLatencyMs, latency);

  const advisoryEquityRequests =
    metrics.advisoryEquityRequests + personaAdjustments.length;

  return {
    metrics: {
      ...metrics,
      potsAwarded: updatedPotsAwarded,
      averagePot,
      avgIntentLatencyMs,
      maxIntentLatencyMs,
      advisoryEquityRequests,
    },
    context: { intentSamples },
  };
}
