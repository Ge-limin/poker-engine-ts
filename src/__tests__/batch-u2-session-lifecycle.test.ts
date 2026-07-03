import { describe, expect, test } from 'vitest';

import { reduce } from '../core/reducer';
import { createDeterministicHandId } from '../session/hand-id';
import {
  type SeatBootstrapConfig,
  applyTurnEvent,
  bootstrapSession,
  completeHand,
  dealHoleCards,
  muckHand,
  recoverMisdeal,
  replayEvents,
  revealCommunityCards,
  transitionSeat,
} from '../session/lifecycle';
import { createTableSnapshot } from '../testing';
import type { Card, HandStage } from '../types/common';
import type { TurnEvent } from '../types/events';
import type { SessionConfig } from '../types/session';
import type { Seat, ShowdownSummary } from '../types/snapshot';

const sampleDeck: Card[] = (() => {
  const ranks = [
    'A',
    'K',
    'Q',
    'J',
    'T',
    '9',
    '8',
    '7',
    '6',
    '5',
    '4',
    '3',
    '2',
  ] as const;
  const suits = ['s', 'h', 'd', 'c'] as const;
  const deck: Card[] = [];
  for (const rank of ranks) {
    for (const suit of suits) {
      deck.push(`${rank}${suit}` as Card);
    }
  }
  return deck;
})();

const baseSeats: SeatBootstrapConfig[] = [
  { playerId: 'player-a', stack: 100, displayName: 'Alice', seatIndex: 0 },
  { playerId: 'player-b', stack: 100, displayName: 'Bob', seatIndex: 1 },
  { playerId: 'player-c', stack: 100, displayName: 'Cara', seatIndex: 2 },
];

function createConfig(): SessionConfig {
  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats: 6,
    startingStack: 100,
    blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
    antePolicy: { type: 'uniform', amount: 1, appliesTo: 'everyone' },
    personaPolicy: {
      defaultStyle: 'balanced',
      fallbackStyle: 'tight-passive',
      overrides: { 'player-b': 'loose-aggressive' },
    },
    ruleSet: {
      streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
      postingOrder: ['small-blind', 'big-blind', 'ante'],
      minRaisePolicy: 'double-last-bet',
      maxRaisePolicy: 'all-in',
      cardDistribution: {
        holeCardsPerPlayer: 2,
        burnPerStreet: [1, 1, 1],
        communityReveal: [3, 1, 1],
      },
      showdownOrdering: 'high-card',
    },
    evaluationPolicy: {
      engine: 'lookup-table',
      evaluatorId: 'default-evaluator',
      supportsHiLo: false,
      cacheSize: 1024,
    },
    autoAdvance: true,
  };
}

function buildSeats(
  overrides: Record<string, Partial<SeatBootstrapConfig>> = {},
): SeatBootstrapConfig[] {
  const merged = baseSeats.map((seat) => ({
    ...seat,
    ...(overrides[seat.playerId] ?? {}),
  }));

  for (const [playerId, patch] of Object.entries(overrides)) {
    const existing = merged.find((seat) => seat.playerId === playerId);
    if (existing) continue;
    merged.push({
      playerId,
      stack: patch.stack ?? 100,
      displayName: patch.displayName ?? playerId,
      seatIndex: patch.seatIndex,
      status: patch.status ?? 'occupied',
      avatarUrl: patch.avatarUrl,
      personaId: patch.personaId,
      rebuyTokens: patch.rebuyTokens,
    });
  }

  return merged;
}

