import { describe, expect, test } from 'vitest';

import {
  SessionManager,
  appendReplayEntry,
  selectDecisionContext,
  selectTableView,
} from '..';
import type { ReplayQueueEntry } from '../replay/queue';
import type { SimulationPolicy } from '../types/config';
import type {
  PlayerOption,
  TurnEventEnvelope,
  TurnIntent,
} from '../types/events';
import type { SessionConfig, SimulationRequest } from '../types/session';

const SIMULATION_POLICY = {
  maxIterations: 300,
  convergenceEpsilon: 0.01,
  supportsPartialInformation: true,
} as const;

const ADVISORY_CHANNEL = {
  requestTopic: 'advisor:requests',
  responseTopic: 'advisor:responses',
  timeoutMs: 2_750,
} as const;

const REPLAY_CHANNEL = {
  transport: 'filesystem' as const,
  retentionHands: 2,
};

describe('Batch S3 – Advisor & Replay Systems', () => {
  test('advisor dispatch exposes the configured timeout for downstream workers', async () => {
    const config = createConfig();
    const requests: SimulationRequest[] = [];

    const manager = SessionManager.create(config, buildSeats(3), {
      channels: {
        advisory: ADVISORY_CHANNEL,
        replay: REPLAY_CHANNEL,
      },
      hooks: {
        simulationRequested: {
          id: 'record-request',
          priority: 1,
          handler: async (request) => {
            requests.push(request);
          },
        },
      },
      now: () => 10_000,
    });

    const decision = selectDecisionContext(manager.session);
    const actor = decision.actor ?? 'player-1';
    const option =
      decision.availableActions.find((action) => action.type === 'check') ??
      decision.availableActions[0]!;

    const intent = buildIntent(
      actor,
      option,
      manager.session.activeSnapshot.index,
      10_000,
    );

    const outcome = await manager.applyIntent(intent);
    const advisoryDispatch = outcome.channels.advisory;

    expect(advisoryDispatch).toBeDefined();
    expect(advisoryDispatch?.channel.timeoutMs).toBe(
      ADVISORY_CHANNEL.timeoutMs,
    );
    expect(advisoryDispatch?.channel.responseTopic).toBe(
      ADVISORY_CHANNEL.responseTopic,
    );
    expect(advisoryDispatch?.simulation?.resultChannel).toBe(
      ADVISORY_CHANNEL.responseTopic,
    );
    expect(outcome.session.channels.advisory.timeoutMs).toBe(
      ADVISORY_CHANNEL.timeoutMs,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.policy).toBe(config.simulationPolicy);

    const deadline =
      (outcome.eventEnvelope?.event.timestamp ?? 0) +
      (advisoryDispatch?.channel.timeoutMs ?? 0);
    expect(deadline).toBe(12_750);
  });

  test('replay queue captures the most recent envelopes without mutation', async () => {
    const config = createConfig();
    const manager = SessionManager.create(config, buildSeats(3), {
      channels: {
        advisory: ADVISORY_CHANNEL,
        replay: REPLAY_CHANNEL,
      },
    });

    const allEventIds: string[] = [];
    let queue: readonly ReplayQueueEntry[] = [];

    for (let index = 0; index < 3; index += 1) {
      let decision = selectDecisionContext(manager.session);

      if (!decision.actor || decision.availableActions.length === 0) {
        await manager.advanceHand();
        decision = selectDecisionContext(manager.session);
      }

      const actor = decision.actor;
      expect(actor).toBeDefined();
      const option =
        decision.availableActions.find((action) => action.type === 'check') ??
        decision.availableActions.find((action) => action.type !== 'fold') ??
        decision.availableActions[0];

      expect(option).toBeDefined();
      if (!actor || !option) {
        throw new Error('Expected a legal option for the replay capture loop.');
      }

      const intent = buildIntent(
        actor,
        option,
        manager.session.activeSnapshot.index,
        1_000 + index,
      );

      const outcome = await manager.applyIntent(intent);
      const eventId = outcome.eventEnvelope?.event.id;
      expect(eventId).toBeDefined();
      if (eventId) {
        allEventIds.push(eventId);
      }

      const dispatch = outcome.channels.replay;
      expect(dispatch).toBeDefined();

      const nextQueue = appendReplayEntry(
        queue,
        {
          id: dispatch!.event.event.id,
          recordedAt: dispatch!.event.event.timestamp,
          payloadVersion: dispatch!.event.envelopeVersion,
        },
        manager.session.channels.replay.retentionHands,
      );

      expect(nextQueue).not.toBe(queue);
      queue = nextQueue;
    }

    expect(queue.length).toBe(REPLAY_CHANNEL.retentionHands);
    expect(queue.map((entry) => entry.id)).toEqual(
      allEventIds.slice(-REPLAY_CHANNEL.retentionHands),
    );
    for (let index = 1; index < queue.length; index += 1) {
      expect(queue[index - 1]!.recordedAt).toBeLessThanOrEqual(
        queue[index]!.recordedAt,
      );
    }
  });

  test('advisor transcripts remain deterministic across identical replays', async () => {
    const firstLog = await runDeterministicSequence();
    const secondLog = await runDeterministicSequence();

    expect(firstLog).not.toHaveLength(0);
    expect(secondLog).toEqual(firstLog);
  });

  test('replay and advisory fan-out preserve ordering across subscribers', async () => {
    const config = createConfigWithSimulation({
      maxIterations: 32,
      convergenceEpsilon: 0.05,
      supportsPartialInformation: true,
    });

    const manager = SessionManager.create(config, buildSeats(3), {
      now: createDeterministicClock(),
      hooks: {
        simulationRequested: {
          id: 'noop',
          priority: 1,
          handler: async () => undefined,
        },
      },
    });

    const issuedAt = createTimestampGenerator();
    const replayRetention = manager.session.channels.replay.retentionHands;
    const replayQueues: [
      readonly ReplayQueueEntry[],
      readonly ReplayQueueEntry[],
    ] = [[], []];
    const advisoryStreams: [string[], string[]] = [[], []];

    for (let index = 0; index < 6; index += 1) {
      const decision = selectDecisionContext(manager.session);
      if (!decision.actor) break;
      const option = chooseOption(decision.availableActions);
      const intent = buildIntent(
        decision.actor,
        option,
        manager.session.activeSnapshot.index,
        issuedAt(),
      );

      const outcome = await manager.applyIntent(intent);
      expect(outcome.validation.kind).toBe('accepted');

      const replayDispatch = outcome.channels.replay;
      if (replayDispatch) {
        replayQueues[0] = appendReplayEntry(
          replayQueues[0],
          {
            id: replayDispatch.event.event.id,
            recordedAt: replayDispatch.event.event.timestamp,
            payloadVersion: replayDispatch.event.envelopeVersion,
          },
          replayRetention,
        );
        replayQueues[1] = appendReplayEntry(
          replayQueues[1],
          {
            id: replayDispatch.event.event.id,
            recordedAt: replayDispatch.event.event.timestamp,
            payloadVersion: replayDispatch.event.envelopeVersion,
          },
          replayRetention,
        );
      }

      const advisoryDispatch = outcome.channels.advisory;
      if (advisoryDispatch?.simulation) {
        advisoryStreams[0].push(
          advisoryDispatch.simulation.context.actor ?? '',
        );
        advisoryStreams[1].push(
          advisoryDispatch.simulation.context.actor ?? '',
        );
      }
    }

    expect(replayQueues[0]).toEqual(replayQueues[1]);
    expect(advisoryStreams[0]).toEqual(advisoryStreams[1]);
  });

  test('rewind recovery backfills state before accepting new advisor intents', async () => {
    const manager = SessionManager.create(
      createConfigWithSimulation(SIMULATION_POLICY),
      buildSeats(3),
      {
        now: createDeterministicClock(),
        idFactory: () => 'entropy',
        sessionId: 's3-recovery',
        hooks: {
          simulationRequested: {
            id: 'noop',
            priority: 1,
            handler: async () => undefined,
          },
        },
      },
    );

    const issuedAt = createTimestampGenerator();

    await applyDeterministicIntent(manager, issuedAt);
    await applyDeterministicIntent(manager, issuedAt);

    expect(manager.eventLog).toHaveLength(2);

    manager.enterReplay();
    const recovered = await manager.rewindTo(1);
    expect(recovered.metrics.recoveries).toBe(1);
    expect(manager.eventLog).toHaveLength(1);
    manager.exitReplay();

    const decision = selectDecisionContext(manager.session);
    expect(decision.actor).toBeDefined();

    const outcome = await applyDeterministicIntent(manager, issuedAt);
    expect(outcome.validation.kind).toBe('accepted');
    expect(manager.eventLog).toHaveLength(2);
  });
});

