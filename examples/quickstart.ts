// poker-engine-ts quickstart (Texas Hold'em, no-limit).
//
// This is the exact snippet from the README, runnable as-is. The only change
// from the README is the import path: it imports from '../src' so `pnpm
// example:quickstart` runs against the source without a build step. In your
// own app, import from 'poker-engine-ts'.
import {
  SessionManager,
  selectDecisionContext,
  selectTableView,
} from '../src/index';
import type {
  Card,
  SeatBootstrapConfig,
  SessionConfig,
} from '../src/index';

// Describe the table. bettingStructure: 'no-limit' | 'pot-limit' | 'fixed-limit'.
// autoAdvance lets the engine roll streets forward and settle on its own.
const config: SessionConfig = {
  tableVariant: 'texas-holdem',
  bettingStructure: 'no-limit',
  maxSeats: 2,
  startingStack: 100,
  blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
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
    cacheSize: 1024,
  },
  autoAdvance: true,
};

const seats: readonly SeatBootstrapConfig[] = [
  { playerId: 'hero', seatIndex: 0, stack: 100 },
  { playerId: 'villain', seatIndex: 1, stack: 100 },
];

// A fixed, ordered deck feeds the community board as streets auto-advance.
const deck: readonly Card[] = [
  'As', 'Ks', 'Qs', 'Js', 'Ts', '9s', '8s', '7s', '6s', '5s',
];

// The event log is the source of truth; the manager holds the reduced
// TableSnapshot plus checkpoints for replay.
const manager = SessionManager.create(config, seats, { deck });

// Drive the hand: ask the engine whose turn it is and what is legal, then
// submit one intent per decision. Checking and calling runs the board out.
for (let guard = 0; guard < 100; guard += 1) {
  const decision = selectDecisionContext(manager.session);
  if (!decision.actor) break; // nobody left to act: settled or run out

  const legal = decision.availableActions.filter((o) => !o.disabled);
  const choice =
    legal.find((o) => o.type === 'check') ??
    legal.find((o) => o.type === 'call');
  if (!choice) break;

  const result = await manager.applyIntent({
    id: `${decision.actor}-${guard}`,
    actor: decision.actor,
    requested:
      choice.type === 'call'
        ? { type: 'call', amount: choice.amount }
        : { type: 'check' },
    origin: 'ui',
    issuedAt: Date.now(),
    expectedSnapshotVersion: manager.session.activeSnapshot.index,
  });
  if (result.validation.kind !== 'accepted') {
    throw new Error(`intent rejected: ${result.validation.reason}`);
  }
}

const table = selectTableView(manager.session);
console.log('stage', manager.session.activeSnapshot.hand.stage); // 'showdown'
console.log('board', table.board.flop, table.board.turn, table.board.river);
console.log('pot  ', table.potTotal);
