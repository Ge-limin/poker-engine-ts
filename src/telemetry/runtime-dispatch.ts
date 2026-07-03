import type { RuntimeMode } from '../types/common';
import type { TelemetryEventView } from '../types/derived';
import type { SnapshotEnvelope, TurnEventEnvelope } from '../types/events';
import type {
  RuntimeContext,
  Session,
  SimulationRequest,
} from '../types/session';
import type { TableSnapshot } from '../types/snapshot';

export interface RuntimeDispatchMetadata {
  readonly mode: RuntimeMode;
  readonly eventIndex?: number;
  readonly replay?: {
    readonly timelineIndex: number;
    readonly isPlaying: boolean;
    readonly speed: number;
  };
  readonly simulation?: {
    readonly simulationId: string;
    readonly handsToRun: number;
    readonly handsCompleted: number;
  };
  readonly scenario?: {
    readonly scenarioId: string;
    readonly isCompleted: boolean;
    readonly viewingIndex: number | null;
  };
}

export interface TelemetryDispatchEnvelope {
  readonly channel: Session['channels']['analytics'];
  readonly event: TelemetryEventView;
  readonly metadata: RuntimeDispatchMetadata;
}

export interface ReplayDispatchEnvelope {
  readonly channel: Session['channels']['replay'];
  readonly event: TurnEventEnvelope;
  readonly snapshot: SnapshotEnvelope<TableSnapshot>;
  readonly metadata: RuntimeDispatchMetadata;
}

export interface AdvisoryDispatchEnvelope {
  readonly channel: Session['channels']['advisory'];
  readonly simulation?: SimulationRequest;
  readonly metadata: RuntimeDispatchMetadata;
}

export interface ChannelDispatches {
  readonly telemetry?: TelemetryDispatchEnvelope;
  readonly replay?: ReplayDispatchEnvelope;
  readonly advisory?: AdvisoryDispatchEnvelope;
}

export interface RuntimeDispatchSink {
  readonly id: string;
  readonly onTelemetry?: (
    payload: TelemetryDispatchEnvelope,
  ) => void | Promise<void>;
  readonly onReplay?: (payload: ReplayDispatchEnvelope) => void | Promise<void>;
  readonly onAdvisory?: (
    payload: AdvisoryDispatchEnvelope,
  ) => void | Promise<void>;
}

export interface RuntimeDispatchBus {
  register: (sink: RuntimeDispatchSink) => () => void;
  dispatch: (envelopes: ChannelDispatches) => Promise<void>;
  sinkCount: () => number;
}

export interface RuntimeDispatchBuffer {
  readonly telemetry: TelemetryDispatchEnvelope[];
  readonly replay: ReplayDispatchEnvelope[];
  readonly advisory: AdvisoryDispatchEnvelope[];
}

export interface BufferSinkOptions {
  readonly id?: string;
  readonly limit?: number;
}

export interface ConsoleSinkOptions {
  readonly id?: string;
  readonly logger?: Pick<typeof console, 'log' | 'warn'>;
}

export type RuntimeDispatchHandler<T> = (payload: T) => void | Promise<void>;

export function createRuntimeDispatchMetadata(
  context: RuntimeContext,
  eventIndex?: number,
): RuntimeDispatchMetadata {
  switch (context.mode) {
    case 'replay':
      return {
        mode: context.mode,
        eventIndex,
        replay: {
          timelineIndex: context.timelineIndex,
          isPlaying: context.isPlaying,
          speed: context.speed,
        },
      } satisfies RuntimeDispatchMetadata;
    case 'simulation':
      return {
        mode: context.mode,
        eventIndex,
        simulation: {
          simulationId: context.simulationId,
          handsToRun: context.handsToRun,
          handsCompleted: context.handsCompleted,
        },
      } satisfies RuntimeDispatchMetadata;
    case 'scenario':
      return {
        mode: context.mode,
        eventIndex,
        scenario: {
          scenarioId: context.scenarioId,
          isCompleted: context.isCompleted,
          viewingIndex: context.viewingIndex,
        },
      } satisfies RuntimeDispatchMetadata;
    case 'live':
    default:
      return {
        mode: context.mode,
        eventIndex,
      } satisfies RuntimeDispatchMetadata;
  }
}

