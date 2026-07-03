import { describe, expect, test } from 'vitest';

import { reduce, settlePots, validateIntent } from '..';
import { createTableSnapshot, createTurnIntent } from '../testing';
import type {
  PlayerAction,
  PlayerOption,
  TurnEvent,
  TurnMetadata,
} from '../types/events';
import type {
  PayoutEntry,
  PotLedger,
  ShowdownSummary,
  TableSnapshot,
} from '../types/snapshot';

function assertDefined<T>(
  value: T | undefined,
  message: string,
): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

function applyTurn(
  snapshot: TableSnapshot,
  params: {
    readonly actor: string;
    readonly action: PlayerAction;
    readonly contribution: number;
    readonly metadata?: Partial<TurnMetadata>;
  },
): TableSnapshot {
  const seat = snapshot.seating.seats.find(
    (entry) => entry.occupant?.playerId === params.actor,
  );
  const stackBefore = seat?.stack ?? 0;

  const event: TurnEvent = {
    id: `event-${Date.now()}-${Math.random()}`,
    actor: params.actor,
    action: params.action,
    legalOptions: [],
    stackBefore,
    stackAfter: stackBefore - params.contribution,
    contribution: params.contribution,
    timestamp: Date.now(),
    metadata: {
      engineVersion: 'test',
      availableActionsAtDecision: [],
      ...params.metadata,
    },
  };

  return reduce(snapshot, event);
}

function getLegalOptions(
  snapshot: TableSnapshot,
  actor: string,
): readonly PlayerOption[] {
  const intent = createTurnIntent({
    actor,
    requested: { type: 'fold' },
    expectedSnapshotVersion: snapshot.index,
  });
  const validation = validateIntent(snapshot, intent);
  if (validation.kind !== 'accepted') {
    throw new Error('expected fold intent to be accepted for legal options');
  }

  return validation.event.legalOptions;
}

describe('pot ledger side pot handling', () => {
  test('creates multiple side pots for staggered all-ins', () => {
    let snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 200 },
        { id: 'player-b', stack: 200 },
        { id: 'player-c', stack: 60 },
        { id: 'player-d', stack: 40 },
      ],
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-a',
      action: { type: 'bet', amount: 100 },
      contribution: 100,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-b',
      action: { type: 'call', amount: 100 },
      contribution: 100,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-c',
      action: { type: 'all-in', amount: 60, from: 'call' },
      contribution: 60,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-d',
      action: { type: 'all-in', amount: 40, from: 'call' },
      contribution: 40,
    });

    expect(snapshot.pots.main.amount).toBe(160);
    const eligible = snapshot.pots.main.eligiblePlayers;
    expect(eligible.length).toBe(4);
    expect(eligible[0]).toBe('player-a');
    expect(eligible[1]).toBe('player-b');
    expect(eligible[2]).toBe('player-c');
    expect(eligible[3]).toBe('player-d');
    expect(snapshot.pots.main.contributions['player-a']).toBe(40);
    expect(snapshot.pots.main.contributions['player-d']).toBe(40);

    const firstSide = snapshot.pots.sides[0];
    const secondSide = snapshot.pots.sides[1];
    assertDefined(firstSide, 'expected first side pot');
    assertDefined(secondSide, 'expected second side pot');
    expect(firstSide.amount).toBe(60);
    const firstEligible = firstSide.eligiblePlayers;
    expect(firstEligible.length).toBe(3);
    expect(firstEligible[0]).toBe('player-a');
    expect(firstEligible[1]).toBe('player-b');
    expect(firstEligible[2]).toBe('player-c');
    expect(secondSide.amount).toBe(80);
    const secondEligible = secondSide.eligiblePlayers;
    expect(secondEligible.length).toBe(2);
    expect(secondEligible[0]).toBe('player-a');
    expect(secondEligible[1]).toBe('player-b');
  });

  test('removes folded players from later pot eligibility', () => {
    let snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 200 },
        { id: 'player-b', stack: 200 },
        { id: 'player-c', stack: 30 },
      ],
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-a',
      action: { type: 'bet', amount: 50 },
      contribution: 50,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-b',
      action: { type: 'call', amount: 50 },
      contribution: 50,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-c',
      action: { type: 'all-in', amount: 30, from: 'call' },
      contribution: 30,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-b',
      action: { type: 'fold' },
      contribution: 0,
    });

    expect(snapshot.pots.main.amount).toBe(90);
    expect(snapshot.pots.main.eligiblePlayers).toEqual([
      'player-a',
      'player-c',
    ]);

    const side = snapshot.pots.sides[0];
    assertDefined(side, 'expected side pot');
    expect(side.amount).toBe(40);
    expect(side.eligiblePlayers).toEqual(['player-a']);
    expect(side.contributions['player-a']).toBe(20);
    expect(side.contributions['player-b']).toBe(20);
    expect(side.contributions['player-c']).toBe(0);
  });
});

