import type { RealtimeChannel } from '@supabase/supabase-js';

import type {
  AdvisoryDispatchEnvelope,
  ReplayDispatchEnvelope,
  RuntimeDispatchSink,
  TelemetryDispatchEnvelope,
} from '../../telemetry/runtime-dispatch';

export interface SupabaseRealtimeClient {
  readonly channel: (
    name: string,
    options?: { config?: { broadcast?: { ack?: boolean } } },
  ) => RealtimeChannel;
}

export interface SupabaseRealtimeSinkOptions {
  readonly client: SupabaseRealtimeClient;
  readonly channelName: string;
  readonly id?: string;
  readonly eventPrefix?: string;
}

export class SupabaseRealtimeError extends Error {
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
    this.name = 'SupabaseRealtimeError';
  }
}

export function createSupabaseRealtimeSink(
  options: SupabaseRealtimeSinkOptions,
): RuntimeDispatchSink {
  const channel = options.client.channel(options.channelName, {
    config: { broadcast: { ack: true } },
  });
  const prefix = options.eventPrefix ?? 'poker-engine';
  const sinkId = options.id ?? `supabase-realtime-${options.channelName}`;

  let subscriptionPromise: Promise<void> | null = null;
  let isSubscribed = false;

  async function ensureSubscribed(): Promise<void> {
    if (isSubscribed) {
      return;
    }

    if (!subscriptionPromise) {
      subscriptionPromise = new Promise<void>((resolve, reject) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            isSubscribed = true;
            resolve();
          } else if (
            status === 'CHANNEL_ERROR' ||
            status === 'TIMED_OUT' ||
            status === 'CLOSED'
          ) {
            reject(
              new SupabaseRealtimeError(
                'Failed to subscribe to realtime channel.',
                {
                  context: { status, channel: options.channelName },
                },
              ),
            );
          }
        });
      });
    }

    await subscriptionPromise;
  }

  async function broadcast(
    type: 'telemetry' | 'replay' | 'advisory',
    payload:
      | TelemetryDispatchEnvelope
      | ReplayDispatchEnvelope
      | AdvisoryDispatchEnvelope,
  ): Promise<void> {
    await ensureSubscribed();

    const result = await channel.send({
      type: 'broadcast',
      event: `${prefix}.${type}`,
      payload,
    });

    if (typeof result === 'object' && result !== null) {
      const status = (result as { status?: string }).status;
      if (status && status !== 'ok') {
        throw new SupabaseRealtimeError(
          'Failed to broadcast realtime payload.',
          {
            context: { type, status, channel: options.channelName },
          },
        );
      }
    }
  }

  return {
    id: sinkId,
    onTelemetry: async (payload) => {
      await broadcast('telemetry', payload);
    },
    onReplay: async (payload) => {
      await broadcast('replay', payload);
    },
    onAdvisory: async (payload) => {
      await broadcast('advisory', payload);
    },
  } satisfies RuntimeDispatchSink;
}
