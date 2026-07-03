import { describe, expect, test } from 'vitest';

import {
  SessionManager,
  advanceActionClock,
  replayEvents,
  selectDecisionContext,
  selectSimulationView,
  selectTelemetryEvent,
} from '..';
import { sumPotAmounts } from '../core/utils/snapshot';
import type { SeatBootstrapConfig } from '../session/lifecycle';
import type { PlayerOption, TurnIntent } from '../types/events';
import type { PersonaMatrix } from '../types/persona';
import type { SessionConfig } from '../types/session';

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
      evaluatorId: 'default',
      supportsHiLo: false,
      cacheSize: 1024,
    },
    autoAdvance: true,
  };
}

const seats: SeatBootstrapConfig[] = [
  { playerId: 'hero', seatIndex: 0, stack: 100 },
  { playerId: 'villain', seatIndex: 1, stack: 100 },
  { playerId: 'sidekick', seatIndex: 2, stack: 100 },
];

type Mutable<T> = {
  -readonly [P in keyof T]: Mutable<T[P]>;
};

function buildIntentFromOption(
  actor: string,
  option: PlayerOption,
  version: number,
  issuedAt: number,
): TurnIntent {
  switch (option.type) {
    case 'fold':
      return {
        id: `${actor}-fold`,
        actor,
        requested: { type: 'fold' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    case 'check':
      return {
        id: `${actor}-check`,
        actor,
        requested: { type: 'check' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    case 'call':
      return {
        id: `${actor}-call`,
        actor,
        requested: { type: 'call', amount: option.amount },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    case 'bet':
      return {
        id: `${actor}-bet`,
        actor,
        requested: { type: 'bet', amount: option.min },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    case 'raise':
      return {
        id: `${actor}-raise`,
        actor,
        requested: { type: 'raise', amount: option.min, to: option.min },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    case 'all-in':
      return {
        id: `${actor}-all-in`,
        actor,
        requested: { type: 'all-in', amount: option.amount, from: 'bet' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
    default:
      return {
        id: `${actor}-fallback-fold`,
        actor,
        requested: { type: 'fold' },
        issuedAt,
        origin: 'ui',
        expectedSnapshotVersion: version,
      };
  }
}

describe('@batch(I3) resilience & personas', () => {
  test('player timeout handling consumes bank and applies fallback fold', async () => {
    const manager = SessionManager.create(createConfig(), seats, {
      perTurnMs: 1_000,
    });
    const actor = manager.session.activeSnapshot.clock.currentActor ?? 'hero';
    const deadline = manager.session.activeSnapshot.clock.deadline ?? 0;

    const overtimeTimestamp = deadline + 15_000;
    const exhaustedClock = advanceActionClock(
      manager.session.activeSnapshot.clock,
      actor,
      overtimeTimestamp,
    );
    expect(exhaustedClock.exhausted).toBe(true);
    expect(exhaustedClock.usedBankMs).toBe(0);

    const timeoutIntent: TurnIntent = {
      id: 'timeout-1',
      actor,
      requested: { type: 'timeout', fallback: 'fold' },
      issuedAt: overtimeTimestamp,
      origin: 'ui',
      expectedSnapshotVersion: manager.session.activeSnapshot.index,
    };

    const result = await manager.applyIntent(timeoutIntent);
    expect(result.validation.kind).toBe('accepted');
    expect(result.session.metrics.timeoutsHard).toBe(1);

    const round = result.session.activeSnapshot.hand.bettingRounds[0];
    expect(round?.turns).toHaveLength(1);
    const action = round?.turns[0]?.action;
    expect(action?.type).toBe('timeout');
    if (action?.type === 'timeout') {
      expect(action.fallback).toBe('fold');
    }

    const nextActor = result.session.activeSnapshot.clock.currentActor;
    expect(nextActor).not.toBe(actor);

    const context = selectDecisionContext(result.session);
    expect(context.playersLeftToAct).not.toContain(actor);
  });

  test('engine hook failures are isolated and reported', async () => {
    const manager = SessionManager.create(createConfig(), seats, {
      hooks: {
        afterReduction: {
          id: 'failing-hook',
          priority: 1,
          handler: () => {
            throw new Error('hook failure');
          },
        },
      },
    });

    const actor = manager.session.activeSnapshot.clock.currentActor ?? 'hero';
    const context = selectDecisionContext(manager.session);
    const option =
      context.availableActions.find((action) => action.type === 'check') ??
      context.availableActions[0]!;
    const intent = buildIntentFromOption(
      actor,
      option,
      manager.session.activeSnapshot.index,
      10_000,
    );

    const outcome = await manager.applyIntent(intent);
    expect(outcome.validation.kind).toBe('accepted');
    expect(outcome.hookErrors).toHaveLength(1);
    expect(outcome.hookErrors[0]?.stage).toBe('afterReduction');
    expect(manager.session.events).toHaveLength(1);
  });

  test('persona adaptation metrics update after loose play hook', async () => {
    const manager = SessionManager.create(createConfig(), seats, {
      hooks: {
        afterReduction: {
          id: 'persona-updater',
          priority: 1,
          handler: (_snapshot, session) => {
            const latest = session.events.at(-1);
            if (!latest) return;

            const personas = session.activeSnapshot
              .personas as Mutable<PersonaMatrix>;
            const profile = personas.entries[latest.actor];
            if (!profile) return;

            personas.entries[latest.actor] = {
              ...profile,
              adaptation: {
                ...profile.adaptation,
                trackedMetrics: {
                  ...profile.adaptation.trackedMetrics,
                  vpip: 60,
                  aggressionFactor: 32,
                },
                lastUpdated: latest.timestamp,
                featureVector: [1, 0, 1],
              },
            };
          },
        },
      },
    });
    const actor = manager.session.activeSnapshot.clock.currentActor ?? 'hero';
    const context = selectDecisionContext(manager.session);
    const option =
      context.availableActions.find((action) => action.type === 'raise') ??
      context.availableActions.find((action) => action.type === 'bet') ??
      context.availableActions.find((action) => action.type === 'call') ??
      context.availableActions[0]!;
    const aggressiveIntent = buildIntentFromOption(
      actor,
      option,
      manager.session.activeSnapshot.index,
      12_000,
    );
    const outcome = await manager.applyIntent(aggressiveIntent);
    expect(outcome.validation.kind).toBe('accepted');
    expect(outcome.hookErrors).toHaveLength(0);

    const persona = manager.session.activeSnapshot.personas.entries[actor]!;
    expect(persona.adaptation.trackedMetrics.vpip).toBeCloseTo(60, 5);
    expect(persona.adaptation.trackedMetrics.aggressionFactor).toBeCloseTo(
      32,
      5,
    );
    expect(persona.adaptation.featureVector).toEqual([1, 0, 1]);
    expect(persona.adaptation.lastUpdated).toBe(12_000);

    const view = selectSimulationView(manager.session);
    const digest = view.personas.find((entry) => entry.playerId === actor);
    expect(digest?.profile.adaptation.trackedMetrics.vpip).toBeCloseTo(60, 5);

    const lastEvent = manager.session.events.at(-1);
    expect(lastEvent).toBeDefined();
    if (lastEvent) {
      const snapshotBefore = replayEvents(
        manager.session.initialSnapshot,
        manager.session.events.slice(0, -1),
      );
      const telemetry = selectTelemetryEvent(manager.session, lastEvent, {
        snapshotBefore,
        snapshotAfter: manager.session.activeSnapshot,
        potBefore: sumPotAmounts(snapshotBefore.pots),
        potAfter: sumPotAmounts(manager.session.activeSnapshot.pots),
        eventIndex: manager.session.events.length - 1,
      });
      expect(telemetry.sessionId).toBe(manager.session.id);
      expect(telemetry.handStage).toBe(
        manager.session.activeSnapshot.hand.stage,
      );
      expect(telemetry.eventId).toBe(lastEvent.id);
      expect(telemetry.legalOptions.length).toBeGreaterThan(0);
      expect(telemetry.availableActionsAtDecision.length).toBeGreaterThan(0);
      const adjustment = telemetry.personaAdjustments.find(
        (entry) => entry.playerId === actor,
      );
      expect(adjustment).toBeDefined();
      expect(adjustment?.after.trackedMetrics.vpip).toBeCloseTo(60, 5);
      expect(adjustment?.after.trackedMetrics.aggressionFactor).toBeCloseTo(
        32,
        5,
      );
      expect(telemetry.potDelta).toBeGreaterThanOrEqual(0);
      expect(telemetry.clock.perTurnMs).toBe(
        manager.session.activeSnapshot.clock.perTurnMs,
      );
      expect(telemetry.handFlags.autoRunout).toBe(
        manager.session.activeSnapshot.flags.autoRunout,
      );
    }
  });
});