function createConfig(): SessionConfig {
  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats: 6,
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
      evaluatorId: 'lookup',
      supportsHiLo: false,
      cacheSize: 1_024,
    },
    simulationPolicy: SIMULATION_POLICY,
    autoAdvance: true,
  } satisfies SessionConfig;
}

function createConfigWithSimulation(
  simulationPolicy: SimulationPolicy,
): SessionConfig {
  return {
    ...createConfig(),
    simulationPolicy,
  } satisfies SessionConfig;
}

function buildSeats(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    stack: 100,
    seatIndex: index,
  }));
}

async function runDeterministicSequence(): Promise<
  readonly TurnEventEnvelope[]
> {
  const manager = SessionManager.create(createConfig(), buildSeats(3), {
    now: createDeterministicClock(),
    idFactory: () => 'deterministic',
    sessionId: 'advisor-determinism',
  });

  const issuedAt = createTimestampGenerator();

  for (let index = 0; index < 8; index += 1) {
    const decision = selectDecisionContext(manager.session);
    if (!decision.actor) {
      break;
    }

    const option = chooseOption(decision.availableActions);
    const intent = buildIntent(
      decision.actor,
      option,
      manager.session.activeSnapshot.index,
      issuedAt(),
    );

    const outcome = await manager.applyIntent(intent);
    expect(outcome.validation.kind).toBe('accepted');

    const table = selectTableView(outcome.session);
    if (table.handStage === 'showdown') {
      break;
    }
  }

  return manager.eventLog;
}