describe('showdown settlement', () => {
  test('splits pots evenly on tied evaluations', () => {
    const base = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 0 },
        { id: 'player-b', stack: 0 },
      ],
    });

    const snapshot: TableSnapshot = {
      ...base,
      pots: createLedger(base, {
        main: {
          id: 'main',
          amount: 120,
          eligiblePlayers: ['player-a', 'player-b'],
          contributions: { 'player-a': 60, 'player-b': 60 },
        },
        sides: [],
        rake: 0,
      }),
    };

    const summary: ShowdownSummary = {
      evaluatedHands: [
        {
          playerId: 'player-a',
          rankClass: 'straight',
          rankValue: 8,
          bestFive: ['9h', '8d', '7c', '6s', '5h'] as const,
          kickers: ['Ah'] as const,
        },
        {
          playerId: 'player-b',
          rankClass: 'straight',
          rankValue: 8,
          bestFive: ['9h', '8d', '7c', '6s', '5h'] as const,
          kickers: ['Ah'] as const,
        },
      ],
      board: ['9h', '8d', '7c', '6s', '5h'] as const,
      evaluatorId: 'test/evaluator',
    };

    const payouts = settlePots(snapshot, summary);
    expect(payouts.entries.length).toBe(2);
    const first = payouts.entries[0];
    const second = payouts.entries[1];
    assertDefined(first, 'expected first payout');
    assertDefined(second, 'expected second payout');
    expect(first.playerId).toBe('player-a');
    expect(first.amount).toBe(60);
    expect(first.potIds.length).toBe(1);
    expect(first.potIds[0]).toBe('main');
    expect(second.playerId).toBe('player-b');
    expect(second.amount).toBe(60);
    expect(second.potIds.length).toBe(1);
    expect(second.potIds[0]).toBe('main');
  });

  test('assigns odd chips to the first winner left of the button', () => {
    const base = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 0 },
        { id: 'player-b', stack: 0 },
        { id: 'player-c', stack: 0 },
      ],
    });

    const snapshot: TableSnapshot = {
      ...base,
      pots: createLedger(base, {
        main: {
          id: 'main',
          amount: 5,
          eligiblePlayers: ['player-b', 'player-c'],
          contributions: { 'player-a': 0, 'player-b': 3, 'player-c': 2 },
        },
        sides: [],
        rake: 0,
      }),
    };

    const summary: ShowdownSummary = {
      evaluatedHands: [
        {
          playerId: 'player-b',
          rankClass: 'pair',
          rankValue: 2,
          bestFive: ['2h', '2d', '9c', '8s', '7h'] as const,
          kickers: ['Ah'] as const,
        },
        {
          playerId: 'player-c',
          rankClass: 'pair',
          rankValue: 2,
          bestFive: ['2h', '2d', '9c', '8s', '7h'] as const,
          kickers: ['Ah'] as const,
        },
      ],
      board: ['2h', '2d', '9c', '8s', '7h'] as const,
      evaluatorId: 'test/evaluator',
    };

    const payouts = settlePots(snapshot, summary);
    expect(payouts.entries.length).toBe(2);
    const first = payouts.entries[0];
    const second = payouts.entries[1];
    assertDefined(first, 'expected first payout');
    assertDefined(second, 'expected second payout');
    expect(first.playerId).toBe('player-b');
    expect(first.amount).toBe(3);
    expect(first.potIds[0]).toBe('main');
    expect(second.playerId).toBe('player-c');
    expect(second.amount).toBe(2);
    expect(second.potIds[0]).toBe('main');
  });

  test('throws when a pot contains fractional chip amounts', () => {
    const base = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 0 },
        { id: 'player-b', stack: 0 },
        { id: 'player-c', stack: 0 },
      ],
    });

    const snapshot: TableSnapshot = {
      ...base,
      pots: createLedger(base, {
        main: {
          id: 'main',
          amount: 1.05,
          eligiblePlayers: ['player-b', 'player-c'],
          contributions: {
            'player-a': 0,
            'player-b': 0.55,
            'player-c': 0.5,
          },
        },
        sides: [],
        rake: 0,
      }),
    };

    const summary: ShowdownSummary = {
      evaluatedHands: [
        {
          playerId: 'player-b',
          rankClass: 'pair',
          rankValue: 2,
          bestFive: ['2h', '2d', '9c', '8s', '7h'] as const,
          kickers: ['Ah'] as const,
        },
        {
          playerId: 'player-c',
          rankClass: 'pair',
          rankValue: 2,
          bestFive: ['2h', '2d', '9c', '8s', '7h'] as const,
          kickers: ['Ah'] as const,
        },
      ],
      board: ['2h', '2d', '9c', '8s', '7h'] as const,
      evaluatorId: 'test/evaluator',
    };

    expect(() => settlePots(snapshot, summary)).toThrow(
      'Chips must be integers (pot main amount); received 1.05',
    );
  });

  test('uses kickers to resolve tied rank classes', () => {
    const base = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 0 },
        { id: 'player-b', stack: 0 },
      ],
    });

    const snapshot: TableSnapshot = {
      ...base,
      pots: createLedger(base, {
        main: {
          id: 'main',
          amount: 100,
          eligiblePlayers: ['player-a', 'player-b'],
          contributions: { 'player-a': 50, 'player-b': 50 },
        },
        sides: [],
        rake: 0,
      }),
    };

    const summary: ShowdownSummary = {
      evaluatedHands: [
        {
          playerId: 'player-a',
          rankClass: 'two-pair',
          rankValue: 7,
          bestFive: ['Ah', 'Ad', 'Ks', 'Kc', '2d'] as const,
          kickers: ['Qh'] as const,
        },
        {
          playerId: 'player-b',
          rankClass: 'two-pair',
          rankValue: 7,
          bestFive: ['Ah', 'Ad', 'Ks', 'Kc', '2d'] as const,
          kickers: ['Jh'] as const,
        },
      ],
      board: ['Ah', 'Ad', 'Ks', 'Kc', '2d'] as const,
      evaluatorId: 'test/evaluator',
    };

    const payouts = settlePots(snapshot, summary);
    expect(payouts.entries.length).toBe(1);
    const winner = payouts.entries[0];
    assertDefined(winner, 'expected payout entry');
    expect(winner.playerId).toBe('player-a');
    expect(winner.amount).toBe(100);
    expect(winner.potIds[0]).toBe('main');
  });

  test('splits evenly when every player plays the board', () => {
    const base = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 0 },
        { id: 'player-b', stack: 0 },
        { id: 'player-c', stack: 0 },
      ],
    });

    const snapshot: TableSnapshot = {
      ...base,
      pots: createLedger(base, {
        main: {
          id: 'main',
          amount: 90,
          eligiblePlayers: ['player-a', 'player-b', 'player-c'],
          contributions: {
            'player-a': 30,
            'player-b': 30,
            'player-c': 30,
          },
        },
        sides: [],
        rake: 0,
      }),
    };

    const summary: ShowdownSummary = {
      evaluatedHands: [
        {
          playerId: 'player-a',
          rankClass: 'flush',
          rankValue: 6,
          bestFive: ['Ah', 'Kh', 'Qh', 'Jh', 'Th'] as const,
          kickers: [] as const,
        },
        {
          playerId: 'player-b',
          rankClass: 'flush',
          rankValue: 6,
          bestFive: ['Ah', 'Kh', 'Qh', 'Jh', 'Th'] as const,
          kickers: [] as const,
        },
        {
          playerId: 'player-c',
          rankClass: 'flush',
          rankValue: 6,
          bestFive: ['Ah', 'Kh', 'Qh', 'Jh', 'Th'] as const,
          kickers: [] as const,
        },
      ],
      board: ['Ah', 'Kh', 'Qh', 'Jh', 'Th'] as const,
      evaluatorId: 'test/evaluator',
    };

    const payouts = settlePots(snapshot, summary);
    expect(payouts.entries.length).toBe(3);
    const [first, second, third] = payouts.entries;
    assertDefined(first, 'expected first payout');
    assertDefined(second, 'expected second payout');
    assertDefined(third, 'expected third payout');
    expect(first.playerId).toBe('player-a');
    expect(first.amount).toBe(30);
    expect(first.potIds[0]).toBe('main');
    expect(second.playerId).toBe('player-b');
    expect(second.amount).toBe(30);
    expect(second.potIds[0]).toBe('main');
    expect(third.playerId).toBe('player-c');
    expect(third.amount).toBe(30);
    expect(third.potIds[0]).toBe('main');
  });

  test('prefers higher straights over wheel straights', () => {
    const base = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 0 },
        { id: 'player-b', stack: 0 },
      ],
    });

    const snapshot: TableSnapshot = {
      ...base,
      pots: createLedger(base, {
        main: {
          id: 'main',
          amount: 60,
          eligiblePlayers: ['player-a', 'player-b'],
          contributions: { 'player-a': 30, 'player-b': 30 },
        },
        sides: [],
        rake: 0,
      }),
    };

    const summary: ShowdownSummary = {
      evaluatedHands: [
        {
          playerId: 'player-a',
          rankClass: 'straight',
          rankValue: 5,
          bestFive: ['5h', '4d', '3c', '2s', 'Ah'] as const,
          kickers: [] as const,
        },
        {
          playerId: 'player-b',
          rankClass: 'straight',
          rankValue: 6,
          bestFive: ['6h', '5d', '4c', '3s', '2h'] as const,
          kickers: [] as const,
        },
      ],
      board: ['6h', '5d', '4c', '3s', '2h'] as const,
      evaluatorId: 'test/evaluator',
    };

    const payouts = settlePots(snapshot, summary);
    expect(payouts.entries.length).toBe(1);
    const winner = payouts.entries[0];
    assertDefined(winner, 'expected winner payout');
    expect(winner.playerId).toBe('player-b');
    expect(winner.amount).toBe(60);
    expect(winner.potIds[0]).toBe('main');
  });

  test('awards side pots only to eligible winners', () => {
    const base = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 0 },
        { id: 'player-b', stack: 0 },
        { id: 'player-c', stack: 0 },
      ],
    });

    const snapshot: TableSnapshot = {
      ...base,
      pots: createLedger(base, {
        main: {
          id: 'main',
          amount: 90,
          eligiblePlayers: ['player-a', 'player-b', 'player-c'],
          contributions: {
            'player-a': 30,
            'player-b': 30,
            'player-c': 30,
          },
        },
        sides: [
          {
            id: 'side-1',
            amount: 40,
            eligiblePlayers: ['player-a', 'player-b'],
            contributions: {
              'player-a': 20,
              'player-b': 20,
              'player-c': 0,
            },
          },
        ],
        rake: 0,
      }),
    };

    const summary: ShowdownSummary = {
      evaluatedHands: [
        {
          playerId: 'player-a',
          rankClass: 'pair',
          rankValue: 2,
          bestFive: ['Ah', 'Ad', '9c', '8s', '4d'] as const,
          kickers: ['Kh', 'Qd'] as const,
        },
        {
          playerId: 'player-b',
          rankClass: 'high-card',
          rankValue: 1,
          bestFive: ['Ah', 'Kd', '9c', '8s', '4d'] as const,
          kickers: ['Jh', 'Td'] as const,
        },
        {
          playerId: 'player-c',
          rankClass: 'straight',
          rankValue: 5,
          bestFive: ['9h', '8d', '7c', '6s', '5h'] as const,
          kickers: [] as const,
        },
      ],
      board: ['9h', '8d', '7c', '6s', '5h'] as const,
      evaluatorId: 'test/evaluator',
    };

    const payouts = settlePots(snapshot, summary);
    const entries = [...payouts.entries].sort(
      (left: PayoutEntry, right: PayoutEntry) =>
        left.playerId.localeCompare(right.playerId),
    );

    expect(entries.length).toBe(2);
    const [first, second] = entries;
    assertDefined(first, 'expected first payout');
    assertDefined(second, 'expected second payout');

    expect(first.playerId).toBe('player-a');
    expect(first.amount).toBe(40);
    expect(first.potIds).toEqual(['side-1']);

    expect(second.playerId).toBe('player-c');
    expect(second.amount).toBe(90);
    expect(second.potIds).toEqual(['main']);
  });
});

