import { describe, expect, test } from 'vitest';

import { deriveRoundComputation, determineLegalOptions } from '..';
import type {
  BettingRound,
  PlayerId,
  TableSnapshot,
  TurnEvent,
} from '..';
import { validateIntent } from '../core/intent/validate-intent';
import { createTableSnapshot, createTurnIntent } from '../testing/builders';

// Blinds 5/10 no-limit throughout. A "full raise" preflop is +10 over the big
// blind; after a raise it is the size of that raise.
const NL_CONFIG = {
  bettingStructure: 'no-limit',
  bigBlind: 10,
  smallBlind: 5,
} as const;

function turn(
  actor: PlayerId,
  action: TurnEvent['action'],
  contribution: number,
  stackBefore = 1_000,
): TurnEvent {
  return {
    id: `${actor}-${action.type}-${contribution}`,
    actor,
    action,
    legalOptions: [],
    stackBefore,
    stackAfter: stackBefore - contribution,
    contribution,
    timestamp: 1_000,
  };
}

const blinds = [
  turn('sb', { type: 'post-blind', blind: 'small', amount: 5 }, 5),
  turn('bb', { type: 'post-blind', blind: 'big', amount: 10 }, 10),
];

function preflopRound(turns: TurnEvent[]): BettingRound {
  const all = [...blinds, ...turns];
  return {
    stage: 'preflop',
    turnOrder: [0, 1, 2, 3, 4],
    turns: all,
    roundPot: all.reduce((sum, entry) => sum + entry.contribution, 0),
    highestBet: 0,
  };
}

function flopRound(turns: TurnEvent[]): BettingRound {
  return {
    stage: 'flop',
    turnOrder: [0, 1, 2],
    turns,
    roundPot: turns.reduce((sum, entry) => sum + entry.contribution, 0),
    highestBet: 0,
  };
}

function optionsFor(round: BettingRound, actor: PlayerId, remainingStack: number) {
  const computation = deriveRoundComputation(round);
  const playerContribution = computation.contributions.get(actor) ?? 0;
  return determineLegalOptions({
    config: NL_CONFIG,
    context: {
      callAmount: Math.max(
        0,
        computation.highestContribution - playerContribution,
      ),
      highestContribution: computation.highestContribution,
      lastRaiseSize: computation.lastAggressiveRaise,
      playerContribution,
      remainingStack,
      totalPot: round.roundPot,
      raisesThisRound: computation.raisesThisRound,
      lastActedHighestContribution:
        computation.lastActedHighestContribution.get(actor),
    },
  });
}

function types(result: ReturnType<typeof determineLegalOptions>): string[] {
  return result.options.map((option) => option.type);
}

function raiseWindow(result: ReturnType<typeof determineLegalOptions>) {
  return result.options.find(
    (option) => option.type === 'raise' || option.type === 'bet',
  ) as { type: string; min: number; max: number } | undefined;
}

