import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  rebuildPotLedger,
  reduce,
  toSnapshotEnvelope,
  toTurnEventEnvelope,
  validateIntent,
} from '../../index';
import type {
  ActionClock,
  HandFlags,
  PersonaMatrix,
  TableSnapshot,
  TurnEvent,
  TurnIntent,
} from '../../types/index';

const PERSONAS: PersonaMatrix = {
  entries: {
    playerA: createPersonaProfile(),
    playerB: createPersonaProfile(),
    playerC: createPersonaProfile(),
  },
};

const BASE_FLAGS: HandFlags = {
  showdownLocked: false,
  autoRunout: false,
  pendingEliminations: [],
  rebuyAvailable: true,
  advisoryPending: false,
  recoveryMode: false,
};

const BASE_CLOCK: ActionClock = {
  currentActor: 'playerA',
  deadline: undefined,
  perTurnMs: 20000,
  bankMs: {
    playerA: 60000,
    playerB: 60000,
    playerC: 60000,
  },
  pauses: [],
};

describe('Phase 2 validation and reduction', () => {
  test('rejects intents when actor mismatches the action clock', () => {
    const snapshot = buildPreflopSnapshot();
    const intent: TurnIntent = {
      id: 'intent-1',
      actor: 'playerB',
      requested: { type: 'call', amount: 0 },
      issuedAt: 1,
      origin: 'ui',
    };

    const result = validateIntent(snapshot, intent);
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('not-actors-turn');
    }
  });

  test('accepts a call, updates the state, and advances the action clock', () => {
    const snapshot = buildPreflopSnapshot();
    const intent: TurnIntent = {
      id: 'intent-call',
      actor: 'playerA',
      requested: { type: 'call', amount: 0 },
      issuedAt: 2,
      origin: 'ui',
    };

    const validation = validateIntent(snapshot, intent);
    expect(validation.kind).toBe('accepted');
    if (validation.kind !== 'accepted') return;

    const event = validation.event;
    expect(event.contribution).toBe(2);
    expect(event.stackAfter).toBe(98);

    const reduced = reduce(snapshot, event);
    const utgSeat = reduced.seating.seats.find(
      (seat) => seat.occupant?.playerId === 'playerA',
    );
    if (!utgSeat) {
      throw new Error('UTG seat missing');
    }
    expect(utgSeat.stack).toBe(98);
    const currentRound = reduced.hand.bettingRounds[0];
    if (!currentRound) {
      throw new Error('Missing betting round');
    }
    expect(currentRound.roundPot).toBe(5);
    expect(reduced.pots.main.amount).toBe(5);
    expect(reduced.clock.currentActor).toBe('playerB');
    const expectedDeadline = intent.issuedAt + BASE_CLOCK.perTurnMs;
    expect(reduced.clock.deadline).toBe(expectedDeadline);
  });

  test('enforces minimum raise sizing and accepts a legal raise', () => {
    const snapshot = buildPreflopSnapshot();

    const tooSmall: TurnIntent = {
      id: 'intent-raise-small',
      actor: 'playerA',
      requested: { type: 'raise', amount: 1, to: 3 },
      issuedAt: 3,
      origin: 'ui',
    };
    const rejected = validateIntent(snapshot, tooSmall);
    expect(rejected.kind).toBe('rejected');

    const legal: TurnIntent = {
      id: 'intent-raise-legal',
      actor: 'playerA',
      requested: { type: 'raise', to: 6, amount: 4 },
      issuedAt: 4,
      origin: 'ui',
    };
    const accepted = validateIntent(snapshot, legal);
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') return;
    expect(accepted.event.contribution).toBe(6);
  });

  test('splits pots when a short stack calls all-in', () => {
    const snapshot = buildShortStackSnapshot();

    const raiseIntent: TurnIntent = {
      id: 'raise',
      actor: 'playerA',
      requested: { type: 'raise', to: 30, amount: 28 },
      issuedAt: 10,
      origin: 'ui',
    };
    const raise = validateIntent(snapshot, raiseIntent);
    expect(raise.kind).toBe('accepted');
    if (raise.kind !== 'accepted') return;
    const afterRaise = reduce(snapshot, raise.event);

    const callIntent: TurnIntent = {
      id: 'call-short',
      actor: 'playerB',
      requested: { type: 'call', amount: 0 },
      issuedAt: 11,
      origin: 'ui',
    };
    const shortCall = validateIntent(afterRaise, callIntent);
    expect(shortCall.kind).toBe('accepted');
    if (shortCall.kind !== 'accepted') return;
    const afterShortCall = reduce(afterRaise, shortCall.event);

    const defendIntent: TurnIntent = {
      id: 'call-big',
      actor: 'playerC',
      requested: { type: 'call', amount: 0 },
      issuedAt: 12,
      origin: 'ui',
    };
    const defend = validateIntent(afterShortCall, defendIntent);
    expect(defend.kind).toBe('accepted');
    if (defend.kind !== 'accepted') return;
    const updated = reduce(afterShortCall, defend.event);

    expect(updated.pots.main.amount).toBe(45);
    expect(updated.pots.main.contributions).toEqual({
      playerA: 15,
      playerB: 15,
      playerC: 15,
    });

    expect(updated.pots.sides).toHaveLength(1);
    const sidePot = updated.pots.sides[0];
    if (!sidePot) {
      throw new Error('Expected side pot');
    }
    expect(sidePot.amount).toBe(30);
    expect([...sidePot.eligiblePlayers].sort()).toEqual(['playerA', 'playerC']);
  });

  test('keeps total contributions stable when rebuilding pots', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 4 }),
          fc.integer({ min: 0, max: 200 }),
        ),
        (dictionary) => {
          const contributions = new Map<string, number>();
          let expectedTotal = 0;
          for (const [playerId, amount] of Object.entries(dictionary)) {
            if (amount <= 0) continue;
            contributions.set(playerId, amount);
            expectedTotal += amount;
          }

          const ledger = rebuildPotLedger({
            contributions,
            foldedPlayers: new Set(),
          });

          const ledgerTotal =
            ledger.main.amount +
            ledger.sides.reduce((acc, bucket) => acc + bucket.amount, 0);

          expect(ledgerTotal).toBe(expectedTotal);
        },
      ),
    );
  });

  test('wraps turn events and snapshots into versioned envelopes', () => {
    const snapshot = buildPreflopSnapshot();
    const snapshotEnvelope = toSnapshotEnvelope(snapshot);
    expect(snapshotEnvelope.envelopeVersion).toBe(1);

    const intent: TurnIntent = {
      id: 'env',
      actor: 'playerA',
      requested: { type: 'call', amount: 0 },
      issuedAt: 20,
      origin: 'ui',
    };
    const validation = validateIntent(snapshot, intent);
    expect(validation.kind).toBe('accepted');
    if (validation.kind !== 'accepted') return;

    const eventEnvelope = toTurnEventEnvelope(validation.event);
    expect(eventEnvelope.envelopeVersion).toBe(1);
    expect(eventEnvelope.event.actor).toBe('playerA');
  });
});

