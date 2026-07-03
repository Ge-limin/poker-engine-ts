import { describe, expect, test } from 'vitest';

import {
  SessionManager,
  deriveRoundComputation,
  determineLegalOptions,
  selectTableView,
} from '..';
import type {
  BettingRound,
  Card,
  PlayerId,
  SeatBootstrapConfig,
  SessionConfig,
  TurnEvent,
} from '..';

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

const deck: readonly Card[] = [
  'As', 'Ks', 'Qs', 'Js', 'Ts', '9s', '8s', '7s', '6s', '5s',
];

describe('selector memoization is per-session, not process-global', () => {
  // Regression: selectors used to share one module-level cache keyed on
  // (session.id, snapshot.index). Two SessionManager.create() calls share the
  // default id 'session-1', so the second session used to read the first's
  // cached view. The cache is now keyed on the immutable snapshot object.
  test('two default-option sessions never share selector output', () => {
    const seatsA: SeatBootstrapConfig[] = [
      { playerId: 'a1', seatIndex: 0, stack: 100 },
      { playerId: 'a2', seatIndex: 1, stack: 100 },
    ];
    const seatsB: SeatBootstrapConfig[] = [
      { playerId: 'b1', seatIndex: 0, stack: 100 },
      { playerId: 'b2', seatIndex: 1, stack: 100 },
    ];

    const managerA = SessionManager.create(config, seatsA, {
      deck,
      now: () => 1_000,
    });
    const managerB = SessionManager.create(config, seatsB, {
      deck,
      now: () => 1_000,
    });

    // Both sessions share the default id and start at the same snapshot index,
    // which is exactly the collision the old global cache mishandled.
    expect(managerA.session.id).toBe(managerB.session.id);
    expect(managerA.session.activeSnapshot.index).toBe(
      managerB.session.activeSnapshot.index,
    );

    const viewA = selectTableView(managerA.session);
    const viewB = selectTableView(managerB.session);

    expect(viewA.seats.map((seat) => seat.playerId)).toEqual(['a1', 'a2']);
    expect(viewB.seats.map((seat) => seat.playerId)).toEqual(['b1', 'b2']);
  });
});

describe('a short all-in does not reset the minimum raise size', () => {
  // Regression: analyzeTurns overwrote the running raise size with any positive
  // delta, so an incomplete all-in shrank the minimum re-raise for later
  // actors. It now advances only on a full raise.
  function turn(
    actor: PlayerId,
    action: TurnEvent['action'],
    contribution: number,
  ): TurnEvent {
    return {
      id: `${actor}-${action.type}`,
      actor,
      action,
      legalOptions: [],
      stackBefore: 1_000,
      stackAfter: 1_000 - contribution,
      contribution,
      timestamp: 1_000,
    };
  }

  test('running raise size stays at the last full raise after a short all-in', () => {
    // a bets 20, b raises to 40 (a full +20 raise), c all-ins to 50 (only +10,
    // an incomplete raise). The last full raise size is 20, so the next legal
    // raise-to is 50 + 20 = 70, not 50 + 10 = 60.
    const round: BettingRound = {
      stage: 'flop',
      turnOrder: [0, 1, 2],
      turns: [
        turn('a', { type: 'bet', amount: 20 }, 20),
        turn('b', { type: 'raise', amount: 40, to: 40 }, 40),
        turn('c', { type: 'all-in', amount: 50, from: 'raise' }, 50),
      ],
      roundPot: 110,
      highestBet: 50,
    };

    const computation = deriveRoundComputation(round);
    expect(computation.highestContribution).toBe(50);
    expect(computation.lastAggressiveRaise).toBe(20);

    const legal = determineLegalOptions({
      config: { bettingStructure: 'no-limit', bigBlind: 10, smallBlind: 5 },
      context: {
        callAmount: 50,
        highestContribution: 50,
        lastRaiseSize: computation.lastAggressiveRaise,
        playerContribution: 0,
        remainingStack: 1_000,
        totalPot: 110,
        raisesThisRound: computation.raisesThisRound,
      },
    });

    expect(legal.minRaiseTo).toBe(70);
  });
});
