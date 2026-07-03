import { describe, expect, it } from 'vitest';

import { DEFAULT_RANDOM_STATE_SEATS } from '../simulation/random-state-defaults';
import {
  createSeededRandom,
  runHeadlessRandomState,
} from './random-state-headless-runner';

describe('runHeadlessRandomState', () => {
  it('runs a deterministic sequence when using the first-legal decision mode', async () => {
    const rng = createSeededRandom(42);
    const result = await runHeadlessRandomState({
      seatCount: 4,
      steps: 5,
      decisionMode: 'first-legal',
      random: rng,
    });

    const appliedSteps = result.log
      .slice(1)
      .filter((entry) => entry.summary.stepsApplied > 0);

    expect(appliedSteps.length).toBeGreaterThan(0);
    expect(appliedSteps.length).toBeLessThanOrEqual(5);
    expect(result.log[0]?.kind).toBe('generate');
    expect(result.final.session.events.length).toBeGreaterThanOrEqual(
      result.initial.session.events.length,
    );

    const firstApply = result.log.find(
      (entry): entry is Extract<typeof entry, { kind: 'apply' }> =>
        entry.kind === 'apply',
    );

    if (!firstApply) {
      throw new Error('Expected at least one apply action in the log.');
    }

    expect(firstApply.availableOptions[0]).toEqual(firstApply.option);
  });

  it('clamps the seat count within the supported range', async () => {
    const result = await runHeadlessRandomState({
      seatCount: 12,
      steps: 0,
      random: createSeededRandom(7),
    });

    const occupied = result.initial.session.activeSnapshot.seating.seats.filter(
      (seat) => seat.status === 'occupied' && Boolean(seat.occupant),
    );

    expect(occupied.length).toBeGreaterThanOrEqual(2);
    expect(occupied.length).toBeLessThanOrEqual(
      DEFAULT_RANDOM_STATE_SEATS.length,
    );
  });

  it('logs advance actions when no legal decision exists', async () => {
    let attempt = 0;
    let result: Awaited<ReturnType<typeof runHeadlessRandomState>> | null =
      null;

    while (attempt < 20) {
      const candidate = await runHeadlessRandomState({
        steps: 8,
        decisionMode: 'policy',
        random: createSeededRandom(200 + attempt),
        stepRange: { min: 2, max: 4 },
      });

      result = candidate;
      if (candidate.log.some((entry) => entry.kind === 'advance')) {
        break;
      }

      attempt += 1;
    }

    if (!result) {
      throw new Error('Headless run did not produce a result.');
    }

    expect(result.log.some((entry) => entry.kind === 'advance')).toBe(true);
  });

  it('settles showdowns produced during headless runs', async () => {
    const rng = createSeededRandom(12345);
    const result = await runHeadlessRandomState({
      seatCount: 4,
      steps: 20,
      decisionMode: 'uniform',
      random: rng,
    });

    const hand = result.final.session.activeSnapshot.hand;
    expect(hand.stage).toBe('settled');
    expect(hand.payouts?.entries.length).toBeGreaterThan(0);
  });

  it('burns exactly one card before revealing the flop during headless runs', async () => {
    type HeadlessAction = Awaited<
      ReturnType<typeof runHeadlessRandomState>
    >['log'][number];

    let attempt = 0;
    let captured: HeadlessAction | null = null;

    while (attempt < 25 && !captured) {
      const candidate = await runHeadlessRandomState({
        seatCount: 6,
        steps: 20,
        decisionMode: 'uniform',
        random: createSeededRandom(100 + attempt),
      });

      const entry = candidate.log.find((action) =>
        action.summary.session.activeSnapshot.cards.community.revealSchedule.some(
          (event) => event.stage === 'flop' && event.reason === 'burn',
        ),
      );

      if (entry) {
        captured = entry;
      }

      attempt += 1;
    }

    if (!captured) {
      throw new Error('Expected headless run to include a flop burn event.');
    }

    const burnEvents =
      captured.summary.session.activeSnapshot.cards.community.revealSchedule.filter(
        (event) => event.stage === 'flop' && event.reason === 'burn',
      );

    expect(burnEvents.length).toBeGreaterThan(0);
    expect(burnEvents[0]?.cards).toHaveLength(1);
    expect(
      captured.summary.session.activeSnapshot.cards.burnPile.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('halts advances once the session stops applying steps', async () => {
    const result = await runHeadlessRandomState({
      seatCount: 3,
      steps: 30,
      decisionMode: 'policy',
      random: createSeededRandom(42),
    });

    const zeroStepAdvances = result.log.filter(
      (entry): entry is Extract<typeof entry, { kind: 'advance' }> =>
        entry.kind === 'advance' && entry.summary.stepsApplied === 0,
    );

    expect(zeroStepAdvances.length).toBe(1);
    expect(result.log.at(-1)?.summary.stepsApplied).toBe(0);
  });
});
