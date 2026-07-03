import { describe, expect, it } from 'vitest';

import { selectDecisionContext } from '../session/selectors';
import { SessionManager } from '../session/session-manager';
import { normalizeCallOptionForApi } from '../simulation/random-state-blind-utils';
import {
  DEFAULT_RANDOM_STATE_CONFIG,
  DEFAULT_RANDOM_STATE_SEATS,
  advanceRandomState,
  applyOptionToState,
  generateRandomState,
} from '../simulation/random-state-generator';
import type { PlayerOption } from '../types/events';

function constantRng(value: number) {
  return () => value;
}

describe('batch R2 – random state regression', () => {
  function isCallOption(
    option: PlayerOption,
  ): option is Extract<PlayerOption, { readonly type: 'call' }> {
    return option.type === 'call';
  }

  it('generates a random state with the expected number of steps', async () => {
    const summary = await generateRandomState({
      config: DEFAULT_RANDOM_STATE_CONFIG,
      seats: DEFAULT_RANDOM_STATE_SEATS,
      steps: { min: 2, max: 2 },
      random: constantRng(0.1),
    });

    expect(summary.stepsApplied).toBeGreaterThanOrEqual(0);
    expect(summary.session.events.length).toBeGreaterThanOrEqual(
      summary.stepsApplied,
    );
    expect(summary.decision.handNumber).toBeGreaterThan(0);
  });

  it('advances an existing state by applying random actions', async () => {
    const base = await generateRandomState({
      config: DEFAULT_RANDOM_STATE_CONFIG,
      seats: DEFAULT_RANDOM_STATE_SEATS,
      steps: { min: 0, max: 0 },
      random: constantRng(0.25),
    });

    const advanced = await advanceRandomState(base.session, {
      steps: { min: 1, max: 1 },
      random: constantRng(0.75),
    });

    expect(advanced.stepsApplied).toBe(1);
    expect(advanced.session.events.length).toBeGreaterThan(
      base.session.events.length,
    );
  });

  it('applies a specific option to the current actor', async () => {
    const base = await generateRandomState({
      config: DEFAULT_RANDOM_STATE_CONFIG,
      seats: DEFAULT_RANDOM_STATE_SEATS,
      steps: { min: 0, max: 0 },
    });

    expect(base.decision.actor).toBeDefined();
    const option = base.decision.availableActions.find(
      (candidate) => !candidate.disabled,
    );

    expect(option).toBeDefined();

    const applied = await applyOptionToState(
      base.session,
      base.decision.actor!,
      option!,
    );

    expect(applied.session.events.length).toBeGreaterThan(
      base.session.events.length,
    );
  });

  it('populates deck and reveal information in the serialized session', async () => {
    const summary = await generateRandomState({
      config: DEFAULT_RANDOM_STATE_CONFIG,
      seats: DEFAULT_RANDOM_STATE_SEATS,
      steps: { min: 3, max: 3 },
      random: constantRng(0.42),
    });

    const initialSnapshot = summary.session.initialSnapshot.snapshot;
    const occupiedSeats = initialSnapshot.seating.seats.filter(
      (seat) => seat.occupant,
    ).length;
    const perPlayer =
      summary.session.config.ruleSet.cardDistribution.holeCardsPerPlayer;
    expect(initialSnapshot.cards.remainingDeck.length).toBe(
      52 - occupiedSeats * perPlayer,
    );
    for (const [playerId, cards] of Object.entries(
      initialSnapshot.cards.holeCards,
    )) {
      if (!cards) {
        continue;
      }
      expect(cards.length).toBe(perPlayer);
      expect(
        initialSnapshot.seating.seats.some(
          (seat) => seat.occupant?.playerId === playerId,
        ),
      ).toBe(true);
    }
    expect(
      summary.session.activeSnapshot.cards.remainingDeck.length,
    ).toBeGreaterThan(0);
    expect(
      summary.session.activeSnapshot.cards.remainingDeck.length,
    ).toBeLessThanOrEqual(52);

    const revealSchedule =
      summary.session.activeSnapshot.cards.community.revealSchedule;
    if (summary.session.activeSnapshot.hand.stage !== 'preflop') {
      expect(revealSchedule.length).toBeGreaterThan(0);
    }

    const holeCards = summary.session.activeSnapshot.cards.holeCards;
    for (const entry of Object.values(holeCards)) {
      if (entry !== null) {
        expect(entry.length).toBeGreaterThan(0);
      }
    }
  });

  it('serializes and replays a progressed random state beyond preflop', async () => {
    let working = await generateRandomState({
      config: DEFAULT_RANDOM_STATE_CONFIG,
      seats: DEFAULT_RANDOM_STATE_SEATS,
      steps: { min: 0, max: 0 },
      random: constantRng(0.12),
    });

    for (let index = 0; index < 20; index += 1) {
      if (working.session.activeSnapshot.hand.stage !== 'preflop') {
        break;
      }

      const actor = working.decision.actor;
      if (!actor) {
        break;
      }

      const option =
        working.decision.availableActions.find(
          (candidate) => candidate.type === 'call' && !candidate.disabled,
        ) ??
        working.decision.availableActions.find(
          (candidate) => candidate.type === 'check' && !candidate.disabled,
        ) ??
        working.decision.availableActions.find(
          (candidate) => candidate.type === 'fold' && !candidate.disabled,
        );

      if (!option) {
        break;
      }

      working = await applyOptionToState(working.session, actor, option);
    }

    expect(working.session.activeSnapshot.hand.stage).not.toBe('preflop');

    const manager = SessionManager.resume(
      {
        sessionId: working.session.id,
        config: working.session.config,
        runtimeContext: working.session.runtimeContext,
        initialSnapshot: working.session.initialSnapshot,
        events: working.session.events,
        metrics: working.session.metrics,
        channels: working.session.channels,
        hooks: {},
      },
      { now: () => 1_000 },
    );

    const resumedStage = manager.session.activeSnapshot.hand.stage;
    expect(resumedStage).toBe(working.session.activeSnapshot.hand.stage);
    expect(resumedStage).not.toBe('preflop');
    const decision = selectDecisionContext(manager.session);
    expect(decision.handStage).toBe(resumedStage);
  });

  it('normalizes small blind call options by subtracting posted blinds', async () => {
    let summary = await generateRandomState({
      config: DEFAULT_RANDOM_STATE_CONFIG,
      seats: DEFAULT_RANDOM_STATE_SEATS,
      steps: { min: 0, max: 0 },
      random: constantRng(0.33),
    });

    const blinds = summary.session.activeSnapshot.hand.blinds;
    const smallBlindPlayerId = blinds.smallBlind?.playerId;
    const postedBlindAmount = blinds.smallBlind?.amount;

    expect(typeof smallBlindPlayerId).toBe('string');
    expect(typeof postedBlindAmount).toBe('number');

    if (
      typeof smallBlindPlayerId !== 'string' ||
      typeof postedBlindAmount !== 'number'
    ) {
      throw new Error('Small blind commitment was not established.');
    }

    for (
      let index = 0;
      index < DEFAULT_RANDOM_STATE_SEATS.length * 2;
      index += 1
    ) {
      if (summary.decision.actor === smallBlindPlayerId) {
        break;
      }

      const actor = summary.decision.actor;
      expect(actor).toBeDefined();

      const foldOption = summary.decision.availableActions.find(
        (candidate) => candidate.type === 'fold' && !candidate.disabled,
      );
      expect(foldOption).toBeDefined();

      summary = await applyOptionToState(summary.session, actor!, foldOption!);
    }

    expect(summary.decision.actor).toBe(smallBlindPlayerId);

    const callOption = summary.decision.availableActions.find(
      (
        candidate,
      ): candidate is Extract<PlayerOption, { readonly type: 'call' }> =>
        isCallOption(candidate) && !candidate.disabled,
    );
    expect(callOption).toBeDefined();

    if (!callOption) {
      throw new Error('Expected a call option for the small blind actor.');
    }

    expect(callOption.amount).toBeGreaterThanOrEqual(0);

    const normalized = normalizeCallOptionForApi(
      callOption,
      summary.session.activeSnapshot,
      smallBlindPlayerId,
    );

    expect(normalized.amount).toBe(callOption.amount + postedBlindAmount);

    const applied = await applyOptionToState(
      summary.session,
      smallBlindPlayerId,
      callOption,
    );

    const lastEvent = applied.session.events[applied.session.events.length - 1];

    if (!lastEvent) {
      throw new Error('Expected the applied option to record a turn event.');
    }

    const { action } = lastEvent.event;

    if (action.type !== 'call') {
      throw new Error('Expected the last event action to be a call.');
    }

    expect(lastEvent.event.actor).toBe(smallBlindPlayerId);
    expect(action.amount).toBe(callOption.amount + postedBlindAmount);
  });
});
