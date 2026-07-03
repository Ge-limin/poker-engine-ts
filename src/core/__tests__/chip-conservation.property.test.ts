import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  deriveRoundComputation,
  determineLegalOptions,
  findSeatByPlayerId,
  reduce,
  sumPotAmounts,
  validateIntent,
} from '../../index';
import { createTableSnapshot } from '../../testing/index';
import type {
  PlayerOption,
  TableSnapshot,
  TurnIntent,
} from '../../types/index';

interface ActionChoice {
  readonly optionOffset: number;
  readonly sizingOffset: number;
}

describe('property-based invariants', () => {
  test('chip totals remain constant across validated reductions', () => {
    const choiceListArbitrary = fc.array(
      fc.record<ActionChoice>({
        optionOffset: fc.integer({ min: 0, max: 16 }),
        sizingOffset: fc.integer({ min: 0, max: 16 }),
      }),
      { maxLength: 24 },
    );

    fc.assert(
      fc.property(choiceListArbitrary, (choices: ActionChoice[]) => {
        let snapshot = createTableSnapshot({
          players: [
            { id: 'player-a', stack: 200 },
            { id: 'player-b', stack: 200 },
            { id: 'player-c', stack: 200 },
          ],
          buttonIndex: 2,
        });

        const initialChipTotal = totalChips(snapshot);

        for (let step = 0; step < choices.length; step += 1) {
          const choice = choices[step]!;
          const intent = createIntentForChoice(snapshot, choice, step);
          if (!intent) {
            break;
          }

          const validation = validateIntent(snapshot, intent);
          expect(validation.kind).toBe('accepted');
          if (validation.kind !== 'accepted') {
            return;
          }

          const nextSnapshot = reduce(snapshot, validation.event);
          expect(totalChips(nextSnapshot)).toBe(initialChipTotal);
          snapshot = nextSnapshot;
        }
      }),
      { verbose: false },
    );
  });
});

function createIntentForChoice(
  snapshot: TableSnapshot,
  choice: ActionChoice,
  step: number,
): TurnIntent | undefined {
  const actor = snapshot.clock.currentActor;
  if (!actor) {
    return undefined;
  }

  const seatLookup = findSeatByPlayerId(snapshot.seating, actor);
  if (!seatLookup) {
    return undefined;
  }

  const round = snapshot.hand.bettingRounds.at(-1);
  if (!round) {
    return undefined;
  }

  const computation = deriveRoundComputation(round);
  const playerContribution = computation.contributions.get(actor) ?? 0;
  const highestContribution = computation.highestContribution;
  const callAmount = Math.max(0, highestContribution - playerContribution);
  const stackBefore = seatLookup.seat.stack;
  const totalPot = sumPotAmounts(snapshot.pots);

  const options = determineLegalOptions({
    config: {
      bettingStructure: 'no-limit',
      bigBlind: snapshot.hand.blinds.bigBlind.amount ?? 0,
      smallBlind: snapshot.hand.blinds.smallBlind.amount ?? 0,
      minRaiseIncrement: snapshot.hand.blinds.bigBlind.amount ?? 0,
    },
    context: {
      callAmount,
      highestContribution,
      lastRaiseSize: computation.lastAggressiveRaise,
      playerContribution,
      remainingStack: stackBefore,
      totalPot,
    },
  }).options.filter((option) => option.disabled !== true);

  if (options.length === 0) {
    return undefined;
  }

  const option = options[choice.optionOffset % options.length]!;

  return buildIntentFromOption({
    snapshot,
    actor,
    option,
    choice,
    step,
    stackBefore,
    playerContribution,
    callAmount,
  });
}

interface IntentBuilderParams {
  readonly snapshot: TableSnapshot;
  readonly actor: string;
  readonly option: PlayerOption;
  readonly choice: ActionChoice;
  readonly step: number;
  readonly stackBefore: number;
  readonly playerContribution: number;
  readonly callAmount: number;
}

function buildIntentFromOption(
  params: IntentBuilderParams,
): TurnIntent | undefined {
  const {
    snapshot,
    actor,
    option,
    choice,
    step,
    stackBefore,
    playerContribution,
    callAmount,
  } = params;

  const base: Pick<
    TurnIntent,
    'id' | 'actor' | 'issuedAt' | 'origin' | 'expectedSnapshotVersion'
  > = {
    id: `intent-${step}`,
    actor,
    issuedAt: step + 1,
    origin: 'ui',
    expectedSnapshotVersion: snapshot.index,
  };

  switch (option.type) {
    case 'fold':
      return { ...base, requested: { type: 'fold' } };
    case 'check':
      return { ...base, requested: { type: 'check' } };
    case 'call':
      return {
        ...base,
        requested: {
          type: 'call',
          amount: option.amount,
        },
      };
    case 'all-in': {
      if (stackBefore <= 0) {
        return undefined;
      }
      const coversCall = callAmount >= stackBefore;
      const from: 'bet' | 'call' | 'raise' =
        callAmount === 0 ? 'bet' : coversCall ? 'call' : 'raise';
      return {
        ...base,
        requested: {
          type: 'all-in',
          amount: stackBefore,
          from,
        },
      };
    }
    case 'bet': {
      if (stackBefore <= 0) {
        return undefined;
      }
      const amount = resolveSizedAmount(option, choice.sizingOffset);
      return {
        ...base,
        requested: {
          type: 'bet',
          amount: Math.min(amount, stackBefore),
        },
      };
    }
    case 'raise': {
      if (stackBefore <= 0) {
        return undefined;
      }
      const target = resolveSizedAmount(option, choice.sizingOffset);
      if (target <= playerContribution) {
        return undefined;
      }
      return {
        ...base,
        requested: {
          type: 'raise',
          to: target,
          amount: target,
        },
      };
    }
    default:
      return undefined;
  }
}

function resolveSizedAmount(
  option: Extract<PlayerOption, { type: 'bet' | 'raise' }>,
  sizingOffset: number,
): number {
  const increment = Math.max(1, option.increment);
  if (option.max <= option.min) {
    return option.min;
  }
  const span = option.max - option.min;
  const steps = Math.floor(span / increment);
  const step = steps > 0 ? sizingOffset % (steps + 1) : 0;
  const candidate = option.min + step * increment;
  return Math.max(option.min, Math.min(option.max, candidate));
}

function totalChips(snapshot: TableSnapshot): number {
  const stackTotal = snapshot.seating.seats.reduce((running, seat) => {
    if (!seat.occupant) {
      return running;
    }
    return running + seat.stack;
  }, 0);

  return stackTotal + sumPotAmounts(snapshot.pots);
}