function buildPreflopSnapshot(): TableSnapshot {
  return {
    index: 0,
    handNumber: 1,
    seating: {
      dealerButton: 3,
      seats: [
        {
          index: 1,
          occupant: { playerId: 'playerA', displayName: 'Player A' },
          status: 'occupied',
          stack: 100,
        },
        {
          index: 2,
          occupant: { playerId: 'playerB', displayName: 'Player B' },
          status: 'occupied',
          stack: 79,
        },
        {
          index: 3,
          occupant: { playerId: 'playerC', displayName: 'Player C' },
          status: 'occupied',
          stack: 58,
        },
      ],
    },
    hand: {
      id: 'hand-1',
      stage: 'preflop',
      deckSeed: 'seed-1',
      buttonSeat: 3,
      blinds: {
        smallBlind: { playerId: 'playerB', amount: 1 },
        bigBlind: { playerId: 'playerC', amount: 2 },
      },
      ante: null,
      bettingRounds: [
        {
          stage: 'preflop',
          turnOrder: [1, 2, 3],
          turns: [
            createBlindTurn('playerB', 'small', 80, 79, 1),
            createBlindTurn('playerC', 'big', 60, 58, 2),
          ],
          roundPot: 3,
          highestBet: 2,
          lastAggressor: 'playerC',
        },
      ],
      showdown: undefined,
      payouts: undefined,
    },
    pots: {
      main: {
        id: 'pot-main-0',
        amount: 3,
        eligiblePlayers: ['playerB', 'playerC'],
        contributions: {
          playerB: 1,
          playerC: 2,
        },
      },
      sides: [],
      rake: 0,
    },
    cards: {
      remainingDeck: [],
      burnPile: [],
      community: { revealSchedule: [] },
      holeCards: {
        playerA: null,
        playerB: null,
        playerC: null,
      },
    },
    personas: PERSONAS,
    clock: BASE_CLOCK,
    flags: BASE_FLAGS,
  } satisfies TableSnapshot;
}

