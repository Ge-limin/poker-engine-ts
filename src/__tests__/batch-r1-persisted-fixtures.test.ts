import { describe, expect, test } from 'vitest';

import { SessionManager, selectDecisionContext } from '..';
import { type SummaryFixture, readSummaryFixture } from '../testing/fixtures';
import type { HandStage } from '../types/common';
import type { DecisionContextView } from '../types/derived';
import type { RandomStateSummary } from '../types/random-state';
import type { SessionConfig } from '../types/session';
import type { TableSnapshot } from '../types/snapshot';

interface ResumedFixture {
  readonly fixture: SummaryFixture;
  readonly summary: RandomStateSummary;
  readonly manager: SessionManager;
  readonly decision: DecisionContextView;
}

interface BoardExpectation {
  readonly flop?: number;
  readonly hasTurn?: boolean;
  readonly hasRiver?: boolean;
}

interface BaselineFixtureCase {
  readonly id: string;
  readonly expectedStage: HandStage;
  readonly expectedSeatCount: number;
  readonly expectAutoRunout: boolean;
  readonly expectedActor?: string;
  readonly expectedPlayersLeftToAct: readonly string[];
  readonly expectedActionTypes?: readonly string[];
  readonly expectNoActions?: boolean;
  readonly board?: BoardExpectation;
  readonly extra?: (
    snapshot: TableSnapshot,
    summary: RandomStateSummary,
    decision: DecisionContextView,
  ) => void;
}

interface ResumeOptions {
  readonly disableAutoAdvance?: boolean;
}

function resumeFixture(
  fixtureId: string,
  options: ResumeOptions = {},
): ResumedFixture {
  const fixture = readSummaryFixture(fixtureId);
  const summary = fixture.payload;
  const config: SessionConfig = options.disableAutoAdvance
    ? {
        ...structuredClone(summary.session.config),
        autoAdvance: false,
      }
    : summary.session.config;

  const manager = SessionManager.resume({
    sessionId: summary.session.id,
    config,
    runtimeContext: summary.session.runtimeContext,
    initialSnapshot: summary.session.initialSnapshot,
    events: summary.session.events,
    metrics: summary.session.metrics,
    channels: summary.session.channels,
  });

  const decision = selectDecisionContext(manager.session);
  expect(manager.session.events.length).toBe(summary.session.events.length);

  return { fixture, summary, manager, decision } satisfies ResumedFixture;
}

function countOccupiedSeats(snapshot: TableSnapshot): number {
  return snapshot.seating.seats.reduce(
    (count, seat) => (seat.status === 'occupied' ? count + 1 : count),
    0,
  );
}

function assertBoardState(
  snapshot: TableSnapshot,
  expectation?: BoardExpectation,
): void {
  if (!expectation) {
    return;
  }

  if (expectation.flop !== undefined) {
    const flop = snapshot.cards.community.flop;
    if (expectation.flop === 0) {
      expect(flop).toBeUndefined();
    } else {
      expect(flop).toBeDefined();
      expect(flop).toHaveLength(expectation.flop);
    }
  }

  if (expectation.hasTurn !== undefined) {
    const turn = snapshot.cards.community.turn;
    if (expectation.hasTurn) {
      expect(turn).toBeDefined();
    } else {
      expect(turn).toBeUndefined();
    }
  }

  if (expectation.hasRiver !== undefined) {
    const river = snapshot.cards.community.river;
    if (expectation.hasRiver) {
      expect(river).toBeDefined();
    } else {
      expect(river).toBeUndefined();
    }
  }
}

