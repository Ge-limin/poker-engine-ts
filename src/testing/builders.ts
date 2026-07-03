import { createPersonaProfile } from '../persona/baseline';
import type { TurnIntent } from '../types/events';
import type { PersonaMatrix } from '../types/persona';
import type {
  ActionClock,
  BettingRound,
  CardLedger,
  HandFlags,
  HandLedger,
  PlayerRef,
  PotLedger,
  Seat,
  SeatingChart,
  TableSnapshot,
} from '../types/snapshot';

interface PlayerConfig {
  readonly id: string;
  readonly stack: number;
  readonly displayName?: string;
}

interface SnapshotBuilderOptions {
  readonly handId?: string;
  readonly handStage?: HandLedger['stage'];
  readonly players?: readonly PlayerConfig[];
  readonly buttonIndex?: number;
}

export function createTableSnapshot(
  options: SnapshotBuilderOptions = {},
): TableSnapshot {
  const players = options.players ?? [
    { id: 'player-a', stack: 100 },
    { id: 'player-b', stack: 100 },
  ];
  const buttonIndex = options.buttonIndex ?? 0;

  const seats: Seat[] = players.map((player, index) => ({
    index,
    occupant: createPlayerRef(player),
    status: 'occupied',
    stack: player.stack,
  }));

  const seating: SeatingChart = {
    dealerButton: buttonIndex,
    seats,
  };

  const bettingRound: BettingRound = {
    stage: options.handStage ?? 'preflop',
    turnOrder: seats.map((seat) => seat.index),
    turns: [],
    roundPot: 0,
    highestBet: 0,
  };

  const hand: HandLedger = {
    id: options.handId ?? 'hand-1',
    stage: options.handStage ?? 'preflop',
    deckSeed: 'seed-1',
    buttonSeat: buttonIndex,
    blinds: {
      smallBlind: { playerId: players[0]?.id ?? 'player-a', amount: 1 },
      bigBlind: { playerId: players[1]?.id ?? 'player-b', amount: 2 },
    },
    ante: null,
    bettingRounds: [bettingRound],
  };

  const pots: PotLedger = {
    main: {
      id: 'main',
      amount: 0,
      eligiblePlayers: players.map((player) => player.id),
      contributions: createEmptyRecord(players),
    },
    sides: [],
    rake: 0,
  };

  const cards: CardLedger = {
    remainingDeck: [],
    burnPile: [],
    community: {
      revealSchedule: [],
    },
    holeCards: createNullHoleCards(players),
  };

  const personas: PersonaMatrix = {
    entries: createPersonaMatrix(players),
  };

  const clock: ActionClock = {
    currentActor: players[0]?.id,
    deadline: undefined,
    perTurnMs: 0,
    bankMs: createNumberRecord(players, 0),
    pauses: [],
  };

  const flags: HandFlags = {
    showdownLocked: false,
    autoRunout: false,
    pendingEliminations: [],
    rebuyAvailable: false,
    advisoryPending: false,
    recoveryMode: false,
  };

  return {
    index: 1,
    handNumber: 1,
    seating,
    hand,
    pots,
    cards,
    personas,
    clock,
    flags,
  };
}

export function createTurnIntent(
  partial: Partial<TurnIntent> = {},
): TurnIntent {
  return {
    id: partial.id ?? 'intent-1',
    actor: partial.actor ?? 'player-a',
    requested: partial.requested ?? { type: 'check' },
    amount: partial.amount,
    issuedAt: partial.issuedAt ?? Date.now(),
    origin: partial.origin ?? 'ui',
    latencyMs: partial.latencyMs,
    expectedSnapshotVersion: partial.expectedSnapshotVersion,
  };
}

function createPlayerRef(player: PlayerConfig): PlayerRef {
  return {
    playerId: player.id,
    displayName: player.displayName ?? player.id,
  };
}

function createEmptyRecord(
  players: readonly PlayerConfig[],
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const player of players) {
    record[player.id] = 0;
  }
  return record;
}

function createNullHoleCards(
  players: readonly PlayerConfig[],
): Record<string, null> {
  const record: Record<string, null> = {};
  for (const player of players) {
    record[player.id] = null;
  }
  return record;
}

function createPersonaMatrix(
  players: readonly PlayerConfig[],
): PersonaMatrix['entries'] {
  const entries: PersonaMatrix['entries'] = {};
  const timestamp = Date.now();
  for (const player of players) {
    entries[player.id] = createPersonaProfile('balanced', timestamp);
  }
  return entries;
}

function createNumberRecord(
  players: readonly PlayerConfig[],
  initial: number,
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const player of players) {
    record[player.id] = initial;
  }
  return record;
}
