import { describe, expect, test } from 'vitest';

import {
  SessionManager,
  selectDecisionContext,
  selectHandSummary,
  selectTableView,
  toSnapshotEnvelope,
} from '..';
import { applyAutoRunout } from '../session/auto-runout';
import type { SeatBootstrapConfig } from '../session/lifecycle';
import { replayEvents } from '../session/lifecycle';
import { createTableSnapshot } from '../testing';
import type { Card, HandStage } from '../types/common';
import type { PlayerOption, TurnEvent, TurnIntent } from '../types/events';
import type { SessionConfig } from '../types/session';

const autoRunoutDeck: Card[] = [
  'As',
  'Ks',
  'Qs',
  'Js',
  'Ts',
  '9s',
  '8s',
  '7s',
  '6s',
  '5s',
];

function requireActor(actor: string | undefined): string {
  if (!actor) {
    throw new Error('expected actor to be defined');
  }
  return actor;
}

function createHeadsUpConfig(
  maxSeats: SessionConfig['maxSeats'] = 2,
): SessionConfig {
  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats,
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
        burnPerStreet: [0, 1, 1],
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
    autoAdvance: true,
  };
}

function createSeats(): SeatBootstrapConfig[] {
  return [
    { playerId: 'player-a', stack: 100, seatIndex: 0, displayName: 'Hero' },
    { playerId: 'player-b', stack: 100, seatIndex: 1, displayName: 'Villain' },
  ];
}

