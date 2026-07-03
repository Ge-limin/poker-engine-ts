import { strict as assert } from 'node:assert';
import { describe, expect, test } from 'vitest';

import {
  createValidationConfig,
  deriveLegalOptionsForActor,
  reduce,
  validateIntent,
} from '..';
import { selectDecisionContext } from '../session/selectors';
import { createTableSnapshot, createTurnIntent } from '../testing';
import type { TurnEvent } from '../types/events';
import type { Session, SessionConfig } from '../types/session';
import type { TableSnapshot } from '../types/snapshot';

function withRoundState(
  snapshot: TableSnapshot,
  roundState: Partial<TableSnapshot['hand']['bettingRounds'][number]>,
  options: {
    readonly seatStacks?: Record<string, number>;
    readonly potAmount?: number;
    readonly contributions?: Record<string, number>;
    readonly currentActor?: string;
  } = {},
): TableSnapshot {
  const round = snapshot.hand.bettingRounds[0]!;
  const updatedRound = {
    ...round,
    ...roundState,
  };

  const mainPot = snapshot.pots.main;
  const updatedMainPot = {
    ...mainPot,
    amount: options.potAmount ?? mainPot.amount,
    contributions: options.contributions
      ? { ...mainPot.contributions, ...options.contributions }
      : mainPot.contributions,
  };

  const seats = snapshot.seating.seats.map((seat) => {
    const playerId = seat.occupant?.playerId;
    if (!playerId) {
      return seat;
    }

    const override = options.seatStacks?.[playerId];
    if (override === undefined) {
      return seat;
    }

    return { ...seat, stack: override };
  });

  return {
    ...snapshot,
    seating: { ...snapshot.seating, seats },
    hand: { ...snapshot.hand, bettingRounds: [updatedRound] },
    pots: { ...snapshot.pots, main: updatedMainPot },
    clock: {
      ...snapshot.clock,
      currentActor: options.currentActor ?? snapshot.clock.currentActor,
    },
  };
}

function buildSessionFromSnapshot(
  snapshot: TableSnapshot,
  config: SessionConfig,
): Session {
  return {
    id: 'session-effective-stack',
    config,
    runtimeContext: { mode: 'live' },
    initialSnapshot: snapshot,
    events: [],
    activeSnapshot: snapshot,
    metrics: {
      handsDealt: 1,
      potsAwarded: 0,
      averagePot: 0,
      avgIntentLatencyMs: 0,
      maxIntentLatencyMs: 0,
      timeoutsHard: 0,
      recoveries: 0,
      simulationsRun: 0,
      advisoryEquityRequests: 0,
    },
    channels: {
      realtime: 'test',
      analytics: {
        provider: 'noop',
        streamId: 'test',
        batching: { maxBatch: 1, flushMs: 1 },
      },
      replay: { transport: 'filesystem', retentionHands: 10 },
      advisory: {
        requestTopic: 'request',
        responseTopic: 'response',
        timeoutMs: 1_000,
      },
    },
    hooks: {},
  } satisfies Session;
}

const BASE_RULE_SET: SessionConfig['ruleSet'] = {
  streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
  postingOrder: ['small-blind', 'big-blind'],
  minRaisePolicy: 'double-last-bet',
  cardDistribution: {
    holeCardsPerPlayer: 2,
    burnPerStreet: [0, 1, 1],
    communityReveal: [0, 3, 1, 1],
  },
  showdownOrdering: 'high-card',
};

const FIXED_LIMIT_CONFIG: SessionConfig = {
  tableVariant: 'texas-holdem',
  bettingStructure: 'fixed-limit',
  maxSeats: 2,
  startingStack: 100,
  blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
  antePolicy: undefined,
  personaPolicy: { defaultStyle: 'balanced' },
  ruleSet: {
    ...BASE_RULE_SET,
    minRaisePolicy: 'fixed-increment',
    maxRaisePolicy: 'all-in',
  },
  evaluationPolicy: {
    engine: 'lookup-table',
    evaluatorId: 'default',
    supportsHiLo: false,
    cacheSize: 1_024,
  },
  simulationPolicy: undefined,
  autoAdvance: true,
};