function buildShortStackSnapshot(): TableSnapshot {
  const snapshot = buildPreflopSnapshot();
  return {
    ...snapshot,
    seating: {
      dealerButton: snapshot.seating.dealerButton,
      seats: [
        {
          index: 1,
          occupant: { playerId: 'playerA', displayName: 'Player A' },
          status: 'occupied',
          stack: 200,
        },
        {
          index: 2,
          occupant: { playerId: 'playerB', displayName: 'Player B' },
          status: 'occupied',
          stack: 14,
        },
        {
          index: 3,
          occupant: { playerId: 'playerC', displayName: 'Player C' },
          status: 'occupied',
          stack: 118,
        },
      ],
    },
    hand: {
      ...snapshot.hand,
      bettingRounds: [
        {
          stage: 'preflop',
          turnOrder: [1, 2, 3],
          turns: [
            createBlindTurn('playerB', 'small', 15, 14, 1),
            createBlindTurn('playerC', 'big', 120, 118, 2),
          ],
          roundPot: 3,
          highestBet: 2,
          lastAggressor: 'playerC',
        },
      ],
    },
    pots: {
      main: {
        id: 'pot-main-0',
        amount: 3,
        eligiblePlayers: ['playerB', 'playerC'],
        contributions: {
          playerB: 1,
          playerC: 2,
        },
      },
      sides: [],
      rake: 0,
    },
    clock: {
      ...snapshot.clock,
      currentActor: 'playerA',
    },
  } satisfies TableSnapshot;
}

function createBlindTurn(
  actor: 'playerB' | 'playerC',
  blind: 'small' | 'big',
  stackBefore: number,
  stackAfter: number,
  amount: number,
): TurnEvent {
  return {
    id: `blind-${blind}-${actor}`,
    actor,
    action: { type: 'post-blind', blind, amount },
    legalOptions: [],
    stackBefore,
    stackAfter,
    contribution: amount,
    timestamp: 0,
    metadata: {
      engineVersion: 'seed',
      availableActionsAtDecision: [],
    },
  } satisfies TurnEvent;
}

function createPersonaProfile(): PersonaMatrix['entries'][number] {
  return {
    style: 'balanced',
    aggression: 50,
    tightness: 50,
    bluffIndex: 50,
    riskTolerance: 50,
    adaptation: {
      trackedMetrics: {
        vpip: 0,
        pfr: 0,
        aggressionFactor: 0,
        showdownRate: 0,
      },
      lastUpdated: 0,
      featureVector: [],
    },
  };
}
