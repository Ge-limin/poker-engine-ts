import { describe, expect, it } from 'vitest';

import type { DistributionRule } from '../../types/config';
import type { SessionConfig } from '../../types/session';
import { resolveDistributionCounts } from '../lifecycle';

type DistributionOverrides = Partial<DistributionRule>;

function createConfig(overrides: DistributionOverrides = {}): SessionConfig {
  const distribution: DistributionRule = {
    holeCardsPerPlayer: overrides.holeCardsPerPlayer ?? 2,
    burnPerStreet: overrides.burnPerStreet ?? [],
    communityReveal: overrides.communityReveal ?? [],
  };

  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats: 6,
    startingStack: 100,
    blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
    antePolicy: { type: 'none' },
    personaPolicy: { defaultStyle: 'balanced' },
    ruleSet: {
      streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
      postingOrder: ['small-blind', 'big-blind', 'ante'],
      minRaisePolicy: 'double-last-bet',
      maxRaisePolicy: 'all-in',
      cardDistribution: distribution,
      showdownOrdering: 'high-card',
    },
    evaluationPolicy: {
      engine: 'lookup-table',
      evaluatorId: 'default',
      supportsHiLo: false,
      cacheSize: 1024,
    },
    autoAdvance: true,
  };
}

describe('resolveDistributionCounts', () => {
  it("returns Hold'em burn and reveal counts when all streets are defined", () => {
    const config = createConfig({
      burnPerStreet: [1, 1, 1],
      communityReveal: [3, 1, 1],
    });

    expect(resolveDistributionCounts(config, 'flop')).toEqual({
      burn: 1,
      reveal: 3,
    });
    expect(resolveDistributionCounts(config, 'turn')).toEqual({
      burn: 1,
      reveal: 1,
    });
    expect(resolveDistributionCounts(config, 'river')).toEqual({
      burn: 1,
      reveal: 1,
    });
  });

  it('prioritizes street ordering and then reveal stages when arrays are shorter', () => {
    const config = createConfig({
      burnPerStreet: [1, 0],
      communityReveal: [3],
    });

    expect(resolveDistributionCounts(config, 'flop')).toEqual({
      burn: 0,
      reveal: 3,
    });
    expect(resolveDistributionCounts(config, 'turn')).toEqual({
      burn: 0,
      reveal: 1,
    });
    expect(resolveDistributionCounts(config, 'river')).toEqual({
      burn: 0,
      reveal: 1,
    });
  });

  it('defaults to standard counts when no distribution entries are provided', () => {
    const config = createConfig({ burnPerStreet: [], communityReveal: [] });

    expect(resolveDistributionCounts(config, 'flop')).toEqual({
      burn: 0,
      reveal: 3,
    });
    expect(resolveDistributionCounts(config, 'turn')).toEqual({
      burn: 0,
      reveal: 1,
    });
    expect(resolveDistributionCounts(config, 'river')).toEqual({
      burn: 0,
      reveal: 1,
    });
  });
});