describe('betting structure and action flow', () => {
  test('enforces minimum bet sizing based on blinds', () => {
    const snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 100 },
        { id: 'player-b', stack: 100 },
        { id: 'player-c', stack: 100 },
      ],
    });

    const options = getLegalOptions(snapshot, 'player-a');
    const betOption = findOption(options, 'bet');
    assertDefined(betOption, 'expected bet option');
    if (betOption.type !== 'bet') {
      throw new Error('bet option missing');
    }
    expect(betOption.min).toBe(2);
  });

  test('provides raise options after a full bet', () => {
    let snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 100 },
        { id: 'player-b', stack: 100 },
        { id: 'player-c', stack: 100 },
      ],
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-a',
      action: { type: 'bet', amount: 10 },
      contribution: 10,
    });

    const options = getLegalOptions(snapshot, 'player-b');
    const callOption = findOption(options, 'call');
    assertDefined(callOption, 'expected call option');
    if (callOption.type !== 'call') {
      throw new Error('call option missing');
    }
    expect(callOption.amount).toBe(10);
    const raiseOption = findOption(options, 'raise');
    assertDefined(raiseOption, 'expected raise option');
    if (raiseOption.type !== 'raise') {
      throw new Error('raise option missing');
    }
    expect(raiseOption.min).toBe(20);
  });

  test('returns action to the original bettor after raises and folds', () => {
    let snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 200 },
        { id: 'player-b', stack: 200 },
        { id: 'player-c', stack: 200 },
      ],
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-a',
      action: { type: 'bet', amount: 40 },
      contribution: 40,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-b',
      action: { type: 'raise', amount: 80 },
      contribution: 80,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-c',
      action: { type: 'fold' },
      contribution: 0,
    });

    expect(snapshot.clock.currentActor).toBe('player-a');
  });

  test('short all-ins after a raise do not reopen betting', () => {
    let snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 200 },
        { id: 'player-b', stack: 200 },
        { id: 'player-c', stack: 50 },
      ],
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-a',
      action: { type: 'bet', amount: 40 },
      contribution: 40,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-b',
      action: { type: 'raise', amount: 80 },
      contribution: 80,
    });

    expect(snapshot.hand.bettingRounds[0]?.lastAggressor).toBe('player-b');

    snapshot = applyTurn(snapshot, {
      actor: 'player-c',
      action: { type: 'all-in', amount: 30, from: 'call' },
      contribution: 30,
    });

    expect(snapshot.hand.bettingRounds[0]?.lastAggressor).toBe('player-b');
  });

  test('full raises after a short all-in reopen action', () => {
    let snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 300 },
        { id: 'player-b', stack: 300 },
        { id: 'player-c', stack: 60 },
        { id: 'player-d', stack: 300 },
      ],
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-a',
      action: { type: 'bet', amount: 40 },
      contribution: 40,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-b',
      action: { type: 'raise', amount: 80 },
      contribution: 80,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-c',
      action: { type: 'all-in', amount: 30, from: 'call' },
      contribution: 30,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-d',
      action: { type: 'raise', amount: 120 },
      contribution: 120,
    });

    expect(snapshot.hand.bettingRounds[0]?.lastAggressor).toBe('player-d');
  });

  test('short stacks receive all-in options when calls are impossible', () => {
    let snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 100 },
        { id: 'player-b', stack: 30 },
      ],
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-a',
      action: { type: 'bet', amount: 50 },
      contribution: 50,
    });

    const options = getLegalOptions(snapshot, 'player-b');
    const hasAllIn = options.some(
      (option) => option.type === 'all-in' && option.amount === 30,
    );
    expect(hasAllIn).toBe(true);
    const callOption = findOption(options, 'call');
    expect(callOption === undefined).toBe(true);
  });

  test('large all-ins from bets reopen betting', () => {
    let snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 150 },
        { id: 'player-b', stack: 300 },
        { id: 'player-c', stack: 300 },
      ],
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-a',
      action: { type: 'bet', amount: 40 },
      contribution: 40,
    });

    snapshot = applyTurn(snapshot, {
      actor: 'player-b',
      action: { type: 'all-in', amount: 200, from: 'bet' },
      contribution: 200,
    });

    expect(snapshot.hand.bettingRounds[0]?.lastAggressor).toBe('player-b');
  });

  test('heads-up blind rules place the button in the small blind seat', () => {
    const snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 100 },
        { id: 'player-b', stack: 100 },
      ],
    });

    expect(snapshot.seating.dealerButton).toBe(0);
    expect(snapshot.hand.blinds.smallBlind.playerId).toBe('player-a');
    expect(snapshot.hand.blinds.bigBlind.playerId).toBe('player-b');
    const turnOrder = snapshot.hand.bettingRounds[0]?.turnOrder;
    assertDefined(turnOrder, 'expected betting round turn order');
    expect(turnOrder[0]).toBe(0);
    expect(turnOrder[1]).toBe(1);
  });

  test('heads-up flop rotation acts from the big blind first', () => {
    let snapshot = createTableSnapshot();

    snapshot = applyTurn(snapshot, {
      actor: 'player-b',
      action: { type: 'check' },
      contribution: 0,
      metadata: {
        nextHandStage: 'flop',
      },
    });

    const flopRound = snapshot.hand.bettingRounds.find(
      (round) => round.stage === 'flop',
    );

    assertDefined(flopRound, 'expected flop betting round');
    expect(flopRound.turnOrder[0]).toBe(1);
    const firstSeat = snapshot.seating.seats[flopRound.turnOrder[0]!];
    expect(firstSeat?.occupant?.playerId).toBe('player-b');
  });
});

function createLedger(base: TableSnapshot, ledger: PotLedger): PotLedger {
  const players: Record<string, number> = {};
  for (const seat of base.seating.seats) {
    if (seat.occupant) {
      players[seat.occupant.playerId] = 0;
    }
  }

  const main = {
    ...ledger.main,
    contributions: { ...players, ...ledger.main.contributions },
  };

  const sides = ledger.sides.map((bucket) => ({
    ...bucket,
    contributions: { ...players, ...bucket.contributions },
  }));

  return {
    main,
    sides,
    rake: ledger.rake,
  };
}

function findOption(
  options: readonly PlayerOption[],
  type: PlayerOption['type'],
) {
  return options.find((option) => option.type === type);
}
