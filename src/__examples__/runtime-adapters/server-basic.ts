import {
  type SeatBootstrapConfig,
  type SessionConfig,
  type TurnIntent,
  createConsoleSink,
  createInMemoryBufferSink,
  createRuntimeDispatchBus,
  createServerSessionAdapter,
  selectDecisionContext,
} from '../../index';
import { createSessionStore } from '../../testing/index';

const store = createSessionStore();
const bus = createRuntimeDispatchBus();
const { sink, buffer } = createInMemoryBufferSink({ id: 'example-buffer' });
bus.register(sink);
bus.register(createConsoleSink({ id: 'example-console' }));

const adapter = createServerSessionAdapter({
  repository: {
    get: async (id) => store.getSession(id),
    set: async (session) => {
      store.saveSession(session);
    },
  },
  dispatchBus: bus,
});

const CONFIG: SessionConfig = {
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
    showdownOrdering: 'high-card',
    cardDistribution: {
      holeCardsPerPlayer: 2,
      burnPerStreet: [0, 1, 1],
      communityReveal: [0, 3, 1, 1],
    },
  },
  evaluationPolicy: {
    engine: 'lookup-table',
    evaluatorId: 'default',
    supportsHiLo: false,
    cacheSize: 1_024,
  },
  simulationPolicy: undefined,
  autoAdvance: true,
};

const SEATS: readonly SeatBootstrapConfig[] = [
  { playerId: 'alice', seatIndex: 0, stack: 100 },
  { playerId: 'bob', seatIndex: 1, stack: 100 },
];

export async function runServerAdapterExample(): Promise<{
  readonly sessionId: string;
  readonly telemetrySamples: number;
}> {
  const session = await adapter.createSession(CONFIG, SEATS);

  const decision = selectDecisionContext(session);
  const action = decision.availableActions.find((entry) => !entry.disabled);

  if (!decision.actor || !action) {
    return { sessionId: session.id, telemetrySamples: buffer.telemetry.length };
  }

  const intent: TurnIntent = {
    id: `${decision.actor}-${action.type}`,
    actor: decision.actor,
    requested:
      action.type === 'call'
        ? { type: 'call', amount: action.amount }
        : { type: 'check' },
    origin: 'ui',
    issuedAt: Date.now(),
    expectedSnapshotVersion: session.activeSnapshot.index,
  };

  await adapter.applyTurnIntent(session.id, intent);

  const latest = await adapter.getSession(session.id);
  if (latest) {
    store.saveSession(latest);
  }

  return {
    sessionId: session.id,
    telemetrySamples: buffer.telemetry.length,
  };
}