describe('@batch(R1) persisted fixture regression coverage', () => {
  test('headless auto settlement resumes to a settled payout state', () => {
    const { summary, manager, decision } = resumeFixture(
      'headless-auto-settlement',
    );

    const snapshot = manager.session.activeSnapshot;
    expect(snapshot.hand.stage).toBe('settled');
    expect(snapshot.flags.autoRunout).toBe(true);
    expect(countOccupiedSeats(snapshot)).toBe(4);
    expect(decision.playersLeftToAct).toHaveLength(0);

    const payouts = snapshot.hand.payouts;
    expect(payouts?.entries).toEqual(
      summary.session.activeSnapshot.hand.payouts?.entries,
    );
    expect(payouts?.entries ?? []).not.toHaveLength(0);
    expect(payouts?.entries?.[0]?.playerId).toBe('dave');

    expect(snapshot.flags.pendingEliminations).toContain('alice');
  });

  test('heads-up blind rotation persists through resume replay', () => {
    const { summary, manager, decision } = resumeFixture(
      'heads-up-button-small-blind',
      { disableAutoAdvance: true },
    );

    const snapshot = manager.session.activeSnapshot;
    expect(snapshot.hand.stage).toBe('preflop');
    expect(snapshot.hand.buttonSeat).toBe(snapshot.seating.dealerButton);
    expect(snapshot.hand.blinds.smallBlind.playerId).toBe('alice');
    expect(snapshot.hand.blinds.bigBlind.playerId).toBe('bob');
    expect(countOccupiedSeats(snapshot)).toBe(2);

    expect(decision.availableActions).toHaveLength(0);
    expect(decision.playersLeftToAct).toEqual([]);

    expect(snapshot.pots.main.eligiblePlayers).toEqual(['bob']);
    expect(snapshot.pots.main.contributions).toEqual(
      summary.session.activeSnapshot.pots.main.contributions,
    );
  });

  const baselineCases: BaselineFixtureCase[] = [
    {
      id: 'baseline_street-preflop-heads-up',
      expectedStage: 'preflop',
      expectedSeatCount: 2,
      expectAutoRunout: false,
      expectedActor: 'bob',
      expectedPlayersLeftToAct: [],
      expectedActionTypes: ['fold', 'all-in'],
      board: { flop: 0, hasTurn: false, hasRiver: false },
      extra: (snapshot, summary) => {
        expect(snapshot.hand.blinds.smallBlind.playerId).toBe('alice');
        expect(snapshot.hand.blinds.bigBlind.playerId).toBe('bob');
        expect(snapshot.pots.sides).toHaveLength(1);
        expect(snapshot.pots.sides[0]?.eligiblePlayers).toEqual(['alice']);
        expect(snapshot.pots.sides[0]?.amount).toBe(
          summary.session.activeSnapshot.pots.sides[0]?.amount,
        );
      },
    },
    {
      id: 'baseline_street-preflop-six-max',
      expectedStage: 'preflop',
      expectedSeatCount: 6,
      expectAutoRunout: false,
      expectedActor: 'erin',
      expectedPlayersLeftToAct: ['erin', 'frank'],
      expectedActionTypes: ['fold', 'call', 'all-in'],
      board: { flop: 0, hasTurn: false, hasRiver: false },
      extra: (snapshot) => {
        expect(snapshot.hand.blinds.smallBlind.playerId).toBe('bob');
        expect(snapshot.hand.blinds.bigBlind.playerId).toBe('carol');
        expect(snapshot.pots.main.eligiblePlayers).toEqual([
          'alice',
          'bob',
          'dave',
          'erin',
          'frank',
        ]);
      },
    },
    {
      id: 'baseline_street-flop-heads-up',
      expectedStage: 'settled',
      expectedSeatCount: 2,
      expectAutoRunout: true,
      expectedPlayersLeftToAct: [],
      expectNoActions: true,
      board: { flop: 3, hasTurn: true, hasRiver: true },
      extra: (snapshot) => {
        expect(snapshot.cards.community.flop).toEqual(['Kd', '4s', '5h']);
        expect(snapshot.cards.community.turn).toBe('Tc');
        expect(snapshot.cards.community.river).toBe('3d');
      },
    },
    {
      id: 'baseline_street-flop-six-max',
      expectedStage: 'settled',
      expectedSeatCount: 6,
      expectAutoRunout: true,
      expectedPlayersLeftToAct: [],
      expectNoActions: true,
      board: { flop: 3, hasTurn: true, hasRiver: true },
      extra: (snapshot) => {
        expect(snapshot.cards.community.flop).toEqual(['Qc', '3h', '2c']);
        expect(snapshot.cards.community.turn).toBe('5s');
        expect(snapshot.cards.community.river).toBe('4c');
      },
    },
    {
      id: 'baseline_street-turn-heads-up',
      expectedStage: 'settled',
      expectedSeatCount: 2,
      expectAutoRunout: true,
      expectedPlayersLeftToAct: [],
      expectNoActions: true,
      board: { flop: 3, hasTurn: true, hasRiver: true },
      extra: (snapshot) => {
        expect(snapshot.cards.community.flop).toEqual(['Th', '2s', 'As']);
        expect(snapshot.cards.community.turn).toBe('3c');
        expect(snapshot.cards.community.river).toBe('6c');
      },
    },
    {
      id: 'baseline_street-turn-six-max',
      expectedStage: 'settled',
      expectedSeatCount: 6,
      expectAutoRunout: true,
      expectedPlayersLeftToAct: [],
      expectNoActions: true,
      board: { flop: 3, hasTurn: true, hasRiver: true },
      extra: (snapshot) => {
        expect(snapshot.cards.community.flop).toEqual(['Tc', '3c', '9h']);
        expect(snapshot.cards.community.turn).toBe('Ks');
        expect(snapshot.cards.community.river).toBe('8d');
      },
    },
    {
      id: 'baseline_street-river-heads-up',
      expectedStage: 'settled',
      expectedSeatCount: 2,
      expectAutoRunout: true,
      expectedPlayersLeftToAct: [],
      expectNoActions: true,
      board: { flop: 3, hasTurn: true, hasRiver: true },
      extra: (snapshot) => {
        expect(snapshot.cards.community.flop).toEqual(['4d', '9s', '4c']);
        expect(snapshot.cards.community.turn).toBe('3d');
        expect(snapshot.cards.community.river).toBe('7c');
      },
    },
    {
      id: 'baseline_street-river-six-max',
      expectedStage: 'settled',
      expectedSeatCount: 6,
      expectAutoRunout: true,
      expectedPlayersLeftToAct: [],
      expectNoActions: true,
      board: { flop: 3, hasTurn: true, hasRiver: true },
      extra: (snapshot) => {
        expect(snapshot.cards.community.flop).toEqual(['Kd', '9h', '4s']);
        expect(snapshot.cards.community.turn).toBe('6c');
        expect(snapshot.cards.community.river).toBe('8c');
      },
    },
  ];

  for (const testCase of baselineCases) {
    test(`replays ${testCase.id} without drifting reducer state`, () => {
      const { summary, manager, decision } = resumeFixture(testCase.id);
      const snapshot = manager.session.activeSnapshot;

      expect(snapshot.hand.stage).toBe(testCase.expectedStage);
      expect(snapshot.flags.autoRunout).toBe(testCase.expectAutoRunout);
      expect(countOccupiedSeats(snapshot)).toBe(testCase.expectedSeatCount);
      expect(decision.playersLeftToAct).toEqual(
        testCase.expectedPlayersLeftToAct,
      );

      if (testCase.expectedActor) {
        expect(decision.actor).toBe(testCase.expectedActor);
      } else {
        expect(decision.actor).toBeUndefined();
      }

      if (testCase.expectedActionTypes) {
        expect(decision.availableActions.map((action) => action.type)).toEqual(
          testCase.expectedActionTypes,
        );
      }

      if (testCase.expectNoActions) {
        expect(decision.availableActions).toHaveLength(0);
      }

      assertBoardState(snapshot, testCase.board);

      testCase.extra?.(snapshot, summary, decision);
    });
  }
});
