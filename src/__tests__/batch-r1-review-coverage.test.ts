import { describe, expect, test } from 'vitest';

import {
  EnvelopeUpcaster,
  SessionManager,
  advanceActionClock,
  bootstrapSession,
  completeHand,
  createTableSnapshot,
  createTurnIntent,
  dealHoleCards,
  endDealerPause,
  fromSnapshotEnvelope,
  fromTurnEventEnvelope,
  recoverMisdeal,
  replayEvents,
  revealCommunityCards,
  selectDecisionContext,
  selectHandSummary,
  settlePots,
  startDealerPause,
  toSnapshotEnvelope,
  toTurnEventEnvelope,
  updateSessionMetrics,
  validateIntent,
} from '..';
import { ENGINE_VERSION } from '..';
import {
  SNAPSHOT_ENVELOPE_VERSION,
  TURN_EVENT_ENVELOPE_VERSION,
} from '../core/envelopes';
import type {
  SeatBootstrapConfig,
  SessionBootstrapOptions,
} from '../session/lifecycle';
import { transitionSeat } from '../session/lifecycle';
import type { Card, HandStage } from '../types/common';
import type { PlayerOption, TurnEvent, TurnIntent } from '../types/events';
import type { Session, SessionConfig, SessionMetrics } from '../types/session';
import type {
  ActionClock,
  EvaluatedHand,
  PayoutEntry,
  PotBucket,
  ShowdownSummary,
  TableSnapshot,
} from '../types/snapshot';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

interface LegacyTurnEventV0 {
  readonly id: string;
  readonly actor: string;
  readonly action: TurnEvent['action'];
  readonly options: readonly PlayerOption[];
  readonly stackBefore: number;
  readonly stackAfter?: number;
  readonly contribution: number;
  readonly timestamp: number;
}

interface LegacySnapshotV0 {
  readonly baseVersion: number;
  readonly handNumber: number;
  readonly seating: TableSnapshot['seating'];
  readonly hand: TableSnapshot['hand'];
  readonly pots: TableSnapshot['pots'];
  readonly cards: TableSnapshot['cards'];
  readonly personas: TableSnapshot['personas'];
  readonly clock: TableSnapshot['clock'];
  readonly flags: Omit<TableSnapshot['flags'], 'recoveryMode'>;
}