describe('session lifecycle batch U2 validations', () => {
  test('initial snapshot assembly seeds core configuration artifacts', () => {
    const config = createConfig();
    const session = bootstrapSession(config, buildSeats(), {
      deck: sampleDeck,
    });

    expect(session.initialSnapshot).toEqual(session.activeSnapshot);

    const snapshot = session.activeSnapshot;
    expect(snapshot.index).toBe(0);
    expect(snapshot.handNumber).toBe(1);
    expect(snapshot.seating.seats).toHaveLength(config.maxSeats);
    expect(snapshot.hand.blinds.smallBlind.amount).toBe(1);
    expect(snapshot.hand.blinds.bigBlind.amount).toBe(2);
    expect(snapshot.hand.ante?.amount).toBe(1);
    expect(snapshot.cards.remainingDeck).toHaveLength(sampleDeck.length);
    expect(snapshot.personas.entries['player-b']?.style).toBe(
      'loose-aggressive',
    );
    expect(snapshot.clock.currentActor).toBe('player-a');

    expect(snapshot.pots.main.amount).toBe(6);
    expect(snapshot.pots.main.contributions['player-a']).toBe(1);
    expect(snapshot.pots.main.contributions['player-b']).toBe(2);
    expect(snapshot.pots.main.contributions['player-c']).toBe(3);
    expect(snapshot.hand.id).toBe(
      createDeterministicHandId(session.id, snapshot.handNumber),
    );
  });

  test('persona initialization normalizes traits and telemetry to percentages', () => {
    const config = createConfig();
    const timestamp = 1_700_000_123_456;
    const session = bootstrapSession(config, buildSeats(), {
      timestamp,
      personaSubstitutions: { 'player-c': 'exploitative' },
    });

    const personas = session.activeSnapshot.personas.entries;
    const balanced = personas['player-a'];
    const looseAggressive = personas['player-b'];
    const exploitative = personas['player-c'];

    expect(balanced).toBeDefined();
    expect(looseAggressive).toBeDefined();
    expect(exploitative).toBeDefined();
    if (!balanced || !looseAggressive || !exploitative) return;

    expect(balanced.style).toBe('balanced');
    expect(balanced.aggression).toBe(50);
    expect(balanced.tightness).toBe(50);
    expect(balanced.bluffIndex).toBe(50);
    expect(balanced.riskTolerance).toBe(50);
    expect(balanced.adaptation.trackedMetrics).toEqual({
      vpip: 0,
      pfr: 0,
      aggressionFactor: 0,
      showdownRate: 0,
      tiltIndicator: 0,
    });
    expect(balanced.adaptation.featureVector).toEqual([
      balanced.aggression / 100,
      balanced.tightness / 100,
      balanced.bluffIndex / 100,
      balanced.riskTolerance / 100,
    ]);
    expect(balanced.adaptation.lastUpdated).toBe(timestamp);

    expect(looseAggressive.style).toBe('loose-aggressive');
    expect(looseAggressive.aggression).toBe(88);
    expect(looseAggressive.tightness).toBe(28);
    expect(looseAggressive.bluffIndex).toBe(82);
    expect(looseAggressive.riskTolerance).toBe(78);
    expect(looseAggressive.adaptation.trackedMetrics.tiltIndicator).toBe(0);
    expect(looseAggressive.adaptation.trackedMetrics.vpip).toBe(0);
    expect(looseAggressive.adaptation.featureVector).toEqual([
      looseAggressive.aggression / 100,
      looseAggressive.tightness / 100,
      looseAggressive.bluffIndex / 100,
      looseAggressive.riskTolerance / 100,
    ]);

    expect(exploitative.style).toBe('exploitative');
    expect(exploitative.aggression).toBe(65);
    expect(exploitative.tightness).toBe(58);
    expect(exploitative.bluffIndex).toBe(68);
    expect(exploitative.riskTolerance).toBe(62);
    expect(exploitative.adaptation.trackedMetrics).toEqual({
      vpip: 0,
      pfr: 0,
      aggressionFactor: 0,
      showdownRate: 0,
      tiltIndicator: 0,
    });
  });

  test('event replay reproduces the active snapshot without drift', () => {
    const config = createConfig();
    let session = bootstrapSession(config, buildSeats(), {
      deck: sampleDeck,
    });

    const firstSnapshot = session.activeSnapshot;
    const eventA: TurnEvent = {
      id: 'event-a',
      actor: 'player-a',
      action: { type: 'call', amount: 2 },
      legalOptions: [{ type: 'call', amount: 2 }],
      stackBefore: firstSnapshot.seating.seats[0]!.stack,
      stackAfter: firstSnapshot.seating.seats[0]!.stack - 2,
      contribution: 2,
      timestamp: Date.now(),
      metadata: { engineVersion: 'test', availableActionsAtDecision: [] },
    };
    session = applyTurnEvent(session, eventA);

    const secondSnapshot = session.activeSnapshot;
    const eventB: TurnEvent = {
      id: 'event-b',
      actor: 'player-b',
      action: { type: 'raise', amount: 6 },
      legalOptions: [
        {
          type: 'raise',
          min: 4,
          max: secondSnapshot.seating.seats[1]!.stack,
          increment: 2,
        },
      ],
      stackBefore: secondSnapshot.seating.seats[1]!.stack,
      stackAfter: secondSnapshot.seating.seats[1]!.stack - 6,
      contribution: 6,
      timestamp: Date.now(),
      metadata: { engineVersion: 'test', availableActionsAtDecision: [] },
    };
    session = applyTurnEvent(session, eventB);

    const replayed = replayEvents(session.initialSnapshot, session.events);
    expect(replayed).toEqual(session.activeSnapshot);
  });

  test('hand reset flow clears ledgers and rotates the dealer button', () => {
    const config = createConfig();
    const session = bootstrapSession(config, buildSeats(), {
      deck: sampleDeck,
    });

    const progressed = completeHand(session);

    expect(progressed.activeSnapshot.handNumber).toBe(
      session.activeSnapshot.handNumber + 1,
    );
    expect(progressed.activeSnapshot.pots.main.amount).toBe(6);
    expect(progressed.activeSnapshot.hand.buttonSeat).toBe(1);
    expect(progressed.initialSnapshot).toEqual(progressed.activeSnapshot);
    expect(replayEvents(progressed.initialSnapshot, progressed.events)).toEqual(
      progressed.activeSnapshot,
    );
    expect(progressed.activeSnapshot.hand.id).toBe(
      createDeterministicHandId(
        progressed.id,
        progressed.activeSnapshot.handNumber,
      ),
    );
    expect(progressed.events).toHaveLength(0);
  });

  test('seat lifecycle transitions preserve occupant metadata', () => {
    const config = createConfig();
    let session = bootstrapSession(
      config,
      buildSeats({
        'player-d': {
          playerId: 'player-d',
          stack: 80,
          displayName: 'Dana',
          seatIndex: 3,
        },
      }),
      { deck: sampleDeck },
    );

    session = transitionSeat(session, 1, 'leaving');
    expect(session.activeSnapshot.seating.seats[1]?.occupant?.displayName).toBe(
      'Bob',
    );

    session = transitionSeat(session, 1, 'reserved');
    expect(session.activeSnapshot.seating.seats[1]?.occupant?.displayName).toBe(
      'Bob',
    );

    session = transitionSeat(session, 1, 'occupied');
    expect(session.activeSnapshot.seating.seats[1]?.occupant?.displayName).toBe(
      'Bob',
    );

    session = transitionSeat(session, 3, 'reserved', {
      playerId: 'player-d',
      displayName: 'Dana',
    });
    expect(session.activeSnapshot.seating.seats[3]?.occupant?.displayName).toBe(
      'Dana',
    );

    session = transitionSeat(session, 3, 'open');
    expect(session.activeSnapshot.seating.seats[3]?.occupant).toBeUndefined();
    expect(session.activeSnapshot.seating.seats[3]?.stack).toBe(0);

    session = transitionSeat(session, 3, 'occupied', {
      occupant: {
        playerId: 'player-e',
        displayName: 'Eve',
      },
      stack: 120,
    });
    expect(session.activeSnapshot.seating.seats[3]?.occupant?.displayName).toBe(
      'Eve',
    );
    expect(session.activeSnapshot.seating.seats[3]?.stack).toBe(120);
  });

  test('persona resolution honors overrides and substitution directives', () => {
    const config = createConfig();
    const session = bootstrapSession(config, buildSeats(), {
      deck: sampleDeck,
      personaSubstitutions: { 'player-c': 'exploitative' },
    });

    const personas = session.activeSnapshot.personas.entries;
    expect(personas['player-a']?.style).toBe('balanced');
    expect(personas['player-b']?.style).toBe('loose-aggressive');
    expect(personas['player-c']?.style).toBe('exploitative');
  });

  test('blinds and antes enforce postings and flag short stacks', () => {
    const config = createConfig();
    const session = bootstrapSession(
      config,
      buildSeats({ 'player-c': { stack: 2 } }),
      { deck: sampleDeck },
    );

    const snapshot = session.activeSnapshot;
    expect(snapshot.pots.main.amount).toBe(5);
    expect(snapshot.pots.main.contributions['player-a']).toBe(1);
    expect(snapshot.pots.main.contributions['player-b']).toBe(2);
    expect(snapshot.pots.main.contributions['player-c']).toBe(2);
    expect(snapshot.flags.pendingEliminations).toContain('player-c');
    expect(snapshot.seating.seats[2]?.status).toBe('leaving');
  });

  test('dealing hole cards shrinks the deck and misdeal recovery restores it', () => {
    const config = createConfig();
    const session = bootstrapSession(config, buildSeats(), {
      deck: sampleDeck,
    });

    const originalDeck = session.activeSnapshot.cards.remainingDeck.slice();
    const { session: dealtSession, dealtCards } = dealHoleCards(session, [
      'player-a',
      'player-b',
    ]);

    const perPlayer = config.ruleSet.cardDistribution.holeCardsPerPlayer;
    const expectedCardsDealt = perPlayer * 2;
    expect(dealtCards).toHaveLength(expectedCardsDealt);

    expect(dealtSession.activeSnapshot.cards.remainingDeck).toHaveLength(
      originalDeck.length - expectedCardsDealt,
    );

    const recovered = recoverMisdeal(dealtSession, dealtCards);
    expect(recovered.activeSnapshot.cards.remainingDeck).toEqual(originalDeck);
    expect(recovered.activeSnapshot.cards.holeCards['player-a']).toBeNull();
    expect(recovered.activeSnapshot.cards.holeCards['player-b']).toBeNull();
  });

  test('community reveals append scheduled events for flop, turn, and river', () => {
    const config = createConfig();
    let session = bootstrapSession(config, buildSeats(), {
      deck: sampleDeck,
    });

    const streets = config.ruleSet.streets;
    const distribution = config.ruleSet.cardDistribution;

    const getCounts = (
      stage: Extract<HandStage, 'flop' | 'turn' | 'river'>,
    ) => {
      const stageIndex = streets.indexOf(stage);
      const revealIndex = ['flop', 'turn', 'river'].indexOf(stage);
      const burnArray = distribution.burnPerStreet ?? [];
      const communityArray = distribution.communityReveal ?? [];
      const defaultReveal = stage === 'flop' ? 3 : 1;
      const burn =
        burnArray.length === 3
          ? (burnArray[revealIndex] ?? 0)
          : stageIndex < burnArray.length
            ? (burnArray[stageIndex] ?? 0)
            : (burnArray[revealIndex] ?? 0);
      const reveal =
        communityArray.length === 3
          ? (communityArray[revealIndex] ?? defaultReveal)
          : stageIndex < communityArray.length
            ? (communityArray[stageIndex] ?? defaultReveal)
            : (communityArray[revealIndex] ?? defaultReveal);
      return { burn, reveal };
    };

    const takeCommunity = (
      current: typeof session,
      stage: Extract<HandStage, 'flop' | 'turn' | 'river'>,
    ): readonly Card[] => {
      const { burn, reveal } = getCounts(stage);
      return current.activeSnapshot.cards.remainingDeck.slice(
        burn,
        burn + reveal,
      );
    };

    const flopBurnCards = session.activeSnapshot.cards.remainingDeck.slice(
      0,
      getCounts('flop').burn,
    );
    const flopCards = takeCommunity(session, 'flop');
    session = revealCommunityCards(session, 'flop', flopCards, 10_000);

    const turnBurnCards = session.activeSnapshot.cards.remainingDeck.slice(
      0,
      getCounts('turn').burn,
    );
    const turnCards = takeCommunity(session, 'turn');
    session = revealCommunityCards(session, 'turn', turnCards, 10_000);

    const riverBurnCards = session.activeSnapshot.cards.remainingDeck.slice(
      0,
      getCounts('river').burn,
    );
    const riverCards = takeCommunity(session, 'river');
    session = revealCommunityCards(session, 'river', riverCards, 10_000);

    const community = session.activeSnapshot.cards.community;
    expect(community.revealSchedule).toHaveLength(6);
    expect(community.revealSchedule.map((entry) => entry.reason)).toEqual([
      'burn',
      'deal',
      'burn',
      'deal',
      'burn',
      'deal',
    ]);
    expect(community.revealSchedule.map((entry) => entry.stage)).toEqual([
      'flop',
      'flop',
      'turn',
      'turn',
      'river',
      'river',
    ]);
    expect(community.revealSchedule.map((entry) => entry.cards)).toEqual([
      flopBurnCards,
      flopCards,
      turnBurnCards,
      turnCards,
      riverBurnCards,
      riverCards,
    ]);
    expect(community.flop).toEqual(flopCards);
    expect(community.turn).toBe(turnCards[0]);
    expect(community.river).toBe(riverCards[0]);
    expect(session.activeSnapshot.cards.burnPile).toHaveLength(3);
  });

  test('hole card distribution supports configurable counts', () => {
    const baseConfig = createConfig();
    const config: SessionConfig = {
      ...baseConfig,
      ruleSet: {
        ...baseConfig.ruleSet,
        cardDistribution: {
          ...baseConfig.ruleSet.cardDistribution,
          holeCardsPerPlayer: 4,
        },
      },
    };

    const session = bootstrapSession(config, buildSeats(), {
      deck: sampleDeck,
    });

    const order = ['player-a', 'player-b'];
    const { session: dealt } = dealHoleCards(session, order);

    for (const playerId of order) {
      const cards = dealt.activeSnapshot.cards.holeCards[playerId];
      expect(cards).toHaveLength(4);
    }

    expect(dealt.activeSnapshot.cards.remainingDeck).toHaveLength(
      sampleDeck.length - order.length * 4,
    );
  });

  test('hole card visibility resets on muck and new hand', () => {
    const config = createConfig();
    const session = bootstrapSession(config, buildSeats(), {
      deck: sampleDeck,
    });

    const { session: dealtSession } = dealHoleCards(session, [
      'player-a',
      'player-b',
    ]);

    expect(
      dealtSession.activeSnapshot.cards.holeCards['player-a'],
    ).not.toBeNull();
    expect(
      dealtSession.activeSnapshot.cards.holeCards['player-b'],
    ).not.toBeNull();

    const mucked = muckHand(dealtSession, 'player-a');
    expect(mucked.activeSnapshot.cards.holeCards['player-a']).toBeNull();
    expect(mucked.activeSnapshot.cards.holeCards['player-b']).not.toBeNull();

    const reset = completeHand(mucked, { deck: sampleDeck });
    for (const entry of Object.values(reset.activeSnapshot.cards.holeCards)) {
      expect(entry).toBeNull();
    }
  });

  test('reducer applies metadata stage transition with community reveal', () => {
    const config = createConfig();
    const stagedDeck: Card[] = ['2c', 'As', 'Ks', 'Qs', 'Td', '9d'];
    const session = bootstrapSession(config, buildSeats(), {
      deck: stagedDeck,
    });

    const snapshot = session.activeSnapshot;
    const seat = snapshot.seating.seats[0];
    const stackBefore = seat?.stack ?? 0;
    const event: TurnEvent = {
      id: 'metadata-stage',
      actor: seat?.occupant?.playerId ?? 'player-a',
      action: { type: 'check' },
      legalOptions: [{ type: 'check' }],
      stackBefore,
      stackAfter: stackBefore,
      contribution: 0,
      timestamp: 1_000,
      metadata: {
        engineVersion: 'test',
        availableActionsAtDecision: [{ type: 'check' }],
        nextHandStage: 'flop',
        cardReveals: {
          community: [
            {
              stage: 'flop',
              cards: ['As', 'Ks', 'Qs'],
            },
          ],
        },
        personaFlagUpdates: { showdownLocked: true },
      },
    };

    const reduced = reduce(snapshot, event);

    expect(reduced.hand.stage).toBe('flop');
    const flopRound = reduced.hand.bettingRounds.find(
      (round) => round.stage === 'flop',
    );
    expect(flopRound).toBeDefined();
    expect(reduced.cards.community.flop).toEqual(['As', 'Ks', 'Qs']);
    expect(reduced.cards.remainingDeck).not.toContain('As');
    expect(reduced.cards.remainingDeck).not.toContain('Ks');
    expect(reduced.cards.remainingDeck).not.toContain('Qs');
    expect(reduced.cards.community.revealSchedule.at(-1)?.stage).toBe('flop');
    expect(reduced.flags.showdownLocked).toBe(true);
  });

  test('metadata payout summary settles the hand and redistributes chips', () => {
    const snapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 50 },
        { id: 'player-b', stack: 50 },
      ],
      handStage: 'river',
    });

    const updatedSeats: Seat[] = snapshot.seating.seats.map(
      (seat): Seat =>
        seat.occupant?.playerId === 'player-b'
          ? { ...seat, stack: 0, status: 'leaving' }
          : seat,
    );

    const withPot = {
      ...snapshot,
      seating: {
        ...snapshot.seating,
        seats: updatedSeats,
      },
      pots: {
        ...snapshot.pots,
        main: {
          ...snapshot.pots.main,
          amount: 50,
          contributions: {
            ...snapshot.pots.main.contributions,
            'player-a': 25,
            'player-b': 25,
          },
        },
      },
      hand: { ...snapshot.hand, stage: 'river' as const },
    };

    const seatA = withPot.seating.seats.find(
      (seat) => seat.occupant?.playerId === 'player-a',
    );
    const stackBefore = seatA?.stack ?? 0;
    const showdown: ShowdownSummary = {
      evaluatedHands: [
        {
          playerId: 'player-a',
          rankClass: 'pair',
          rankValue: 2,
          bestFive: ['As', 'Ad', 'Kc', 'Qh', 'Js'],
          kickers: ['Ts', '9h', '8c'],
        },
      ],
      board: ['As', 'Kd', 'Qs', 'Jh', 'Ts'],
      evaluatorId: 'default-evaluator',
    };

    const event: TurnEvent = {
      id: 'settle-hand',
      actor: 'player-a',
      action: { type: 'check' },
      legalOptions: [{ type: 'check' }],
      stackBefore,
      stackAfter: stackBefore,
      contribution: 0,
      timestamp: 2_000,
      metadata: {
        engineVersion: 'test',
        availableActionsAtDecision: [{ type: 'check' }],
        showdownSummary: showdown,
        payoutSummary: {
          entries: [{ playerId: 'player-a', amount: 50, potIds: ['main'] }],
          rake: 0,
        },
      },
    };

    const reduced = reduce(withPot, event);

    expect(reduced.hand.stage).toBe('settled');
    expect(reduced.hand.showdown).toEqual(showdown);
    expect(reduced.hand.payouts?.entries).toEqual([
      { playerId: 'player-a', amount: 50, potIds: ['main'] },
    ]);
    const seatAfter = reduced.seating.seats.find(
      (seat) => seat.occupant?.playerId === 'player-a',
    );
    expect(seatAfter?.stack).toBe(stackBefore + 50);
    const losingSeat = reduced.seating.seats.find(
      (seat) => seat.occupant?.playerId === 'player-b',
    );
    expect(losingSeat?.stack).toBe(0);
    expect(reduced.pots.main.amount).toBe(0);
    expect(
      Object.values(reduced.pots.main.contributions).every(
        (value) => value === 0,
      ),
    ).toBe(true);
    expect(reduced.flags.pendingEliminations).toContain('player-b');
    expect(reduced.flags.showdownLocked).toBe(true);
    expect(reduced.clock.currentActor).toBeUndefined();
  });
});