describe('a short all-in does not reopen the betting', () => {
  // Regression for the other half of the short all-in rule: the minimum
  // raise size already refused to shrink, but players who had acted and
  // matched the last full raise were still offered raise and all-in when
  // facing only an incomplete all-in. They must be limited to call or fold.

  test('players who already acted may only call or fold', () => {
    // a raises to 30 (full +20), b calls, c all-ins to 45 (+15, short).
    const round = preflopRound([
      turn('a', { type: 'raise', amount: 30, to: 30 }, 30),
      turn('b', { type: 'call', amount: 30 }, 30),
      turn('c', { type: 'all-in', amount: 45, from: 'raise' }, 45),
    ]);

    const a = optionsFor(round, 'a', 970);
    expect(types(a)).toEqual(['fold', 'call']);
    expect(a.options.find((option) => option.type === 'call')).toEqual({
      type: 'call',
      amount: 15,
    });

    const b = optionsFor(round, 'b', 970);
    expect(types(b)).toEqual(['fold', 'call']);
  });

  test('the big blind has not acted, so a short all-in leaves its raise intact', () => {
    // Posting a blind is a forced wager, not an action. Facing the same
    // short all-in, the big blind may still re-raise: minimum 45 + 20 = 65.
    const round = preflopRound([
      turn('a', { type: 'raise', amount: 30, to: 30 }, 30),
      turn('b', { type: 'call', amount: 30 }, 30),
      turn('c', { type: 'all-in', amount: 45, from: 'raise' }, 45),
    ]);

    const bb = optionsFor(round, 'bb', 990);
    expect(types(bb)).toEqual(['fold', 'call', 'raise', 'all-in']);
    expect(raiseWindow(bb)?.min).toBe(65);
  });

  test('a full all-in raise reopens the betting for everyone', () => {
    // c's all-in to 55 is +25 on top of 30, at least the +20 full raise, so
    // a may re-raise again: minimum 55 + 25 = 80.
    const round = preflopRound([
      turn('a', { type: 'raise', amount: 30, to: 30 }, 30),
      turn('b', { type: 'call', amount: 30 }, 30),
      turn('c', { type: 'all-in', amount: 55, from: 'raise' }, 55),
    ]);

    const a = optionsFor(round, 'a', 970);
    expect(types(a)).toEqual(['fold', 'call', 'raise', 'all-in']);
    expect(raiseWindow(a)?.min).toBe(80);
  });

  test('multiple short all-ins reopen the betting once they add up to a full raise', () => {
    // b's +10 and c's +15 are each short, but together they put a facing
    // +25 since it last acted, at least one full raise, so betting reopens
    // for a. The minimum raise stays anchored to the last full raise size:
    // 55 + 20 = 75.
    const round = preflopRound([
      turn('a', { type: 'raise', amount: 30, to: 30 }, 30),
      turn('b', { type: 'all-in', amount: 40, from: 'raise' }, 40),
      turn('c', { type: 'all-in', amount: 55, from: 'raise' }, 55),
    ]);

    const computation = deriveRoundComputation(round);
    expect(computation.lastAggressiveRaise).toBe(20);

    const a = optionsFor(round, 'a', 970);
    expect(types(a)).toEqual(['fold', 'call', 'raise', 'all-in']);
    expect(raiseWindow(a)?.min).toBe(75);
  });

  test('preflop limpers face a short all-in as call or fold, the blind keeps its option', () => {
    // a limps, d all-ins to 13 (+3 over the blind, short of the +10 full
    // raise). The limper may only call 3 or fold; the big blind never acted
    // and may still raise, minimum 13 + 10 = 23.
    const round = preflopRound([
      turn('a', { type: 'call', amount: 10 }, 10),
      turn('d', { type: 'all-in', amount: 13, from: 'raise' }, 13),
    ]);

    const a = optionsFor(round, 'a', 990);
    expect(types(a)).toEqual(['fold', 'call']);
    expect(a.options.find((option) => option.type === 'call')).toEqual({
      type: 'call',
      amount: 3,
    });

    const bb = optionsFor(round, 'bb', 990);
    expect(types(bb)).toEqual(['fold', 'call', 'raise', 'all-in']);
    expect(raiseWindow(bb)?.min).toBe(23);
  });

  test('an opening short all-in bet locks a checker to call or fold', () => {
    // On the flop a checks, then b open-shoves 7, short of the minimum bet
    // of 10. a already acted at level 0 and may only call 7 or fold; c has
    // not acted and may still raise, minimum 7 + 10 = 17.
    const round = flopRound([
      turn('a', { type: 'check' }, 0),
      turn('b', { type: 'all-in', amount: 7, from: 'bet' }, 7),
    ]);

    const a = optionsFor(round, 'a', 1_000);
    expect(types(a)).toEqual(['fold', 'call']);

    const c = optionsFor(round, 'c', 1_000);
    expect(types(c)).toEqual(['fold', 'call', 'raise', 'all-in']);
    expect(raiseWindow(c)?.min).toBe(17);
  });

  test('all-in stays available as an under-call even when betting is closed', () => {
    // Same short all-in as the first case, but a has only 10 behind: it
    // cannot cover the 15 call, so going all-in for less stays legal.
    const round = preflopRound([
      turn('a', { type: 'raise', amount: 30, to: 30 }, 30),
      turn('b', { type: 'call', amount: 30 }, 30),
      turn('c', { type: 'all-in', amount: 45, from: 'raise' }, 45),
    ]);

    const a = optionsFor(round, 'a', 10);
    expect(types(a)).toEqual(['fold', 'all-in']);
    expect(a.options.find((option) => option.type === 'all-in')).toEqual({
      type: 'all-in',
      amount: 40,
    });
  });

  test('validateIntent enforces the same closure', () => {
    const round = preflopRound([
      turn('a', { type: 'raise', amount: 30, to: 30 }, 30),
      turn('b', { type: 'call', amount: 30 }, 30),
      turn('c', { type: 'all-in', amount: 45, from: 'raise' }, 45),
    ]);

    const base = createTableSnapshot({
      players: [
        { id: 'sb', stack: 995 },
        { id: 'bb', stack: 990 },
        { id: 'a', stack: 970 },
        { id: 'b', stack: 970 },
        { id: 'c', stack: 0 },
      ],
    });
    const snapshot: TableSnapshot = {
      ...base,
      hand: {
        ...base.hand,
        blinds: {
          smallBlind: { playerId: 'sb', amount: 5 },
          bigBlind: { playerId: 'bb', amount: 10 },
        },
        bettingRounds: [round],
      },
      clock: { ...base.clock, currentActor: 'a' },
    };

    const raise = validateIntent(
      snapshot,
      createTurnIntent({
        actor: 'a',
        requested: { type: 'raise', amount: 35, to: 65 },
      }),
    );
    expect(raise.kind).toBe('rejected');

    const shove = validateIntent(
      snapshot,
      createTurnIntent({
        actor: 'a',
        requested: { type: 'all-in', amount: 970, from: 'raise' },
      }),
    );
    expect(shove.kind).toBe('rejected');

    const call = validateIntent(
      snapshot,
      createTurnIntent({
        actor: 'a',
        requested: { type: 'call', amount: 15 },
      }),
    );
    expect(call.kind).toBe('accepted');
    if (call.kind === 'accepted') {
      expect(call.event.action).toEqual({
        type: 'call',
        amount: 15,
        isAllIn: false,
      });
    }
  });
});
