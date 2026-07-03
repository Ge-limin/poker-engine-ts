import type { SeatBootstrapConfig } from '../session/lifecycle';
import type { SessionConfig } from '../types/session';

export const DEFAULT_RANDOM_STATE_CONFIG: SessionConfig = {
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
    showdownOrdering: 'high-card',
    cardDistribution: {
      holeCardsPerPlayer: 2,
      burnPerStreet: [1, 1, 1],
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
} as const satisfies SessionConfig;

export const DEFAULT_RANDOM_STATE_SEATS: readonly SeatBootstrapConfig[] = [
  { playerId: 'alice', seatIndex: 0, stack: 100 },
  { playerId: 'bob', seatIndex: 1, stack: 100 },
  { playerId: 'carol', seatIndex: 2, stack: 100 },
  { playerId: 'dave', seatIndex: 3, stack: 100 },
  { playerId: 'erin', seatIndex: 4, stack: 100 },
  { playerId: 'frank', seatIndex: 5, stack: 100 },
] as const;
