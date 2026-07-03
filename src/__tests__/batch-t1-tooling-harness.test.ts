import { describe, expect, test } from 'vitest';

import {
  SessionManager,
  createSessionStore,
  createTableSnapshot,
  createTestLogger,
} from '..';
import {
  createFixture,
  listSnapshotFixtures,
  loadFixture,
  readSnapshotFixture,
  readSummaryFixture,
} from '../testing/fixtures';
import type { Session, SessionConfig } from '../types/session';

function createTestSession(id: string): Session {
  const config = createConfig();

  const seats = [
    { playerId: 'player-a', displayName: 'Player A', stack: 100 },
    { playerId: 'player-b', displayName: 'Player B', stack: 100 },
  ] as const;

  const manager = SessionManager.create(config, seats, {
    idFactory: () => id,
    sessionId: id,
  });

  return manager.session;
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
        burnPerStreet: [0, 1, 1],
        communityReveal: [0, 3, 1, 1],
      },
      showdownOrdering: 'high-card',
    },
    evaluationPolicy: {
      engine: 'lookup-table',
      evaluatorId: 'baseline',
      supportsHiLo: false,
      cacheSize: 1024,
    },
    autoAdvance: true,
  } satisfies SessionConfig;
}

describe('@batch(T1) tooling harness smoke tests', () => {
  test('fixture serialization preserves snapshot parity and freezes payloads', () => {
    const snapshot = createTableSnapshot({
      handId: 'hand-fixture',
      players: [
        { id: 'player-a', stack: 200 },
        { id: 'player-b', stack: 160 },
      ],
    });

    const fixture = createFixture(
      {
        id: 'fixture:heads-up:baseline',
        description: 'Heads-up preflop baseline snapshot',
        origin: 'batch-t1-tooling-harness',
      },
      snapshot,
    );

    const serialized = JSON.stringify(fixture);
    const parsed = JSON.parse(serialized) as typeof fixture;
    const revived = loadFixture(parsed);

    const expected = structuredClone(snapshot);
    delete (expected.clock as { deadline?: number }).deadline;

    expect(revived.payload).toStrictEqual(expected);
    expect(Object.isFrozen(revived.payload)).toBe(true);
    expect(() => {
      (revived.payload as { index: number }).index = 99;
    }).toThrow(TypeError);
  });

  test('session store resets between runs and protects stored sessions', () => {
    const first = createTestSession('session-1');
    const second = createTestSession('session-2');

    const store = createSessionStore([first]);
    expect(store.listSessions()).toHaveLength(1);

    const storedFirst = store.getSession(first.id);
    expect(storedFirst).toBeDefined();
    expect(storedFirst).not.toBe(first);
    expect(Object.isFrozen(storedFirst)).toBe(true);

    store.saveSession(second);
    expect(store.listSessions()).toHaveLength(2);

    const storedSecond = store.getSession(second.id);
    expect(storedSecond).toBeDefined();
    expect(Object.isFrozen(storedSecond)).toBe(true);

    expect(() => {
      (storedSecond as { metrics: { handsDealt: number } }).metrics.handsDealt =
        42;
    }).toThrow(TypeError);

    store.reset();
    expect(store.listSessions()).toHaveLength(0);
  });

  test('persisted snapshot fixtures load as immutable copies', () => {
    const fixture = readSnapshotFixture('heads-up-preflop-even-stacks');
    expect(fixture.id).toBe('heads-up-preflop-even-stacks');
    expect(fixture.description).toContain('Heads-up preflop');
    expect(Object.isFrozen(fixture.payload)).toBe(true);

    expect(() => {
      (fixture.payload as { index: number }).index = 99;
    }).toThrow(TypeError);
  });

  test('fixture directory enumeration surfaces metadata for CI linting', () => {
    const fixtures = listSnapshotFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      expect(fixture.id).toMatch(/^[-a-z0-9:]+$/);
      expect(fixture.description).not.toHaveLength(0);
    }
  });

  test('summary fixtures expose universal payloads', () => {
    const fixture = readSummaryFixture('heads-up-preflop-even-stacks');
    expect(fixture.origin).toBe('test-suite');
    expect(fixture.payload.stepsApplied).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(fixture.payload)).toBe(true);
    expect(Object.isFrozen(fixture.payload.session)).toBe(true);
    expect(Object.isFrozen(fixture.payload.session.activeSnapshot)).toBe(true);
  });

  test('structured logger captures immutable telemetry entries', () => {
    const logger = createTestLogger('tooling-harness');

    logger.info('validator accepted intent', { actor: 'player-a' });
    logger.warn('timer nearing deadline', { remainingMs: 2500 });

    const snapshot = logger.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]?.category).toBe('tooling-harness');
    expect(snapshot[0]?.severity).toBe('info');
    expect(snapshot[0]?.context).toEqual({ actor: 'player-a' });

    const flushed = logger.flush();
    expect(flushed).toHaveLength(2);
    expect(logger.snapshot()).toHaveLength(0);

    expect(() => {
      (flushed[0] as { severity: string }).severity = 'mutated';
    }).toThrow(TypeError);
  });
});