describe('batch R1 – review coverage compliance', () => {
  describe('serialization & versioning', () => {
    test('turn event and snapshot envelopes round-trip their payloads', () => {
      const snapshot = createTableSnapshot();
      const intent = createTurnIntent({
        actor: snapshot.clock.currentActor ?? 'player-a',
        expectedSnapshotVersion: snapshot.index,
      });

      const validation = validateIntent(snapshot, intent);
      expect(validation.kind).toBe('accepted');
      if (validation.kind !== 'accepted') {
        throw new Error('intent must be accepted in round-trip test');
      }

      const eventEnvelope = toTurnEventEnvelope(validation.event);
      expect(eventEnvelope.envelopeVersion).toBe(TURN_EVENT_ENVELOPE_VERSION);
      const restoredEvent = fromTurnEventEnvelope(eventEnvelope);
      expect(restoredEvent).toEqual(validation.event);

      const snapshotEnvelope = toSnapshotEnvelope(snapshot);
      expect(snapshotEnvelope.envelopeVersion).toBe(SNAPSHOT_ENVELOPE_VERSION);
      const restoredSnapshot = fromSnapshotEnvelope(snapshotEnvelope);
      expect(restoredSnapshot).toEqual(snapshot);
    });

    test('historical envelopes upgrade through registered upcasters', () => {
      const legacyEventEnvelope = {
        envelopeVersion: 0,
        event: {
          id: 'legacy-event',
          actor: 'player-legacy',
          action: { type: 'check' } as TurnEvent['action'],
          options: [{ type: 'check' }],
          stackBefore: 50,
          contribution: 0,
          timestamp: 1_000,
        } satisfies LegacyTurnEventV0,
      };

      const eventUpcaster = new EnvelopeUpcaster<TurnEvent>(
        TURN_EVENT_ENVELOPE_VERSION,
      );
      eventUpcaster.register(0, (payload) => {
        const legacy = payload as LegacyTurnEventV0;
        const legalOptions = legacy.options.map((option) => ({
          ...option,
        })) as TurnEvent['legalOptions'];
        const stackAfter =
          legacy.stackAfter ?? legacy.stackBefore - legacy.contribution;
        return {
          id: legacy.id,
          actor: legacy.actor,
          action: legacy.action,
          legalOptions,
          stackBefore: legacy.stackBefore,
          stackAfter,
          contribution: legacy.contribution,
          timestamp: legacy.timestamp,
          metadata: {
            engineVersion: ENGINE_VERSION,
            availableActionsAtDecision: legalOptions,
          },
        } satisfies TurnEvent;
      });

      const upgradedEvent = fromTurnEventEnvelope(
        legacyEventEnvelope,
        eventUpcaster,
      );
      expect(upgradedEvent.legalOptions).toEqual([{ type: 'check' }]);
      expect(upgradedEvent.metadata?.engineVersion).toBe(ENGINE_VERSION);

      const baseSnapshot = createTableSnapshot();
      const legacySnapshotEnvelope = {
        envelopeVersion: 0,
        snapshot: {
          baseVersion: baseSnapshot.index,
          handNumber: baseSnapshot.handNumber,
          seating: baseSnapshot.seating,
          hand: baseSnapshot.hand,
          pots: baseSnapshot.pots,
          cards: baseSnapshot.cards,
          personas: baseSnapshot.personas,
          clock: baseSnapshot.clock,
          flags: {
            showdownLocked: baseSnapshot.flags.showdownLocked,
            autoRunout: baseSnapshot.flags.autoRunout,
            pendingEliminations: baseSnapshot.flags.pendingEliminations,
            rebuyAvailable: baseSnapshot.flags.rebuyAvailable,
            advisoryPending: baseSnapshot.flags.advisoryPending,
          },
        } satisfies LegacySnapshotV0,
      };

      const snapshotUpcaster = new EnvelopeUpcaster<TableSnapshot>(
        SNAPSHOT_ENVELOPE_VERSION,
      );
      snapshotUpcaster.register(0, (payload) => {
        const legacy = payload as LegacySnapshotV0;
        return {
          index: legacy.baseVersion,
          handNumber: legacy.handNumber,
          seating: legacy.seating,
          hand: legacy.hand,
          pots: legacy.pots,
          cards: legacy.cards,
          personas: legacy.personas,
          clock: legacy.clock,
          flags: {
            ...legacy.flags,
            recoveryMode: false,
          },
        } satisfies TableSnapshot;
      });

      const upgradedSnapshot = fromSnapshotEnvelope(
        legacySnapshotEnvelope,
        snapshotUpcaster,
      );
      expect(upgradedSnapshot.flags.recoveryMode).toBe(false);
      expect(upgradedSnapshot.pots).toEqual(baseSnapshot.pots);
    });

    test('replay parity holds between raw events and upcast envelopes', async () => {
      const config = createSessionConfig(6);
      const seats = buildSeats(3);
      const manager = SessionManager.create(config, seats, {
        now: () => 1_000,
      });

      const firstDecision = selectDecisionContext(manager.session);
      const firstOption = findFirstPlayableOption(
        firstDecision.availableActions,
        ['bet', 'raise', 'call', 'check'],
      );
      const firstIntent = buildIntentFromOption(
        firstDecision.actor ?? 'player-a',
        firstOption,
        manager.session.activeSnapshot.index,
        1_000,
      );
      const firstOutcome = await manager.applyIntent(firstIntent);
      expect(firstOutcome.validation.kind).toBe('accepted');

      const secondDecision = selectDecisionContext(manager.session);
      const secondOption = findFirstPlayableOption(
        secondDecision.availableActions,
        ['call', 'check', 'fold'],
      );
      const secondIntent = buildIntentFromOption(
        secondDecision.actor ?? 'player-b',
        secondOption,
        manager.session.activeSnapshot.index,
        1_500,
      );
      const secondOutcome = await manager.applyIntent(secondIntent);
      expect(secondOutcome.validation.kind).toBe('accepted');

      const rawReplay = replayEvents(
        manager.session.initialSnapshot,
        manager.session.events,
      );

      const eventUpcaster = new EnvelopeUpcaster<TurnEvent>(
        TURN_EVENT_ENVELOPE_VERSION,
      );
      eventUpcaster.register(0, (payload) => {
        const legacy = payload as LegacyTurnEventV0;
        const legalOptions = legacy.options.map((option) => ({
          ...option,
        })) as TurnEvent['legalOptions'];
        const stackAfter =
          legacy.stackAfter ?? legacy.stackBefore - legacy.contribution;
        return {
          id: legacy.id,
          actor: legacy.actor,
          action: legacy.action,
          legalOptions,
          stackBefore: legacy.stackBefore,
          stackAfter,
          contribution: legacy.contribution,
          timestamp: legacy.timestamp,
          metadata: {
            engineVersion: ENGINE_VERSION,
            availableActionsAtDecision: legalOptions,
          },
        } satisfies TurnEvent;
      });

      const legacyEvents = manager.session.events.map((event) => ({
        envelopeVersion: 0,
        event: {
          id: event.id,
          actor: event.actor,
          action: event.action,
          options: event.legalOptions.map((option) => ({ ...option })),
          stackBefore: event.stackBefore,
          stackAfter: event.stackAfter,
          contribution: event.contribution,
          timestamp: event.timestamp,
        } satisfies LegacyTurnEventV0,
      }));

      const snapshotUpcaster = new EnvelopeUpcaster<TableSnapshot>(
        SNAPSHOT_ENVELOPE_VERSION,
      );
      snapshotUpcaster.register(0, (payload) => {
        const legacy = payload as LegacySnapshotV0;
        return {
          index: legacy.baseVersion,
          handNumber: legacy.handNumber,
          seating: legacy.seating,
          hand: legacy.hand,
          pots: legacy.pots,
          cards: legacy.cards,
          personas: legacy.personas,
          clock: legacy.clock,
          flags: {
            ...legacy.flags,
            recoveryMode: false,
          },
        } satisfies TableSnapshot;
      });

      const legacyInitial = {
        envelopeVersion: 0,
        snapshot: {
          baseVersion: manager.session.initialSnapshot.index,
          handNumber: manager.session.initialSnapshot.handNumber,
          seating: manager.session.initialSnapshot.seating,
          hand: manager.session.initialSnapshot.hand,
          pots: manager.session.initialSnapshot.pots,
          cards: manager.session.initialSnapshot.cards,
          personas: manager.session.initialSnapshot.personas,
          clock: manager.session.initialSnapshot.clock,
          flags: {
            showdownLocked:
              manager.session.initialSnapshot.flags.showdownLocked,
            autoRunout: manager.session.initialSnapshot.flags.autoRunout,
            pendingEliminations:
              manager.session.initialSnapshot.flags.pendingEliminations,
            rebuyAvailable:
              manager.session.initialSnapshot.flags.rebuyAvailable,
            advisoryPending:
              manager.session.initialSnapshot.flags.advisoryPending,
          },
        } satisfies LegacySnapshotV0,
      };

      const upgradedInitial = fromSnapshotEnvelope(
        legacyInitial,
        snapshotUpcaster,
      );
      const upgradedEvents = legacyEvents.map((envelope) =>
        fromTurnEventEnvelope(envelope, eventUpcaster),
      );
      const upgradedReplay = replayEvents(upgradedInitial, upgradedEvents);

      expect(upgradedReplay).toEqual(rawReplay);
    });
  });

  describe('multi-way odd-chip and rounding reconciliation', () => {
    test('odd chips rotate starting left of the button in three-way ties', () => {
      const snapshot = createTableSnapshot({
        players: [
          { id: 'player-a', stack: 0 },
          { id: 'player-b', stack: 0 },
          { id: 'player-c', stack: 0 },
          { id: 'player-d', stack: 0 },
        ],
      });

      const contenders = ['player-a', 'player-b', 'player-c'] as const;
      const contributions: Record<
        'player-a' | 'player-b' | 'player-c' | 'player-d',
        number
      > = {
        'player-a': 40,
        'player-b': 35,
        'player-c': 26,
        'player-d': 0,
      };
      const pots = {
        main: {
          id: 'main',
          amount: 101,
          eligiblePlayers: contenders,
          contributions,
        },
        sides: [] as PotBucket[],
        rake: 0,
      } satisfies TableSnapshot['pots'];

      const evaluatedHands: EvaluatedHand[] = contenders.map((playerId) => ({
        playerId,
        rankClass: 'pair',
        rankValue: 2_000,
        bestFive: ['As', 'Ad', 'Kc', 'Qh', 'Js'],
        kickers: [],
      }));
      const summary: ShowdownSummary = {
        evaluatedHands,
        board: ['As', 'Ad', 'Kc', 'Qh', 'Js'],
        evaluatorId: 'lookup-v1',
      };

      const enrichedSnapshot: TableSnapshot = {
        ...snapshot,
        pots,
        hand: {
          ...snapshot.hand,
          showdown: summary,
        },
      };

      const payouts = settlePots(enrichedSnapshot, summary);
      expect(payouts.entries).toHaveLength(3);
      const byPlayer = Object.fromEntries(
        payouts.entries.map((entry) => [entry.playerId, entry.amount]),
      ) as Record<string, number>;

      expect(byPlayer['player-a']).toBe(33);
      expect(byPlayer['player-b']).toBe(34);
      expect(byPlayer['player-c']).toBe(34);
      expect(sumPayouts(payouts.entries)).toBe(101);
    });

    test('five-way parity with rake preserves chip totals across main and side pots', () => {
      const snapshot = createTableSnapshot({
        players: [
          { id: 'seat-0', stack: 0 },
          { id: 'seat-1', stack: 0 },
          { id: 'seat-2', stack: 0 },
          { id: 'seat-3', stack: 0 },
          { id: 'seat-4', stack: 0 },
        ],
      });

      const eligible = snapshot.seating.seats
        .map((seat) => seat.occupant?.playerId)
        .filter((id): id is string => Boolean(id));

      const baseContributions = snapshot.pots.main.contributions;
      const main: PotBucket = {
        ...snapshot.pots.main,
        amount: 137,
        eligiblePlayers: eligible,
        contributions: {
          ...baseContributions,
          [eligible[0]!]: 28,
          [eligible[1]!]: 27,
          [eligible[2]!]: 27,
          [eligible[3]!]: 27,
          [eligible[4]!]: 28,
        },
      };
      const side: PotBucket = {
        ...snapshot.pots.main,
        id: 'side-1',
        amount: 18,
        eligiblePlayers: eligible.slice(0, 3),
        contributions: {
          ...baseContributions,
          [eligible[0]!]: 6,
          [eligible[1]!]: 6,
          [eligible[2]!]: 6,
        },
      };
      const pots: TableSnapshot['pots'] = {
        main,
        sides: [side],
        rake: 5,
      };

      const evaluatedHands: EvaluatedHand[] = eligible.map((playerId) => ({
        playerId: playerId!,
        rankClass: 'flush',
        rankValue: 5_500,
        bestFive: ['Ah', 'Qh', 'Th', '7h', '4h'],
        kickers: [],
      }));

      const summary: ShowdownSummary = {
        evaluatedHands,
        board: ['Ah', 'Qh', 'Th', '7h', '4h'],
        evaluatorId: 'lookup-v1',
      };

      const enrichedSnapshot: TableSnapshot = {
        ...snapshot,
        pots,
        hand: { ...snapshot.hand, showdown: summary },
      };

      const payouts = settlePots(enrichedSnapshot, summary);

      const totalAwarded = sumPayouts(payouts.entries);
      const rake = payouts.rake ?? 0;
      expect(totalAwarded + rake).toBe(160);
      const amounts = Object.fromEntries(
        payouts.entries.map((entry) => [entry.playerId, entry.amount]),
      ) as Record<string, number>;
      expect(amounts['seat-0']).toBe(33);
      expect(amounts['seat-1']).toBe(34);
      expect(amounts['seat-2']).toBe(34);
      expect(amounts['seat-3']).toBe(27);
      expect(amounts['seat-4']).toBe(27);
    });
  });

  describe('heads-up transition dynamics', () => {
    test('elimination mid-hand converts the next deal into heads-up structure', () => {
      const config = createSessionConfig(6);
      const seats = buildSeats(3);
      let session = bootstrapSession(config, seats);

      const snapshot = session.activeSnapshot as Mutable<TableSnapshot>;
      const eliminatedSeat = snapshot.seating.seats[2] as Mutable<
        TableSnapshot['seating']['seats'][number]
      >;
      eliminatedSeat.stack = 0;
      eliminatedSeat.status = 'leaving';
      snapshot.flags = {
        ...snapshot.flags,
        pendingEliminations: ['player-3'],
      };

      session = completeHand(session);
      const headsUpSnapshot = session.activeSnapshot;
      const liveSeats = headsUpSnapshot.seating.seats.filter(
        (seat) => seat.occupant,
      );
      expect(liveSeats).toHaveLength(2);
      const buttonIndex = headsUpSnapshot.seating.dealerButton;
      const buttonPlayer =
        headsUpSnapshot.seating.seats[buttonIndex]?.occupant?.playerId;
      const smallBlindPlayer = headsUpSnapshot.hand.blinds.smallBlind.playerId;
      expect(buttonPlayer).toBe(smallBlindPlayer);
      const otherPlayer = liveSeats.find(
        (seat) => seat.occupant?.playerId !== buttonPlayer,
      )?.occupant?.playerId;
      expect(headsUpSnapshot.hand.blinds.bigBlind.playerId).toBe(otherPlayer);
      const round = headsUpSnapshot.hand.bettingRounds[0];
      expect(round?.turnOrder).toHaveLength(2);

      const refilled = transitionSeat(session, 2, 'occupied', {
        occupant: {
          playerId: 'player-rejoin',
          displayName: 'Rejoin',
        },
        stack: 100,
      });
      const reverted = completeHand(refilled);
      const revertedSnapshot = reverted.activeSnapshot;
      expect(
        revertedSnapshot.seating.seats.filter((seat) => seat.occupant),
      ).toHaveLength(3);
      const buttonAfter =
        revertedSnapshot.seating.seats[revertedSnapshot.seating.dealerButton]
          ?.occupant?.playerId;
      expect(buttonAfter).toBeDefined();
      expect(revertedSnapshot.hand.blinds.smallBlind.playerId).not.toBe(
        buttonAfter,
      );
    });
  });

  describe('timer boundary cases', () => {
    test('0ms time-bank exhaustion clamps at zero without negative overflow', () => {
      const clock: ActionClock = {
        currentActor: 'player-a',
        deadline: 1_000,
        perTurnMs: 1_000,
        bankMs: { 'player-a': 0 },
        pauses: [],
      };

      const result = advanceActionClock(clock, 'player-a', 1_600);
      expect(result.usedBankMs).toBe(0);
      expect(result.exhausted).toBe(true);
      expect(result.clock.bankMs['player-a']).toBe(0);
      expect(result.clock.deadline).toBeUndefined();
    });

    test('negative overdraw is clamped when overtime exceeds remaining bank', () => {
      const clock: ActionClock = {
        currentActor: 'player-a',
        deadline: 1_000,
        perTurnMs: 1_000,
        bankMs: { 'player-a': 300 },
        pauses: [],
      };

      const result = advanceActionClock(clock, 'player-a', 1_800);
      expect(result.usedBankMs).toBe(300);
      expect(result.clock.bankMs['player-a']).toBe(0);
      expect(result.exhausted).toBe(true);
    });

    test('global pause halts expiry until resumed and rewinds maintain pauses', async () => {
      const baseClock: ActionClock = {
        currentActor: 'player-a',
        deadline: 1_000,
        perTurnMs: 1_000,
        bankMs: { 'player-a': 500 },
        pauses: [],
      };
      const paused = startDealerPause(baseClock, 900);
      const stillPaused = advanceActionClock(paused, 'player-a', 1_600);
      expect(stillPaused.usedBankMs).toBe(0);
      expect(stillPaused.clock.bankMs['player-a']).toBe(500);

      const resumed = endDealerPause(paused, 1_400);
      const afterResume = advanceActionClock(resumed, 'player-a', 1_800);
      expect(afterResume.usedBankMs).toBe(400);
      expect(afterResume.clock.bankMs['player-a']).toBe(100);

      const config = createSessionConfig(2);
      const seats = buildSeats(config.maxSeats);
      const manager = SessionManager.create(config, seats, {
        now: () => 2_000,
      });

      const session = manager.session as Mutable<Session>;
      (session.initialSnapshot.clock as Mutable<ActionClock>).pauses =
        paused.pauses.map((window) => ({ ...window }));
      (session.activeSnapshot.clock as Mutable<ActionClock>).pauses =
        paused.pauses.map((window) => ({ ...window }));

      const decision = selectDecisionContext(manager.session);
      const option = findFirstPlayableOption(decision.availableActions, [
        'check',
      ]);
      const intent = buildIntentFromOption(
        decision.actor ?? 'player-a',
        option,
        manager.session.activeSnapshot.index,
        2_000,
      );
      const outcome = await manager.applyIntent(intent);
      expect(outcome.validation.kind).toBe('accepted');

      manager.enterReplay();
      await manager.rewindTo(0);
      expect(manager.session.activeSnapshot.clock.pauses).toEqual(
        paused.pauses,
      );

      const replaceEnvelope = manager.eventLog;
      await manager.replaceFrom(0, replaceEnvelope);
      expect(manager.session.activeSnapshot.clock.pauses).toEqual(
        paused.pauses,
      );
      manager.exitReplay();
    });
  });

  describe('concurrency and idempotency controls', () => {
    test('duplicate ULID intents are rejected as stale with retry guidance', async () => {
      const config = createSessionConfig(2);
      const seats = buildSeats(config.maxSeats);
      const manager = SessionManager.create(config, seats);

      const decision = selectDecisionContext(manager.session);
      const option = findFirstPlayableOption(decision.availableActions, [
        'check',
      ]);
      const intent = buildIntentFromOption(
        decision.actor ?? 'player-a',
        option,
        manager.session.activeSnapshot.index,
        5_000,
      );

      const first = await manager.applyIntent(intent);
      expect(first.validation.kind).toBe('accepted');

      const duplicate = await manager.applyIntent(intent);
      expect(duplicate.validation.kind).toBe('rejected');
      if (duplicate.validation.kind !== 'rejected') {
        throw new Error('expected rejection for duplicate intent');
      }
      expect(duplicate.validation.recovery?.advise).toBe('retry');
      expect(manager.session.events).toHaveLength(1);
    });

    test('stale snapshot versions reject out-of-order intents', async () => {
      const config = createSessionConfig(2);
      const seats = buildSeats(config.maxSeats);
      const manager = SessionManager.create(config, seats);

      const decision = selectDecisionContext(manager.session);
      const option = findFirstPlayableOption(decision.availableActions, [
        'check',
      ]);
      const intent = buildIntentFromOption(
        decision.actor ?? 'player-a',
        option,
        manager.session.activeSnapshot.index,
        10_000,
      );
      const accepted = await manager.applyIntent(intent);
      expect(accepted.validation.kind).toBe('accepted');

      const staleIntent = {
        ...intent,
        expectedSnapshotVersion: intent.expectedSnapshotVersion,
        issuedAt: 12_000,
      };
      const stale = await manager.applyIntent(staleIntent);
      expect(stale.validation.kind).toBe('rejected');
      if (stale.validation.kind === 'rejected') {
        expect(stale.validation.reason).toBe('version-mismatch');
        expect(stale.validation.recovery?.advise).toBe('retry');
      }
    });

    test('optimistic locking guards auto-runout event streams', async () => {
      const config: SessionConfig = {
        ...createSessionConfig(2),
        autoAdvance: true,
      };
      const seats = buildSeats(config.maxSeats);
      const manager = SessionManager.create(config, seats, {
        now: () => 20_000,
      });

      const decision = selectDecisionContext(manager.session);
      const option = findFirstPlayableOption(decision.availableActions, [
        'call',
        'check',
      ]);
      const intent = {
        ...buildIntentFromOption(
          decision.actor ?? 'player-a',
          option,
          manager.session.activeSnapshot.index,
          20_000,
        ),
        expectedSnapshotVersion: undefined,
      };
      const outcome = await manager.applyIntent(intent);
      expect(outcome.validation.kind).toBe('accepted');
      expect(manager.session.events).toHaveLength(1);

      const handSummary = selectHandSummary(manager.session);
      expect(handSummary.pendingEliminations).toBeDefined();
    });
  });

  describe('misdeal and redeal resilience', () => {
    test('misdeal recovery rebuilds remaining deck and clears reveal schedule', () => {
      const config = createSessionConfig(6);
      const seats = buildSeats(3);
      const deck: readonly Card[] = [
        'As',
        'Ks',
        'Qs',
        'Js',
        'Ts',
        '9s',
        '8s',
        '7s',
      ];
      let session = bootstrapSession(config, seats, {
        deck,
      } satisfies SessionBootstrapOptions);

      const order = session.activeSnapshot.seating.seats
        .map((seat) => seat.occupant?.playerId)
        .filter((id): id is string => Boolean(id));

      const deal = dealHoleCards(session, order);
      expect(deal.dealtCards).toHaveLength(
        order.length * config.ruleSet.cardDistribution.holeCardsPerPlayer,
      );
      session = deal.session;

      session = recoverMisdeal(session, deal.dealtCards);
      expect(session.activeSnapshot.cards.holeCards).toMatchObject(
        Object.fromEntries(order.map((id) => [id, null])),
      );
      expect(session.activeSnapshot.cards.remainingDeck.slice(0, 8)).toEqual(
        deck,
      );

      const timestamp = 30_000;
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
            : stageIndex >= 0 && stageIndex < burnArray.length
              ? (burnArray[stageIndex] ?? 0)
              : (burnArray[revealIndex] ?? 0);
        const reveal =
          communityArray.length === 3
            ? (communityArray[revealIndex] ?? defaultReveal)
            : stageIndex >= 0 && stageIndex < communityArray.length
              ? (communityArray[stageIndex] ?? defaultReveal)
              : (communityArray[revealIndex] ?? defaultReveal);
        return { burn, reveal };
      };

      const takeCommunity = (
        current: Session,
        stage: Extract<HandStage, 'flop' | 'turn' | 'river'>,
      ): readonly Card[] => {
        const { burn, reveal } = getCounts(stage);
        const { remainingDeck } = current.activeSnapshot.cards;
        expect(remainingDeck.length).toBeGreaterThanOrEqual(burn + reveal);
        return remainingDeck.slice(burn, burn + reveal);
      };

      const flopCards = takeCommunity(session, 'flop');
      session = revealCommunityCards(session, 'flop', flopCards, timestamp);
      const turnCards = takeCommunity(session, 'turn');
      session = revealCommunityCards(session, 'turn', turnCards, timestamp + 1);
      expect(
        session.activeSnapshot.cards.community.revealSchedule,
      ).toHaveLength(4);

      session = recoverMisdeal(session, [...flopCards, ...turnCards]);
      expect(session.activeSnapshot.cards.burnPile).toHaveLength(0);
      expect(session.activeSnapshot.cards.remainingDeck.slice(0, 8)).toEqual(
        deck,
      );

      session = revealCommunityCards(
        session,
        'flop',
        takeCommunity(session, 'flop'),
        timestamp + 10,
      );
      const redealtCommunity = session.activeSnapshot.cards.community;
      expect(redealtCommunity.flop).toEqual(['Ks', 'Qs', 'Js']);
      const lastReveal =
        redealtCommunity.revealSchedule[
          redealtCommunity.revealSchedule.length - 1
        ];
      expect(lastReveal?.stage).toBe('flop');
      expect(lastReveal?.reason).toBe('deal');
      expect(session.activeSnapshot.cards.remainingDeck.length).toBe(
        deck.length - 4,
      );
    });
  });

  describe('persona adaptation constraints', () => {
    test('persona updates occur once per accepted event and remain bounded', async () => {
      const config = createSessionConfig(2);
      const seats = buildSeats(config.maxSeats);
      const manager = SessionManager.create(config, seats, {
        hooks: {
          afterReduction: {
            id: 'persona-guard',
            priority: 1,
            handler: (_snapshot, session) => {
              const personas = session.activeSnapshot.personas as Mutable<
                TableSnapshot['personas']
              >;
              const actor = session.events.at(-1)?.actor;
              if (!actor) return;
              const profile = personas.entries[actor];
              if (!profile) return;
              const vpip = Math.min(
                100,
                profile.adaptation.trackedMetrics.vpip + 10,
              );
              personas.entries[actor] = {
                ...profile,
                adaptation: {
                  ...profile.adaptation,
                  trackedMetrics: {
                    ...profile.adaptation.trackedMetrics,
                    vpip,
                  },
                },
              };
            },
          },
        },
      });

      const decision = selectDecisionContext(manager.session);
      const option = findFirstPlayableOption(decision.availableActions, [
        'check',
      ]);
      const intent = buildIntentFromOption(
        decision.actor ?? 'player-a',
        option,
        manager.session.activeSnapshot.index,
        50_000,
      );

      const accepted = await manager.applyIntent(intent);
      expect(accepted.validation.kind).toBe('accepted');
      const actor = decision.actor ?? 'player-a';
      const profile = manager.session.activeSnapshot.personas.entries[actor];
      expect(profile?.adaptation.trackedMetrics.vpip).toBeLessThanOrEqual(100);

      const rejected = await manager.applyIntent({
        ...intent,
        expectedSnapshotVersion: intent.expectedSnapshotVersion,
      });
      expect(rejected.validation.kind).toBe('rejected');
      const unchanged = manager.session.activeSnapshot.personas.entries[actor];
      expect(unchanged?.adaptation.trackedMetrics.vpip).toBe(
        profile?.adaptation.trackedMetrics.vpip,
      );
    });
  });

  describe('evaluator metamorphic invariants', () => {
    test('seat permutation and chip scaling maintain payout winners', () => {
      const snapshot = createTableSnapshot({
        players: [
          { id: 'p1', stack: 0 },
          { id: 'p2', stack: 0 },
          { id: 'p3', stack: 0 },
        ],
      });

      const contributions: Record<'p1' | 'p2' | 'p3', number> = {
        p1: 50,
        p2: 50,
        p3: 50,
      };
      const pots: TableSnapshot['pots'] = {
        main: {
          id: 'main',
          amount: 150,
          eligiblePlayers: ['p1', 'p2', 'p3'],
          contributions,
        },
        sides: [],
        rake: 0,
      };
      const summary: ShowdownSummary = {
        evaluatedHands: [
          {
            playerId: 'p1',
            rankClass: 'straight',
            rankValue: 4_500,
            bestFive: ['5c', '6d', '7s', '8h', '9c'],
            kickers: [],
          },
          {
            playerId: 'p2',
            rankClass: 'straight',
            rankValue: 4_500,
            bestFive: ['5c', '6d', '7s', '8h', '9c'],
            kickers: [],
          },
          {
            playerId: 'p3',
            rankClass: 'pair',
            rankValue: 1_000,
            bestFive: ['Ah', 'Ad', 'Kc', 'Qh', 'Js'],
            kickers: ['Td'],
          },
        ],
        board: ['5c', '6d', '7s', '8h', '9c'],
        evaluatorId: 'lookup-v1',
      };

      const baseline = settlePots(
        {
          ...snapshot,
          pots,
          hand: { ...snapshot.hand, showdown: summary },
        },
        summary,
      );

      const permuted = settlePots(
        {
          ...snapshot,
          seating: {
            dealerButton: 1,
            seats: snapshot.seating.seats.slice().reverse(),
          },
          pots: {
            ...pots,
            main: {
              ...pots.main,
              contributions: {
                p1: contributions.p1 * 2,
                p2: contributions.p2 * 2,
                p3: contributions.p3 * 2,
              },
              amount: pots.main.amount * 2,
            },
          },
        },
        {
          ...summary,
          evaluatedHands: summary.evaluatedHands
            .slice()
            .reverse()
            .map((hand) => ({
              ...hand,
              bestFive: hand.bestFive.slice(),
            })),
        },
      );

      const baselineWinners = baseline.entries.map((entry) => entry.playerId);
      const permutedWinners = permuted.entries.map((entry) => entry.playerId);
      expect(new Set(permutedWinners)).toEqual(new Set(baselineWinners));
    });
  });

  describe('auto-runout parity', () => {
    test('manual versus automatic runouts yield identical snapshots', async () => {
      const config = createSessionConfig(2);
      const seats = buildSeats(config.maxSeats);
      const manual = SessionManager.create(config, seats, {
        now: () => 60_000,
      });
      const automatic = SessionManager.create(config, seats, {
        now: () => 60_000,
      });

      const decisionManual = selectDecisionContext(manual.session);
      const allInOption = findFirstPlayableOption(
        decisionManual.availableActions,
        ['all-in', 'raise'],
      );
      const manualIntent = buildIntentFromOption(
        decisionManual.actor ?? 'player-a',
        allInOption,
        manual.session.activeSnapshot.index,
        60_000,
        'bet',
      );
      const manualOutcome = await manual.applyIntent(manualIntent);
      expect(manualOutcome.validation.kind).toBe('accepted');

      const decisionAuto = selectDecisionContext(automatic.session);
      const autoIntent = {
        ...buildIntentFromOption(
          decisionAuto.actor ?? 'player-a',
          allInOption,
          automatic.session.activeSnapshot.index,
          60_000,
          'bet',
        ),
        expectedSnapshotVersion: undefined,
      };
      const autoOutcome = await automatic.applyIntent(autoIntent);
      expect(autoOutcome.validation.kind).toBe('accepted');

      expect(automatic.session.activeSnapshot.pots).toEqual(
        manual.session.activeSnapshot.pots,
      );
      expect(selectHandSummary(automatic.session)).toEqual(
        selectHandSummary(manual.session),
      );
    });
  });

  describe('hook isolation and ordering', () => {
    test('failing hooks are isolated and recorded without corrupting state', async () => {
      const config = createSessionConfig(2);
      const seats = buildSeats(config.maxSeats);
      const manager = SessionManager.create(config, seats, {
        hooks: {
          afterValidation: [
            {
              id: 'fails-first',
              priority: 1,
              handler: async () => {
                throw new Error('hook failure');
              },
            },
            {
              id: 'runs-second',
              priority: 2,
              handler: async () => {
                /* no-op */
              },
            },
          ],
        },
      });

      const decision = selectDecisionContext(manager.session);
      const option = findFirstPlayableOption(decision.availableActions, [
        'check',
      ]);
      const intent = buildIntentFromOption(
        decision.actor ?? 'player-a',
        option,
        manager.session.activeSnapshot.index,
        70_000,
      );

      const outcome = await manager.applyIntent(intent);
      expect(outcome.validation.kind).toBe('accepted');
      expect(outcome.hookErrors).toHaveLength(1);
      expect(outcome.hookErrors[0]?.stage).toBe('afterValidation');
      expect(manager.session.events).toHaveLength(1);

      const metrics: SessionMetrics = manager.session.metrics;
      const telemetry = updateSessionMetrics(
        metrics,
        { potDelta: 0 },
        { intentSamples: 0 },
      );
      expect(telemetry.metrics.handsDealt).toBe(metrics.handsDealt);
    });
  });
});