function buildIntentFromOption(
  actor: string,
  option: PlayerOption,
  version: number,
  issuedAt: number,
  allInFrom: 'bet' | 'call' = 'bet',
): TurnIntent {
  switch (option.type) {
    case 'fold':
      return {
        id: `${actor}-fold`,
        actor,
        requested: { type: 'fold' } as const,
        issuedAt,
        origin: 'ui' as const,
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    case 'check':
      return {
        id: `${actor}-check`,
        actor,
        requested: { type: 'check' } as const,
        issuedAt,
        origin: 'ui' as const,
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    case 'call':
      return {
        id: `${actor}-call`,
        actor,
        requested: { type: 'call', amount: option.amount } as const,
        issuedAt,
        origin: 'ui' as const,
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    case 'bet':
      return {
        id: `${actor}-bet`,
        actor,
        requested: { type: 'bet', amount: option.min } as const,
        issuedAt,
        origin: 'ui' as const,
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    case 'raise':
      return {
        id: `${actor}-raise`,
        actor,
        requested: {
          type: 'raise',
          amount: option.min,
          to: option.min,
        } as const,
        issuedAt,
        origin: 'ui' as const,
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    case 'all-in':
      return {
        id: `${actor}-all-in`,
        actor,
        requested: {
          type: 'all-in',
          amount: option.amount,
          from: allInFrom,
        } as const,
        issuedAt,
        origin: 'ui' as const,
        expectedSnapshotVersion: version,
      } satisfies TurnIntent;
    default:
      return assertUnreachable(option);
  }
}

function assertUnreachable(value: never): never {
  throw new Error(`Unhandled player option type: ${JSON.stringify(value)}`);
}

describe('@batch(I1) table flow orchestration', () => {
  test('walk in the big blind leaves the pot uncontested and rolls to the next hand', async () => {
    const manager = SessionManager.create(
      createHeadsUpConfig(),
      createSeats(),
      {
        now: () => 1_000,
      },
    );

    const decision = selectDecisionContext(manager.session);
    expect(decision.actor).toBe('player-a');
    const foldOption = decision.availableActions.find(
      (option) => option.type === 'fold',
    );
    expect(foldOption).toBeDefined();
    if (!foldOption) return;

    const foldIntent = buildIntentFromOption(
      requireActor(decision.actor),
      foldOption,
      manager.session.activeSnapshot.index,
      1_000,
    );

    const result = await manager.applyIntent(foldIntent);
    expect(result.validation.kind).toBe('accepted');
    if (result.validation.kind !== 'accepted') return;

    expect(result.eventEnvelope).toBeDefined();
    expect(manager.eventLog).toHaveLength(1);

    const table = selectTableView(result.session);
    expect(table.potTotal).toBe(0);
    const smallBlindSeat = table.seats.find(
      (seat) => seat.playerId === 'player-a',
    );
    const bigBlindSeat = table.seats.find(
      (seat) => seat.playerId === 'player-b',
    );
    expect(smallBlindSeat?.stack).toBe(99);
    expect(bigBlindSeat?.stack).toBe(101);
    expect(result.session.activeSnapshot.hand.stage).toBe('settled');
    expect(table.currentActor).toBeUndefined();

    const postFoldDecision = selectDecisionContext(result.session);
    expect(postFoldDecision.actor).toBeUndefined();
    expect(postFoldDecision.availableActions).toHaveLength(0);
    expect(postFoldDecision.playersLeftToAct).toHaveLength(0);

    const { session: nextHand } = await manager.advanceHand();
    expect(nextHand.events).toHaveLength(0);
    expect(manager.eventLog).toHaveLength(0);
    expect(nextHand.activeSnapshot.handNumber).toBe(2);
    expect(nextHand.activeSnapshot.seating.dealerButton).toBe(1);
    expect(nextHand.activeSnapshot.clock.currentActor).toBe('player-b');
  });

  test('auto-settles uncontested pots when the final opponent folds', async () => {
    let now = 5_000;
    const manager = SessionManager.create(
      createHeadsUpConfig(),
      createSeats(),
      {
        now: () => now,
      },
    );

    const initialSnapshot = manager.session.activeSnapshot;
    const initialStacks = new Map(
      initialSnapshot.seating.seats
        .filter((seat) => seat.occupant)
        .map((seat) => [seat.occupant!.playerId, seat.stack] as const),
    );
    const initialStackTotal = Array.from(initialStacks.values()).reduce(
      (sum, stack) => sum + stack,
      0,
    );
    const initialPotTotal =
      initialSnapshot.pots.main.amount +
      initialSnapshot.pots.sides.reduce((sum, pot) => sum + pot.amount, 0);

    const openingDecision = selectDecisionContext(manager.session);
    expect(openingDecision.actor).toBe('player-a');
    const raiseOption =
      openingDecision.availableActions.find(
        (option) => option.type === 'raise',
      ) ??
      openingDecision.availableActions.find((option) => option.type === 'bet');
    expect(raiseOption).toBeDefined();
    if (!raiseOption || !openingDecision.actor) return;

    const raiseIntent = buildIntentFromOption(
      requireActor(openingDecision.actor),
      raiseOption,
      manager.session.activeSnapshot.index,
      now,
    );

    const raiseResult = await manager.applyIntent(raiseIntent);
    expect(raiseResult.validation.kind).toBe('accepted');

    now += 1;

    const responseDecision = selectDecisionContext(manager.session);
    expect(responseDecision.actor).toBe('player-b');
    const foldOption = responseDecision.availableActions.find(
      (option) => option.type === 'fold',
    );
    expect(foldOption).toBeDefined();
    if (!foldOption || !responseDecision.actor) return;

    const foldIntent = buildIntentFromOption(
      requireActor(responseDecision.actor),
      foldOption,
      manager.session.activeSnapshot.index,
      now,
    );

    const foldResult = await manager.applyIntent(foldIntent);
    expect(foldResult.validation.kind).toBe('accepted');

    const snapshot = manager.session.activeSnapshot;
    expect(snapshot.hand.stage).toBe('settled');

    expect(snapshot.pots.main.amount).toBe(0);
    expect(
      Object.values(snapshot.pots.main.contributions).every(
        (amount) => amount === 0,
      ),
    ).toBe(true);
    expect(snapshot.pots.sides.every((pot) => pot.amount === 0)).toBe(true);
    expect(
      snapshot.pots.sides.every((pot) =>
        Object.values(pot.contributions).every((amount) => amount === 0),
      ),
    ).toBe(true);

    const finalStacks = new Map(
      snapshot.seating.seats
        .filter((seat) => seat.occupant)
        .map((seat) => [seat.occupant!.playerId, seat.stack] as const),
    );
    const finalStackTotal = Array.from(finalStacks.values()).reduce(
      (sum, stack) => sum + stack,
      0,
    );
    const finalPotTotal =
      snapshot.pots.main.amount +
      snapshot.pots.sides.reduce((sum, pot) => sum + pot.amount, 0);

    expect(finalStackTotal + finalPotTotal).toBe(
      initialStackTotal + initialPotTotal,
    );
    expect(
      Array.from(finalStacks.entries()).some(([playerId, stack]) => {
        const initial = initialStacks.get(playerId) ?? stack;
        return stack > initial;
      }),
    ).toBe(true);

    const postSettlementDecision = selectDecisionContext(manager.session);
    expect(postSettlementDecision.actor).toBeUndefined();
    expect(postSettlementDecision.availableActions).toHaveLength(0);
    expect(postSettlementDecision.playersLeftToAct).toHaveLength(0);
  });

  test('mutual all-ins clear the action clock so the board can auto-run', async () => {
    const manager = SessionManager.create(
      createHeadsUpConfig(),
      createSeats(),
      {
        now: () => 2_000,
        deck: autoRunoutDeck,
      },
    );

    const firstDecision = selectDecisionContext(manager.session);
    expect(firstDecision.actor).toBe('player-a');
    const shoveOption = firstDecision.availableActions.find(
      (option) => option.type === 'all-in',
    );
    expect(shoveOption).toBeDefined();
    if (!shoveOption) return;

    const shoveIntent = buildIntentFromOption(
      requireActor(firstDecision.actor),
      shoveOption,
      manager.session.activeSnapshot.index,
      2_000,
    );

    const shoveResult = await manager.applyIntent(shoveIntent);
    expect(shoveResult.validation.kind).toBe('accepted');
    if (shoveResult.validation.kind !== 'accepted') return;

    const responseDecision = selectDecisionContext(shoveResult.session);
    expect(responseDecision.actor).toBe('player-b');
    const responseOption =
      responseDecision.availableActions.find(
        (option) => option.type === 'all-in',
      ) ??
      responseDecision.availableActions.find(
        (option) => option.type === 'call',
      );
    expect(responseOption).toBeDefined();
    if (!responseOption) return;

    const responseIntent =
      responseOption.type === 'all-in'
        ? buildIntentFromOption(
            requireActor(responseDecision.actor),
            responseOption,
            shoveResult.session.activeSnapshot.index,
            2_001,
            'call',
          )
        : buildIntentFromOption(
            requireActor(responseDecision.actor),
            responseOption,
            shoveResult.session.activeSnapshot.index,
            2_001,
          );

    const showdownResult = await manager.applyIntent(responseIntent);
    expect(showdownResult.validation.kind).toBe('accepted');
    if (showdownResult.validation.kind !== 'accepted') return;

    expect(manager.eventLog).toHaveLength(2);
    const stalledDecision = selectDecisionContext(showdownResult.session);
    expect(stalledDecision.actor).toBeUndefined();
    expect(stalledDecision.availableActions).toHaveLength(0);
    expect(stalledDecision.playersLeftToAct).toHaveLength(0);

    const table = selectTableView(showdownResult.session);
    expect(table.currentActor).toBeUndefined();
    const allInStatuses = table.seats.map((seat) => seat.isAllIn);
    expect(allInStatuses).toEqual([true, true]);

    const snapshot = showdownResult.session.activeSnapshot;
    expect(snapshot.flags.autoRunout).toBe(true);

    const community = snapshot.cards.community;
    expect(community.flop).toEqual(['As', 'Ks', 'Qs']);
    expect(community.turn).toBe('Ts');
    expect(community.river).toBe('8s');
    expect(community.revealSchedule.map((entry) => entry.reason)).toEqual([
      'deal',
      'burn',
      'deal',
      'burn',
      'deal',
    ]);
    expect(community.revealSchedule.map((entry) => entry.stage)).toEqual([
      'flop',
      'turn',
      'turn',
      'river',
      'river',
    ]);
    expect(community.revealSchedule.map((entry) => entry.cards)).toEqual([
      ['As', 'Ks', 'Qs'],
      ['Js'],
      ['Ts'],
      ['9s'],
      ['8s'],
    ]);
    expect(community.revealSchedule.map((entry) => entry.timestamp)).toEqual([
      2_001, 2_001, 2_001, 2_001, 2_001,
    ]);
    expect(snapshot.cards.burnPile).toEqual(['Js', '9s']);
    expect(snapshot.cards.remainingDeck).toEqual(['7s', '6s', '5s']);

    const showdownEnvelope = showdownResult.eventEnvelope;
    expect(showdownEnvelope).toBeDefined();
    if (!showdownEnvelope) return;

    const communityReveals =
      showdownEnvelope.event.metadata?.cardReveals?.community;
    expect(communityReveals).toBeDefined();
    if (!communityReveals) return;

    expect(communityReveals.map((entry) => entry.stage)).toEqual([
      'flop',
      'turn',
      'turn',
      'river',
      'river',
    ]);
    expect(communityReveals.map((entry) => entry.reason)).toEqual([
      'deal',
      'burn',
      'deal',
      'burn',
      'deal',
    ]);
    expect(communityReveals.map((entry) => entry.cards)).toEqual([
      ['As', 'Ks', 'Qs'],
      ['Js'],
      ['Ts'],
      ['9s'],
      ['8s'],
    ]);
  });

  test('stage advancement appends flop reveal metadata to the triggering event', async () => {
    const manager = SessionManager.create(
      createHeadsUpConfig(),
      createSeats(),
      {
        now: () => 5_000,
        deck: autoRunoutDeck,
      },
    );

    const firstDecision = selectDecisionContext(manager.session);
    const callOption = firstDecision.availableActions.find(
      (option) => option.type === 'call',
    );
    expect(callOption).toBeDefined();
    if (!callOption) return;

    const callIntent = buildIntentFromOption(
      requireActor(firstDecision.actor),
      callOption,
      manager.session.activeSnapshot.index,
      5_000,
    );

    const callOutcome = await manager.applyIntent(callIntent);
    expect(callOutcome.validation.kind).toBe('accepted');
    if (callOutcome.validation.kind !== 'accepted') return;

    const secondDecision = selectDecisionContext(callOutcome.session);
    const closingOption =
      secondDecision.availableActions.find(
        (option) => option.type === 'check',
      ) ??
      secondDecision.availableActions.find((option) => option.type === 'call');
    expect(closingOption).toBeDefined();
    if (!closingOption) return;

    const checkIntent = buildIntentFromOption(
      requireActor(secondDecision.actor),
      closingOption,
      callOutcome.session.activeSnapshot.index,
      5_001,
    );

    const checkOutcome = await manager.applyIntent(checkIntent);
    expect(checkOutcome.validation.kind).toBe('accepted');
    if (checkOutcome.validation.kind !== 'accepted') return;

    const envelope = checkOutcome.eventEnvelope;
    expect(envelope).toBeDefined();
    if (!envelope) return;

    const flopReveal = envelope.event.metadata?.cardReveals?.community;
    expect(flopReveal).toBeDefined();
    if (!flopReveal) return;

    expect(flopReveal.map((entry) => entry.stage)).toEqual(['flop']);
    expect(flopReveal[0]?.cards).toEqual(['As', 'Ks', 'Qs']);

    const replayed = replayEvents(
      checkOutcome.session.initialSnapshot,
      checkOutcome.session.events,
    );
    expect(replayed.cards.community.flop).toEqual(['As', 'Ks', 'Qs']);
  });

  test('river check-check advances to showdown without a pending actor', async () => {
    const manager = SessionManager.create(
      createHeadsUpConfig(),
      createSeats(),
      {
        now: () => 10_000,
        deck: autoRunoutDeck,
      },
    );

    let issuedAt = 10_000;

    const chooseOption = (
      options: readonly PlayerOption[],
      preferences: readonly PlayerOption['type'][],
    ): PlayerOption | undefined => {
      for (const type of preferences) {
        const match = options.find((option) => option.type === type);
        if (match) {
          return match;
        }
      }
      return options[0];
    };

    const playAction = async (
      preferences: readonly PlayerOption['type'][],
    ): Promise<void> => {
      const decision = selectDecisionContext(manager.session);
      expect(decision.availableActions.length).toBeGreaterThan(0);
      const option = chooseOption(decision.availableActions, preferences);
      expect(option).toBeDefined();
      if (!option) return;

      const intent = buildIntentFromOption(
        requireActor(decision.actor),
        option,
        manager.session.activeSnapshot.index,
        issuedAt++,
      );

      const outcome = await manager.applyIntent(intent);
      expect(outcome.validation.kind).toBe('accepted');
    };

    // Preflop: call the blind, then check.
    await playAction(['call', 'check']);
    await playAction(['check', 'call']);
    expect(manager.session.activeSnapshot.hand.stage).toBe('flop');

    const playCheckDownStreet = async (expectedStage: HandStage) => {
      expect(manager.session.activeSnapshot.hand.stage).toBe(expectedStage);
      await playAction(['check', 'call']);
      await playAction(['check', 'call']);
    };

    await playCheckDownStreet('flop');
    expect(manager.session.activeSnapshot.hand.stage).toBe('turn');

    await playCheckDownStreet('turn');
    expect(manager.session.activeSnapshot.hand.stage).toBe('river');

    await playCheckDownStreet('river');

    const snapshot = manager.session.activeSnapshot;
    expect(snapshot.hand.stage).toBe('showdown');
    expect(snapshot.clock.currentActor).toBeUndefined();

    const decision = selectDecisionContext(manager.session);
    expect(decision.availableActions).toEqual([]);
    expect(decision.playersLeftToAct).toEqual([]);
  });

  test('resuming after mutual all-ins preserves auto-runout state', async () => {
    const manager = SessionManager.create(
      createHeadsUpConfig(),
      createSeats(),
      {
        now: () => 2_000,
        deck: autoRunoutDeck,
      },
    );

    const firstDecision = selectDecisionContext(manager.session);
    const shoveOption = firstDecision.availableActions.find(
      (option) => option.type === 'all-in',
    );
    expect(shoveOption).toBeDefined();
    if (!shoveOption) return;

    const shoveIntent = buildIntentFromOption(
      requireActor(firstDecision.actor),
      shoveOption,
      manager.session.activeSnapshot.index,
      2_000,
    );

    const shoveResult = await manager.applyIntent(shoveIntent);
    expect(shoveResult.validation.kind).toBe('accepted');
    if (shoveResult.validation.kind !== 'accepted') return;

    const responseDecision = selectDecisionContext(shoveResult.session);
    const responseOption =
      responseDecision.availableActions.find(
        (option) => option.type === 'all-in',
      ) ??
      responseDecision.availableActions.find(
        (option) => option.type === 'call',
      );
    expect(responseOption).toBeDefined();
    if (!responseOption) return;

    const responseIntent =
      responseOption.type === 'all-in'
        ? buildIntentFromOption(
            requireActor(responseDecision.actor),
            responseOption,
            shoveResult.session.activeSnapshot.index,
            2_001,
            'call',
          )
        : buildIntentFromOption(
            requireActor(responseDecision.actor),
            responseOption,
            shoveResult.session.activeSnapshot.index,
            2_001,
          );

    const showdownResult = await manager.applyIntent(responseIntent);
    expect(showdownResult.validation.kind).toBe('accepted');
    if (showdownResult.validation.kind !== 'accepted') return;

    const originalSnapshot = showdownResult.session.activeSnapshot;
    expect(originalSnapshot.flags.autoRunout).toBe(true);

    const resumeManager = SessionManager.resume(
      {
        sessionId: manager.session.id,
        config: manager.session.config,
        runtimeContext: manager.session.runtimeContext,
        initialSnapshot: toSnapshotEnvelope(manager.session.initialSnapshot),
        events: manager.eventLog,
        metrics: manager.session.metrics,
        channels: manager.session.channels,
      },
      {
        now: () => 2_002,
      },
    );

    const resumedSnapshot = resumeManager.session.activeSnapshot;
    expect(resumedSnapshot.index).toBe(originalSnapshot.index);
    expect(resumeManager.session.events.length).toBe(
      manager.session.events.length,
    );
    expect(resumedSnapshot.flags.autoRunout).toBe(true);
    expect(resumedSnapshot.cards.community.flop).toEqual(
      originalSnapshot.cards.community.flop,
    );
    expect(resumedSnapshot.cards.community.turn).toBe(
      originalSnapshot.cards.community.turn,
    );
    expect(resumedSnapshot.cards.community.river).toBe(
      originalSnapshot.cards.community.river,
    );
    expect(resumedSnapshot.cards.remainingDeck).toEqual(
      originalSnapshot.cards.remainingDeck,
    );
    expect(
      resumedSnapshot.cards.community.revealSchedule.map((entry) => ({
        stage: entry.stage,
        reason: entry.reason,
        cards: entry.cards,
      })),
    ).toEqual(
      originalSnapshot.cards.community.revealSchedule.map((entry) => ({
        stage: entry.stage,
        reason: entry.reason,
        cards: entry.cards,
      })),
    );
  });

  test('eliminated seats are marked pending and omitted from the next deal', async () => {
    const manager = SessionManager.create(createHeadsUpConfig(6), [
      { playerId: 'player-b', stack: 100, seatIndex: 0 },
      { playerId: 'player-a', stack: 1, seatIndex: 1 },
      { playerId: 'player-c', stack: 100, seatIndex: 2 },
    ]);

    const summary = selectHandSummary(manager.session);
    expect(summary.pendingEliminations).toContain('player-a');
    const eliminationSeat = manager.session.activeSnapshot.seating.seats[1];
    expect(eliminationSeat?.status).toBe('leaving');

    const { session: nextHand } = await manager.advanceHand();
    const updatedSummary = selectHandSummary(nextHand);
    expect(updatedSummary.pendingEliminations).toHaveLength(0);
    const reopenedSeat = nextHand.activeSnapshot.seating.seats[1];
    expect(reopenedSeat?.status).toBe('open');
    expect(reopenedSeat?.occupant).toBeUndefined();
  });

  test('button and blind assignments rotate across gaps in the seating chart', async () => {
    const manager = SessionManager.create(createHeadsUpConfig(6), [
      { playerId: 'player-a', stack: 100, seatIndex: 0 },
      { playerId: 'player-b', stack: 100, seatIndex: 1 },
      { playerId: 'player-c', stack: 100, seatIndex: 3 },
    ]);

    const initial = manager.session.activeSnapshot;
    expect(initial.seating.dealerButton).toBe(0);
    expect(initial.hand.blinds.smallBlind.playerId).toBe('player-b');
    expect(initial.hand.blinds.bigBlind.playerId).toBe('player-c');

    const { session: secondHand } = await manager.advanceHand();
    expect(secondHand.activeSnapshot.seating.dealerButton).toBe(1);
    expect(secondHand.activeSnapshot.hand.blinds.smallBlind.playerId).toBe(
      'player-c',
    );
    expect(secondHand.activeSnapshot.hand.blinds.bigBlind.playerId).toBe(
      'player-a',
    );

    const { session: thirdHand } = await manager.advanceHand();
    expect(thirdHand.activeSnapshot.seating.dealerButton).toBe(3);
    expect(thirdHand.activeSnapshot.hand.blinds.smallBlind.playerId).toBe(
      'player-a',
    );
    expect(thirdHand.activeSnapshot.hand.blinds.bigBlind.playerId).toBe(
      'player-b',
    );
  });

  test('auto-runout triggers when the covering player has no legal actions left', () => {
    const config = createHeadsUpConfig(6);
    const baseSnapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 250 },
        { id: 'player-b', stack: 100 },
        { id: 'player-c', stack: 100 },
      ],
    });

    const baseRound = baseSnapshot.hand.bettingRounds[0]!;
    const turnTimestamp = 2_000;

    const turns: TurnEvent[] = [
      {
        id: 'player-b-all-in',
        actor: 'player-b',
        action: { type: 'all-in', amount: 100, from: 'bet' },
        legalOptions: [],
        stackBefore: 100,
        stackAfter: 0,
        contribution: 100,
        timestamp: turnTimestamp,
        metadata: {
          engineVersion: 'engine-test',
          availableActionsAtDecision: [],
        },
      },
      {
        id: 'player-c-all-in',
        actor: 'player-c',
        action: { type: 'all-in', amount: 100, from: 'call' },
        legalOptions: [],
        stackBefore: 100,
        stackAfter: 0,
        contribution: 100,
        timestamp: turnTimestamp + 1,
        metadata: {
          engineVersion: 'engine-test',
          availableActionsAtDecision: [],
        },
      },
      {
        id: 'player-a-call',
        actor: 'player-a',
        action: { type: 'call', amount: 100, isAllIn: false },
        legalOptions: [],
        stackBefore: 250,
        stackAfter: 150,
        contribution: 100,
        timestamp: turnTimestamp + 2,
        metadata: {
          engineVersion: 'engine-test',
          availableActionsAtDecision: [],
        },
      },
    ];

    const snapshot = {
      ...baseSnapshot,
      hand: {
        ...baseSnapshot.hand,
        stage: baseSnapshot.hand.stage,
        bettingRounds: [
          {
            ...baseRound,
            turns,
            roundPot: 300,
            highestBet: 100,
            lastAggressor: 'player-b',
          },
        ],
      },
      seating: {
        ...baseSnapshot.seating,
        seats: baseSnapshot.seating.seats.map((seat) => {
          if (!seat.occupant) {
            return seat;
          }
          if (seat.occupant.playerId === 'player-a') {
            return { ...seat, stack: 150 };
          }
          if (seat.occupant.playerId === 'player-b') {
            return { ...seat, stack: 0 };
          }
          if (seat.occupant.playerId === 'player-c') {
            return { ...seat, stack: 0 };
          }
          return seat;
        }),
      },
      pots: {
        ...baseSnapshot.pots,
        main: {
          ...baseSnapshot.pots.main,
          amount: 300,
          contributions: {
            ...baseSnapshot.pots.main.contributions,
            'player-a': 100,
            'player-b': 100,
            'player-c': 100,
          },
        },
      },
      cards: {
        ...baseSnapshot.cards,
        remainingDeck: autoRunoutDeck,
      },
      clock: {
        ...baseSnapshot.clock,
        currentActor: 'player-a',
        perTurnMs: 30_000,
      },
    };

    const result = applyAutoRunout({
      snapshot,
      config,
      recentEvent: turns.at(-1)!,
      timestamp: turnTimestamp + 3,
    });

    expect(result.snapshot.flags.autoRunout).toBe(true);
    expect(result.snapshot.cards.community.flop).toEqual(['As', 'Ks', 'Qs']);
    expect(result.snapshot.cards.community.turn).toBe('Ts');
    expect(result.snapshot.cards.community.river).toBe('8s');
    expect(result.snapshot.cards.burnPile).toEqual(['Js', '9s']);
    expect(result.snapshot.clock.currentActor).toBeUndefined();
    expect(result.snapshot.clock.deadline).toBeUndefined();
    expect(result.cardReveals?.community).toEqual([
      { stage: 'flop', reason: 'deal', cards: ['As', 'Ks', 'Qs'] },
      { stage: 'turn', reason: 'burn', cards: ['Js'] },
      { stage: 'turn', reason: 'deal', cards: ['Ts'] },
      { stage: 'river', reason: 'burn', cards: ['9s'] },
      { stage: 'river', reason: 'deal', cards: ['8s'] },
    ]);
  });
});