const POT_LIMIT_CONFIG: SessionConfig = {
  ...FIXED_LIMIT_CONFIG,
  bettingStructure: 'pot-limit',
  ruleSet: {
    ...BASE_RULE_SET,
    minRaisePolicy: 'double-last-bet',
    maxRaisePolicy: 'pot',
  },
};

const NO_LIMIT_WITH_POT_CAP_CONFIG: SessionConfig = {
  ...POT_LIMIT_CONFIG,
  bettingStructure: 'no-limit',
};

describe('batch U3 – validation & reduction pipeline', () => {
  test('validator exposes legal options with accurate min-raise math', () => {
    const base = createTableSnapshot();
    const bettingEvent: TurnEvent = {
      id: 'turn-big-blind',
      actor: 'player-b',
      action: { type: 'bet', amount: 20 },
      legalOptions: [],
      stackBefore: 100,
      stackAfter: 80,
      contribution: 20,
      timestamp: Date.now(),
      metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
    };

    const snapshot = withRoundState(
      base,
      {
        turns: [bettingEvent],
        roundPot: 20,
        highestBet: 20,
        lastAggressor: 'player-b',
      },
      {
        seatStacks: { 'player-b': 80, 'player-a': 100 },
        potAmount: 20,
        contributions: { 'player-b': 20, 'player-a': 0 },
        currentActor: 'player-a',
      },
    );

    const intent = createTurnIntent({
      actor: 'player-a',
      requested: { type: 'call', amount: 20 },
      expectedSnapshotVersion: snapshot.index,
    });

    const validation = validateIntent(snapshot, intent);
    expect(validation.kind).toBe('accepted');
    if (validation.kind !== 'accepted') return;

    const legalOptions = validation.event.legalOptions;
    const raiseOption = legalOptions.find((option) => option.type === 'raise');
    if (!raiseOption || raiseOption.type !== 'raise') {
      throw new Error('expected raise option to be available');
    }
    assert.strictEqual(raiseOption.min, 40);

    const callOption = legalOptions.find((option) => option.type === 'call');
    if (!callOption || callOption.type !== 'call') {
      throw new Error('expected call option to be available');
    }
    assert.strictEqual(callOption.amount, 20);

    const allIn = legalOptions.find((option) => option.type === 'all-in');
    if (!allIn || allIn.type !== 'all-in') {
      throw new Error('expected all-in option to be available');
    }
    assert.strictEqual(allIn.amount, 100);
  });

  test('decision context effective stack ignores all-in players', () => {
    const baseSnapshot = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 1 },
        { id: 'player-b', stack: 0 },
        { id: 'player-c', stack: 5 },
      ],
      handStage: 'preflop',
      buttonIndex: 0,
    });

    const snapshot: TableSnapshot = {
      ...baseSnapshot,
      clock: { ...baseSnapshot.clock, currentActor: 'player-a' },
      seating: {
        ...baseSnapshot.seating,
        seats: baseSnapshot.seating.seats.map((seat) => {
          const playerId = seat.occupant?.playerId;
          if (playerId === 'player-a') {
            return { ...seat, stack: 1 };
          }
          if (playerId === 'player-b') {
            return { ...seat, stack: 0 };
          }
          if (playerId === 'player-c') {
            return { ...seat, stack: 5 };
          }
          return seat;
        }),
      },
    };

    const session = buildSessionFromSnapshot(
      snapshot,
      NO_LIMIT_WITH_POT_CAP_CONFIG,
    );
    const decision = selectDecisionContext(session);

    expect(decision.actor).toBe('player-a');
    expect(decision.effectiveStack).toBe(1);
  });

  test('short stack facing shove cannot raise beyond stack cap', () => {
    const base = createTableSnapshot({
      players: [
        { id: 'bob', stack: 99 },
        { id: 'alice', stack: 98 },
      ],
    });

    const turns: TurnEvent[] = [
      {
        id: 'sb-call',
        actor: 'bob',
        action: { type: 'call', amount: 2 },
        legalOptions: [],
        stackBefore: 99,
        stackAfter: 97,
        contribution: 2,
        timestamp: Date.now(),
        metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
      },
      {
        id: 'bb-raise',
        actor: 'alice',
        action: { type: 'raise', amount: 4, to: 4 },
        legalOptions: [],
        stackBefore: 98,
        stackAfter: 94,
        contribution: 4,
        timestamp: Date.now(),
        metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
      },
      {
        id: 'sb-reraise',
        actor: 'bob',
        action: { type: 'raise', amount: 6, to: 8 },
        legalOptions: [],
        stackBefore: 97,
        stackAfter: 91,
        contribution: 6,
        timestamp: Date.now(),
        metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
      },
      {
        id: 'bb-shove',
        actor: 'alice',
        action: { type: 'all-in', amount: 98, from: 'raise' },
        legalOptions: [],
        stackBefore: 94,
        stackAfter: 0,
        contribution: 94,
        timestamp: Date.now(),
        metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
      },
    ];

    const snapshot = withRoundState(
      base,
      {
        turns,
        roundPot: 106,
        highestBet: 98,
        lastAggressor: 'alice',
      },
      {
        seatStacks: { bob: 91, alice: 0 },
        potAmount: 106,
        contributions: { bob: 8, alice: 98 },
        currentActor: 'bob',
      },
    );

    const options = deriveLegalOptionsForActor(snapshot, 'bob');

    const raiseOption = options.find((option) => option.type === 'raise');
    expect(raiseOption).toBeUndefined();

    const callOption = options.find((option) => option.type === 'call');
    if (!callOption || callOption.type !== 'call') {
      throw new Error('expected call option to be available for short stack');
    }
    expect(callOption.amount).toBe(90);

    const allInOption = options.find((option) => option.type === 'all-in');
    if (!allInOption || allInOption.type !== 'all-in') {
      throw new Error('expected all-in option to be available for short stack');
    }
    expect(allInOption.amount).toBe(99);
  });

  test('illegal requests are rejected with misclick recovery guidance', () => {
    const base = createTableSnapshot();
    const round = base.hand.bettingRounds[0]!;
    const bettingEvent: TurnEvent = {
      id: 'turn-bet',
      actor: 'player-b',
      action: { type: 'bet', amount: 20 },
      legalOptions: [],
      stackBefore: 100,
      stackAfter: 80,
      contribution: 20,
      timestamp: Date.now(),
      metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
    };

    const snapshot = withRoundState(
      base,
      {
        ...round,
        turns: [bettingEvent],
        roundPot: 20,
        highestBet: 20,
        lastAggressor: 'player-b',
      },
      {
        seatStacks: { 'player-b': 80, 'player-a': 100 },
        potAmount: 20,
        contributions: { 'player-b': 20, 'player-a': 0 },
        currentActor: 'player-a',
      },
    );

    const intent = createTurnIntent({
      actor: 'player-a',
      requested: { type: 'raise', amount: 25 },
      expectedSnapshotVersion: snapshot.index,
    });

    const validation = validateIntent(snapshot, intent);

    expect(validation.kind).toBe('rejected');
    if (validation.kind !== 'rejected') return;
    expect(validation.reason).toBe('illegal-action');
    expect(validation.recovery?.advise).toBe('retry');
  });

  test('reducer preserves event immutability and ordering', () => {
    const snapshot = createTableSnapshot();
    const intent = createTurnIntent({
      actor: 'player-a',
      requested: { type: 'bet', amount: 15 },
      expectedSnapshotVersion: snapshot.index,
    });

    const validation = validateIntent(snapshot, intent);
    expect(validation.kind).toBe('accepted');
    if (validation.kind !== 'accepted') return;

    const eventBefore = JSON.parse(JSON.stringify(validation.event));
    const updated = reduce(snapshot, validation.event);

    assert.deepStrictEqual(validation.event, eventBefore);
    const round = updated.hand.bettingRounds[0]!;
    const lastTurn = round.turns[round.turns.length - 1];
    expect(lastTurn).toBe(validation.event);
    expect(snapshot.hand.bettingRounds[0]?.turns.length).toBe(0);
  });

  test('stack and pot deltas reconcile after accepted actions', () => {
    const snapshot = createTableSnapshot();
    const intent = createTurnIntent({
      actor: 'player-a',
      requested: { type: 'bet', amount: 15 },
      expectedSnapshotVersion: snapshot.index,
    });

    const validation = validateIntent(snapshot, intent);
    expect(validation.kind).toBe('accepted');
    if (validation.kind !== 'accepted') return;

    const originalSeat = snapshot.seating.seats[0]!;
    expect(validation.event.stackBefore).toBe(originalSeat.stack);
    expect(validation.event.stackAfter).toBe(
      validation.event.stackBefore - validation.event.contribution,
    );

    const updated = reduce(snapshot, validation.event);
    const updatedSeat = updated.seating.seats[0]!;
    expect(updatedSeat.stack).toBe(
      originalSeat.stack - validation.event.contribution,
    );
    expect(updated.pots.main.amount).toBe(
      snapshot.pots.main.amount + validation.event.contribution,
    );
    expect(updated.pots.main.contributions['player-a']).toBe(
      validation.event.contribution,
    );
  });

  test('round state advances turn order and aggressor tracking', () => {
    const base = createTableSnapshot();
    const snapshot = withRoundState(
      base,
      {
        turnOrder: [0, 1],
        turns: [],
        roundPot: 0,
        highestBet: 0,
      },
      { currentActor: 'player-a' },
    );

    const intent = createTurnIntent({
      actor: 'player-a',
      requested: { type: 'raise', amount: 12 },
      expectedSnapshotVersion: snapshot.index,
    });

    const validation = validateIntent(snapshot, intent);
    expect(validation.kind).toBe('accepted');
    if (validation.kind !== 'accepted') return;

    const updated = reduce(snapshot, validation.event);
    const round = updated.hand.bettingRounds[0]!;
    expect(round.lastAggressor).toBe('player-a');
    expect(round.roundPot).toBe(validation.event.contribution);
    expect(round.highestBet).toBe(validation.event.contribution);
    expect(updated.clock.currentActor).toBe('player-b');
  });

  test('pot contribution ledger accumulates across sequential turns', () => {
    const base = createTableSnapshot();
    const openingIntent = createTurnIntent({
      actor: 'player-a',
      requested: { type: 'bet', amount: 10 },
      expectedSnapshotVersion: base.index,
    });

    const openingValidation = validateIntent(base, openingIntent);
    expect(openingValidation.kind).toBe('accepted');
    if (openingValidation.kind !== 'accepted') return;

    const afterFirst = reduce(base, openingValidation.event);

    const callIntent = createTurnIntent({
      actor: 'player-b',
      requested: { type: 'call', amount: 10 },
      expectedSnapshotVersion: afterFirst.index,
    });

    const callValidation = validateIntent(afterFirst, callIntent);
    expect(callValidation.kind).toBe('accepted');
    if (callValidation.kind !== 'accepted') return;

    const afterSecond = reduce(afterFirst, callValidation.event);

    expect(afterSecond.pots.main.amount).toBe(20);
    expect(afterSecond.pots.main.contributions['player-a']).toBe(10);
    expect(afterSecond.pots.main.contributions['player-b']).toBe(10);
    expect(afterSecond.hand.bettingRounds[0]?.roundPot).toBe(20);
  });

  test('fixed-limit structure enforces bet sizing and raise cap', () => {
    const base = createTableSnapshot();
    const openingOptions = deriveLegalOptionsForActor(base, 'player-a', {
      sessionConfig: FIXED_LIMIT_CONFIG,
    });

    const betOption = openingOptions.find((option) => option.type === 'bet');
    if (!betOption || betOption.type !== 'bet') {
      throw new Error('expected bet option in fixed-limit opener');
    }
    expect(betOption.min).toBe(2);
    expect(betOption.max).toBe(2);
    expect(betOption.increment).toBe(2);

    const turnStage = createTableSnapshot({ handStage: 'turn' });
    const turnOptions = deriveLegalOptionsForActor(turnStage, 'player-a', {
      sessionConfig: FIXED_LIMIT_CONFIG,
    });
    const turnBet = turnOptions.find((option) => option.type === 'bet');
    if (!turnBet || turnBet.type !== 'bet') {
      throw new Error('expected bet option on turn stage');
    }
    expect(turnBet.min).toBe(4);
    expect(turnBet.max).toBe(4);
    expect(turnBet.increment).toBe(4);

    const raises: TurnEvent[] = [
      {
        id: 'bet-1',
        actor: 'player-a',
        action: { type: 'bet', amount: 2 },
        legalOptions: [],
        stackBefore: 100,
        stackAfter: 98,
        contribution: 2,
        timestamp: Date.now(),
        metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
      },
      {
        id: 'raise-1',
        actor: 'player-b',
        action: { type: 'raise', amount: 4 },
        legalOptions: [],
        stackBefore: 100,
        stackAfter: 96,
        contribution: 4,
        timestamp: Date.now(),
        metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
      },
      {
        id: 'raise-2',
        actor: 'player-a',
        action: { type: 'raise', amount: 6 },
        legalOptions: [],
        stackBefore: 98,
        stackAfter: 94,
        contribution: 4,
        timestamp: Date.now(),
        metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
      },
      {
        id: 'raise-3',
        actor: 'player-b',
        action: { type: 'raise', amount: 8 },
        legalOptions: [],
        stackBefore: 96,
        stackAfter: 92,
        contribution: 4,
        timestamp: Date.now(),
        metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
      },
    ];

    const capped = withRoundState(
      base,
      {
        turns: raises,
        roundPot: 14,
        highestBet: 8,
        lastAggressor: 'player-b',
      },
      {
        seatStacks: { 'player-a': 94, 'player-b': 92 },
        potAmount: 14,
        contributions: { 'player-a': 6, 'player-b': 8 },
        currentActor: 'player-a',
      },
    );

    const cappedOptions = deriveLegalOptionsForActor(capped, 'player-a', {
      sessionConfig: FIXED_LIMIT_CONFIG,
    });

    expect(cappedOptions.some((option) => option.type === 'raise')).toBe(false);

    const callOption = cappedOptions.find((option) => option.type === 'call');
    if (!callOption || callOption.type !== 'call') {
      throw new Error('expected call option when raise cap reached');
    }
    expect(callOption.amount).toBe(2);

    const illegalRaise = createTurnIntent({
      actor: 'player-a',
      requested: { type: 'raise', amount: 10 },
      expectedSnapshotVersion: capped.index,
    });

    const rejection = validateIntent(capped, illegalRaise, {
      config: createValidationConfig(capped, FIXED_LIMIT_CONFIG),
    });

    expect(rejection.kind).toBe('rejected');
  });

  test('override big blind influences fixed-limit increments', () => {
    const base = createTableSnapshot();
    const openingOptions = deriveLegalOptionsForActor(base, 'player-a', {
      sessionConfig: FIXED_LIMIT_CONFIG,
      overrides: { bigBlind: 10 },
    });

    const betOption = openingOptions.find((option) => option.type === 'bet');
    if (!betOption || betOption.type !== 'bet') {
      throw new Error('expected bet option with override big blind');
    }

    expect(betOption.min).toBe(10);
    expect(betOption.max).toBe(10);
    expect(betOption.increment).toBe(10);
  });

  test('pot-limit structure clamps maximum raise to the pot', () => {
    const base = createTableSnapshot();
    const potEvent: TurnEvent = {
      id: 'bet-pot',
      actor: 'player-b',
      action: { type: 'bet', amount: 20 },
      legalOptions: [],
      stackBefore: 100,
      stackAfter: 80,
      contribution: 20,
      timestamp: Date.now(),
      metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
    };

    const facingPot = withRoundState(
      base,
      {
        turns: [potEvent],
        roundPot: 20,
        highestBet: 20,
        lastAggressor: 'player-b',
      },
      {
        seatStacks: { 'player-b': 80, 'player-a': 100 },
        potAmount: 20,
        contributions: { 'player-b': 20, 'player-a': 0 },
        currentActor: 'player-a',
      },
    );

    const options = deriveLegalOptionsForActor(facingPot, 'player-a', {
      sessionConfig: POT_LIMIT_CONFIG,
    });

    const raiseOption = options.find((option) => option.type === 'raise');
    if (!raiseOption || raiseOption.type !== 'raise') {
      throw new Error('expected raise option under pot-limit');
    }
    expect(raiseOption.min).toBe(40);
    expect(raiseOption.max).toBe(60);
  });

  test('pot-limit open bet caps the window to the current pot', () => {
    const base = createTableSnapshot();
    const snapshot = withRoundState(
      base,
      {
        turns: [],
        roundPot: 0,
        highestBet: 0,
        lastAggressor: undefined,
      },
      {
        seatStacks: { 'player-a': 200, 'player-b': 150 },
        potAmount: 45,
        contributions: { 'player-a': 0, 'player-b': 0 },
        currentActor: 'player-a',
      },
    );

    const options = deriveLegalOptionsForActor(snapshot, 'player-a', {
      sessionConfig: POT_LIMIT_CONFIG,
    });

    const betOption = options.find((option) => option.type === 'bet');
    if (!betOption || betOption.type !== 'bet') {
      throw new Error('expected bet option under pot-limit');
    }

    expect(betOption.min).toBe(2);
    expect(betOption.max).toBe(45);
  });

  test('pot-limit raise window clips to the stack cap for short stacks', () => {
    const base = createTableSnapshot();
    const potEvent: TurnEvent = {
      id: 'bet-pot-short',
      actor: 'player-b',
      action: { type: 'bet', amount: 20 },
      legalOptions: [],
      stackBefore: 100,
      stackAfter: 80,
      contribution: 20,
      timestamp: Date.now(),
      metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
    };

    const facingShort = withRoundState(
      base,
      {
        turns: [potEvent],
        roundPot: 20,
        highestBet: 20,
        lastAggressor: 'player-b',
      },
      {
        seatStacks: { 'player-b': 80, 'player-a': 35 },
        potAmount: 20,
        contributions: { 'player-b': 20, 'player-a': 0 },
        currentActor: 'player-a',
      },
    );

    const options = deriveLegalOptionsForActor(facingShort, 'player-a', {
      sessionConfig: POT_LIMIT_CONFIG,
    });

    const raiseOption = options.find((option) => option.type === 'raise');
    if (!raiseOption || raiseOption.type !== 'raise') {
      throw new Error('expected raise option under pot-limit');
    }

    expect(raiseOption.min).toBe(35);
    expect(raiseOption.max).toBe(35);

    const allInOption = options.find((option) => option.type === 'all-in');
    if (!allInOption || allInOption.type !== 'all-in') {
      throw new Error('expected all-in option for short stack');
    }
    expect(allInOption.amount).toBe(35);
  });

  test('covering player receives no options when all opponents are all-in', () => {
    const base = createTableSnapshot({
      players: [
        { id: 'player-a', stack: 250 },
        { id: 'player-b', stack: 100 },
        { id: 'player-c', stack: 100 },
      ],
    });

    const timestamp = 1_000;

    const turns: TurnEvent[] = [
      {
        id: 'player-b-all-in',
        actor: 'player-b',
        action: { type: 'all-in', amount: 100, from: 'bet' },
        legalOptions: [],
        stackBefore: 100,
        stackAfter: 0,
        contribution: 100,
        timestamp,
        metadata: { engineVersion: 'test', availableActionsAtDecision: [] },
      },
      {
        id: 'player-c-all-in',
        actor: 'player-c',
        action: { type: 'all-in', amount: 100, from: 'call' },
        legalOptions: [],
        stackBefore: 100,
        stackAfter: 0,
        contribution: 100,
        timestamp,
        metadata: { engineVersion: 'test', availableActionsAtDecision: [] },
      },
      {
        id: 'player-a-call',
        actor: 'player-a',
        action: { type: 'call', amount: 100, isAllIn: false },
        legalOptions: [],
        stackBefore: 250,
        stackAfter: 150,
        contribution: 100,
        timestamp,
        metadata: { engineVersion: 'test', availableActionsAtDecision: [] },
      },
    ];

    const snapshot = withRoundState(
      base,
      {
        turns,
        roundPot: 300,
        highestBet: 100,
        lastAggressor: 'player-b',
      },
      {
        seatStacks: { 'player-a': 150, 'player-b': 0, 'player-c': 0 },
        potAmount: 300,
        contributions: { 'player-a': 100, 'player-b': 100, 'player-c': 100 },
        currentActor: 'player-a',
      },
    );

    const options = deriveLegalOptionsForActor(snapshot, 'player-a', {
      sessionConfig: NO_LIMIT_WITH_POT_CAP_CONFIG,
    });

    expect(options).toHaveLength(0);
  });

  test('pot-limit ceiling still holds when prior raises inflate the minimum', () => {
    const base = createTableSnapshot();
    const openingRaise: TurnEvent = {
      id: 'raise-first',
      actor: 'player-a',
      action: { type: 'bet', amount: 30 },
      legalOptions: [],
      stackBefore: 100,
      stackAfter: 70,
      contribution: 30,
      timestamp: Date.now(),
      metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
    };
    const massiveRaise: TurnEvent = {
      id: 'raise-pot',
      actor: 'player-b',
      action: { type: 'raise', amount: 120 },
      legalOptions: [],
      stackBefore: 200,
      stackAfter: 80,
      contribution: 120,
      timestamp: Date.now(),
      metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
    };

    const inflated = withRoundState(
      base,
      {
        turns: [openingRaise, massiveRaise],
        roundPot: 150,
        highestBet: 120,
        lastAggressor: 'player-b',
      },
      {
        seatStacks: { 'player-a': 400, 'player-b': 80 },
        potAmount: 150,
        contributions: { 'player-a': 30, 'player-b': 120 },
        currentActor: 'player-a',
      },
    );

    const options = deriveLegalOptionsForActor(inflated, 'player-a', {
      sessionConfig: POT_LIMIT_CONFIG,
    });

    const raiseOption = options.find((option) => option.type === 'raise');
    if (!raiseOption || raiseOption.type !== 'raise') {
      throw new Error('expected raise option after large prior raise');
    }

    expect(raiseOption.min).toBe(210);
    expect(raiseOption.max).toBe(360);
  });

  test('rule-set max policy caps raises inside nominal no-limit config', () => {
    const base = createTableSnapshot();
    const potEvent: TurnEvent = {
      id: 'rule-pot',
      actor: 'player-b',
      action: { type: 'bet', amount: 20 },
      legalOptions: [],
      stackBefore: 100,
      stackAfter: 80,
      contribution: 20,
      timestamp: Date.now(),
      metadata: { engineVersion: 'v1', availableActionsAtDecision: [] },
    };

    const facingPot = withRoundState(
      base,
      {
        turns: [potEvent],
        roundPot: 20,
        highestBet: 20,
        lastAggressor: 'player-b',
      },
      {
        seatStacks: { 'player-b': 80, 'player-a': 100 },
        potAmount: 20,
        contributions: { 'player-b': 20, 'player-a': 0 },
        currentActor: 'player-a',
      },
    );

    const options = deriveLegalOptionsForActor(facingPot, 'player-a', {
      sessionConfig: NO_LIMIT_WITH_POT_CAP_CONFIG,
    });

    const raiseOption = options.find((option) => option.type === 'raise');
    if (!raiseOption || raiseOption.type !== 'raise') {
      throw new Error('expected raise option under capped no-limit');
    }
    expect(raiseOption.min).toBe(40);
    expect(raiseOption.max).toBe(60);

    const oversized = createTurnIntent({
      actor: 'player-a',
      requested: { type: 'raise', amount: 80 },
      expectedSnapshotVersion: facingPot.index,
    });

    const validation = validateIntent(facingPot, oversized, {
      config: createValidationConfig(facingPot, NO_LIMIT_WITH_POT_CAP_CONFIG),
    });
    expect(validation.kind).toBe('rejected');
  });

  test('rake ledger remains untouched when no deductions apply', () => {
    const snapshot = createTableSnapshot();
    const intent = createTurnIntent({
      actor: 'player-a',
      requested: { type: 'bet', amount: 5 },
      expectedSnapshotVersion: snapshot.index,
    });

    const validation = validateIntent(snapshot, intent);
    expect(validation.kind).toBe('accepted');
    if (validation.kind !== 'accepted') return;

    const updated = reduce(snapshot, validation.event);
    expect(updated.pots.rake).toBe(snapshot.pots.rake);
  });
});