function buildIntent(
  actor: string,
  option: PlayerOption,
  version: number,
  issuedAt: number,
): TurnIntent {
  switch (option.type) {
    case 'fold':
      return {
        id: `${actor}-fold`,
        actor,
        requested: { type: 'fold' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    case 'check':
      return {
        id: `${actor}-check`,
        actor,
        requested: { type: 'check' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    case 'call':
      return {
        id: `${actor}-call`,
        actor,
        requested: { type: 'call', amount: option.amount },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    case 'bet':
      return {
        id: `${actor}-bet`,
        actor,
        requested: { type: 'bet', amount: option.min },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    case 'raise':
      return {
        id: `${actor}-raise`,
        actor,
        requested: { type: 'raise', amount: option.min, to: option.min },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    case 'all-in':
      return {
        id: `${actor}-all-in`,
        actor,
        requested: { type: 'all-in', amount: option.amount, from: 'bet' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    default:
      return {
        id: `${actor}-fallback-fold`,
        actor,
        requested: { type: 'fold' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
  }
}

async function applyDeterministicIntent(
  manager: SessionManager,
  issuedAt: () => number,
) {
  const decision = selectDecisionContext(manager.session);
  expect(decision.actor).toBeDefined();
  const option = chooseOption(decision.availableActions);
  const intent = buildIntent(
    decision.actor ?? 'unknown',
    option,
    manager.session.activeSnapshot.index,
    issuedAt(),
  );

  const outcome = await manager.applyIntent(intent);
  expect(outcome.validation.kind).toBe('accepted');
  return outcome;
}

function chooseOption(options: readonly PlayerOption[]): PlayerOption {
  const enabled = options.filter((option) => !option.disabled);
  expect(enabled.length).toBeGreaterThan(0);

  const priority: PlayerOption['type'][] = [
    'check',
    'call',
    'bet',
    'raise',
    'all-in',
    'fold',
  ];

  for (const type of priority) {
    const match = enabled.find((option) => option.type === type);
    if (match) {
      return match;
    }
  }

  return enabled[0]!;
}

function createTimestampGenerator(): () => number {
  let current = 2_000;
  return () => {
    current += 7;
    return current;
  };
}

function createDeterministicClock(): () => number {
  let current = 8_000;
  return () => {
    current += 11;
    return current;
  };
}