export function createRuntimeDispatchBus(): RuntimeDispatchBus {
  const sinks = new Map<string, RuntimeDispatchSink>();

  function register(sink: RuntimeDispatchSink): () => void {
    sinks.set(sink.id, sink);
    return () => {
      sinks.delete(sink.id);
    };
  }

  async function dispatch(envelopes: ChannelDispatches): Promise<void> {
    const deliveries: Promise<void>[] = [];
    for (const sink of sinks.values()) {
      if (envelopes.telemetry && sink.onTelemetry) {
        deliveries.push(Promise.resolve(sink.onTelemetry(envelopes.telemetry)));
      }
      if (envelopes.replay && sink.onReplay) {
        deliveries.push(Promise.resolve(sink.onReplay(envelopes.replay)));
      }
      if (envelopes.advisory && sink.onAdvisory) {
        deliveries.push(Promise.resolve(sink.onAdvisory(envelopes.advisory)));
      }
    }
    if (deliveries.length === 0) {
      return;
    }
    await Promise.all(deliveries);
  }

  function sinkCount(): number {
    return sinks.size;
  }

  return { register, dispatch, sinkCount } satisfies RuntimeDispatchBus;
}

export function createInMemoryBufferSink(options: BufferSinkOptions = {}): {
  sink: RuntimeDispatchSink;
  buffer: RuntimeDispatchBuffer;
} {
  const limit = options.limit ?? 1_000;
  const buffer: RuntimeDispatchBuffer = {
    telemetry: [],
    replay: [],
    advisory: [],
  };

  function push<TEntry>(collection: TEntry[], entry: TEntry): void {
    collection.push(entry);
    if (collection.length > limit) {
      collection.shift();
    }
  }

  const sink: RuntimeDispatchSink = {
    id: options.id ?? 'runtime-dispatch-buffer',
    onTelemetry: (payload) => {
      push(buffer.telemetry, payload);
    },
    onReplay: (payload) => {
      push(buffer.replay, payload);
    },
    onAdvisory: (payload) => {
      push(buffer.advisory, payload);
    },
  };

  return { sink, buffer };
}

export function createConsoleSink(
  options: ConsoleSinkOptions = {},
): RuntimeDispatchSink {
  const logger = options.logger ?? console;
  return {
    id: options.id ?? 'runtime-dispatch-console',
    onTelemetry: (payload) => {
      logger.log('[telemetry]', payload.metadata.mode, payload.event);
    },
    onReplay: (payload) => {
      logger.log('[replay]', payload.metadata.mode, payload.event.event.id);
    },
    onAdvisory: (payload) => {
      const descriptor = payload.simulation
        ? `${payload.simulation.context.actor ?? 'unknown'}@${payload.simulation.resultChannel}`
        : 'no-simulation';
      logger.warn('[advisory]', payload.metadata.mode, descriptor);
    },
  } satisfies RuntimeDispatchSink;
}

export interface CallbackSinkOptions {
  readonly id: string;
  readonly telemetry?: RuntimeDispatchHandler<TelemetryDispatchEnvelope>;
  readonly replay?: RuntimeDispatchHandler<ReplayDispatchEnvelope>;
  readonly advisory?: RuntimeDispatchHandler<AdvisoryDispatchEnvelope>;
}

export function createCallbackSink(
  options: CallbackSinkOptions,
): RuntimeDispatchSink {
  return {
    id: options.id,
    onTelemetry: options.telemetry,
    onReplay: options.replay,
    onAdvisory: options.advisory,
  } satisfies RuntimeDispatchSink;
}

export function attachDispatchBus(
  bus: RuntimeDispatchBus,
  channels: ChannelDispatches,
): Promise<void> {
  return bus.dispatch(channels);
}
