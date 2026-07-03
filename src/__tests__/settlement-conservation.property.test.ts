import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { advanceRandomState, generateRandomState } from '..';
import type { SeatBootstrapConfig } from '../session/lifecycle';
import { createSeededRandom } from '../testing';
import type { SessionConfig } from '../types/session';
import type { TableSnapshot } from '../types/snapshot';

// Total chips in play = every stack plus every pot bucket (main, sides, rake).
// This must never change from the moment the hand is dealt through showdown and
// settlement, no matter how the money moves. This is the same invariant batch-s1
// checks per hand, exercised here through the full auto settlement path
// (including multi-way unequal all-ins that build side pots and
// uncontested/uncalled remainders).
function chipsInPlay(snapshot: TableSnapshot): number {
  const stacks = snapshot.seating.seats.reduce(
    (sum, seat) => sum + seat.stack,
    0,
  );
  const sides = snapshot.pots.sides.reduce((sum, side) => sum + side.amount, 0);
  return stacks + snapshot.pots.main.amount + snapshot.pots.rake + sides;
}

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
        burnPerStreet: [1, 1, 1],
        communityReveal: [0, 3, 1, 1],
      },
      showdownOrdering: 'high-card',
    },
    evaluationPolicy: {
      engine: 'lookup-table',
      evaluatorId: 'default',
      supportsHiLo: false,
      cacheSize: 1024,
    },
    simulationPolicy: undefined,
    autoAdvance: true,
  } satisfies SessionConfig;
}

describe('settlement chip conservation', () => {
  test('total chips are conserved through settlement for unequal-stack hands', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.array(fc.constantFrom(40, 60, 80, 100, 120), {
          minLength: 6,
          maxLength: 6,
        }),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (players, stacks, seed) => {
          const seats: SeatBootstrapConfig[] = Array.from(
            { length: players },
            (_, index) => ({
              playerId: `p${index + 1}`,
              seatIndex: index,
              stack: stacks[index]!,
            }),
          );
          const total = seats.reduce((sum, seat) => sum + (seat.stack ?? 0), 0);
          const rng = createSeededRandom(seed);

          let summary = await generateRandomState({
            config: createConfig(),
            seats,
            random: rng,
            steps: { min: 0, max: 0 },
          });
          expect(chipsInPlay(summary.session.activeSnapshot)).toBe(total);

          for (let step = 0; step < 400; step += 1) {
            const before = summary.session.activeSnapshot.index;
            summary = await advanceRandomState(summary.session, {
              random: rng,
              steps: { min: 1, max: 1 },
            });
            expect(chipsInPlay(summary.session.activeSnapshot)).toBe(total);
            if (
              summary.session.activeSnapshot.index === before ||
              summary.session.activeSnapshot.hand.stage === 'settled'
            ) {
              break;
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  }, 30_000);
});