function sumPayouts(entries: readonly PayoutEntry[]): number {
  return entries.reduce((total, entry) => total + entry.amount, 0);
}

function createSessionConfig(
  maxSeats: SessionConfig['maxSeats'] = 6,
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
    autoAdvance: false,
  } satisfies SessionConfig;
}

function buildSeats(count: number): SeatBootstrapConfig[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    stack: 100,
    seatIndex: index,
    displayName: `Player ${index + 1}`,
  }));
}

function findFirstPlayableOption(
  options: readonly PlayerOption[],
  preferredOrder: readonly PlayerOption['type'][],
): PlayerOption {
  for (const type of preferredOrder) {
    const match = options.find(
      (option) => option.type === type && !option.disabled,
    );
    if (match) return match;
  }
  return options[0]!;
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
      };
    case 'check':
      return {
        id: `${actor}-check`,
        actor,
        requested: { type: 'check' } as const,
        issuedAt,
        origin: 'ui' as const,
        expectedSnapshotVersion: version,
      };
    case 'call':
      return {
        id: `${actor}-call`,
        actor,
        requested: { type: 'call', amount: option.amount } as const,
        issuedAt,
        origin: 'ui' as const,
        expectedSnapshotVersion: version,
      };
    case 'bet':
      return {
        id: `${actor}-bet`,
        actor,
        requested: { type: 'bet', amount: option.min } as const,
        issuedAt,
        origin: 'ui' as const,
        expectedSnapshotVersion: version,
      };
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
      };
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
      };
    default:
      return {
        id: `${actor}-fallback-fold`,
        actor,
        requested: { type: 'fold' } as const,
        issuedAt,
        origin: 'ui' as const,
        expectedSnapshotVersion: version,
      };
  }
}
