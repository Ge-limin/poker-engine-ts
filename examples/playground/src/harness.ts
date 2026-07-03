// Live correctness harness: auto-play hands forever through the public API and
// re-check the chip-conservation invariant after every single step. This is the
// property test batch-s1 / settlement-conservation runs, made visible: total
// chips in play (every stack + every pot bucket) never changes, hand after hand.
import {
  advanceRandomState,
  generateRandomState,
  type RandomStateSummary,
  type SeatBootstrapConfig,
  type SessionConfig,
  type TableSnapshot,
} from 'poker-engine-ts';
import { createSeededRandom } from 'poker-engine-ts/testing';

// Fixed, unequal stacks: a stable table total (360) that still forms side pots
// when players get all in. Independent hands, so the total is the same to verify
// every hand.
const NAMES: Record<string, string> = { p1: 'Alice', p2: 'Bob', p3: 'Carol', p4: 'Dave' };
const STACKS: Record<string, number> = { p1: 60, p2: 100, p3: 80, p4: 120 };
const SEATS: readonly SeatBootstrapConfig[] = [
  { playerId: 'p1', seatIndex: 0, stack: STACKS.p1 },
  { playerId: 'p2', seatIndex: 1, stack: STACKS.p2 },
  { playerId: 'p3', seatIndex: 2, stack: STACKS.p3 },
  { playerId: 'p4', seatIndex: 3, stack: STACKS.p4 },
];
const HAND_TOTAL = Object.values(STACKS).reduce((a, b) => a + b, 0);

const config: SessionConfig = {
  tableVariant: 'texas-holdem',
  bettingStructure: 'no-limit',
  maxSeats: 6,
  startingStack: 120,
  blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
  antePolicy: undefined,
  personaPolicy: { defaultStyle: 'balanced' },
  ruleSet: {
    streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
    postingOrder: ['small-blind', 'big-blind'],
    minRaisePolicy: 'double-last-bet',
    cardDistribution: { holeCardsPerPlayer: 2, burnPerStreet: [1, 1, 1], communityReveal: [0, 3, 1, 1] },
    showdownOrdering: 'high-card',
  },
  evaluationPolicy: { engine: 'lookup-table', evaluatorId: 'default', supportsHiLo: false, cacheSize: 1024 },
  simulationPolicy: undefined,
  autoAdvance: true,
};

export const nameOf = (id: string): string => NAMES[id] ?? id;

function chipsInPlay(s: TableSnapshot): number {
  const stacks = s.seating.seats.reduce((sum, seat) => sum + seat.stack, 0);
  const sides = s.pots.sides.reduce((sum, p) => sum + p.amount, 0);
  return stacks + s.pots.main.amount + s.pots.rake + sides;
}

export interface HarnessSeat {
  readonly id: string;
  readonly name: string;
  readonly stack: number;
  readonly committed: number;
  readonly isAllIn: boolean;
  readonly folded: boolean;
  readonly isActor: boolean;
  readonly won?: number;
}

export interface HarnessPot {
  readonly label: string;
  readonly amount: number;
  readonly eligible: readonly string[];
}

export interface HarnessView {
  readonly hands: number;
  readonly steps: number;
  readonly checks: number;
  readonly violations: number;
  readonly chipsNow: number;
  readonly handTotal: number;
  readonly conserved: boolean;
  readonly stage: string;
  readonly settled: boolean;
  readonly board: readonly string[];
  readonly seats: readonly HarnessSeat[];
  readonly pots: readonly HarnessPot[];
  readonly potTotal: number;
  readonly events: readonly { actor: string; action: string; amount: number }[];
}

export interface Harness {
  step(): Promise<void>;
  view(): HarnessView;
}

export async function createHarness(seed: number): Promise<Harness> {
  const rng = createSeededRandom(seed);
  let summary: RandomStateSummary = await generateRandomState({
    config,
    seats: SEATS,
    random: rng,
    steps: { min: 0, max: 0 },
  });
  let hands = 1;
  let steps = 0;
  let checks = 0;
  let violations = 0;
  let handOver = false;

  const record = () => {
    checks += 1;
    if (chipsInPlay(summary.session.activeSnapshot) !== HAND_TOTAL) {
      violations += 1;
    }
  };
  record();

  async function step(): Promise<void> {
    try {
      if (handOver) {
        summary = await generateRandomState({ config, seats: SEATS, random: rng, steps: { min: 0, max: 0 } });
        hands += 1;
        handOver = false;
        record();
        return;
      }
      const before = summary.session.activeSnapshot.index;
      summary = await advanceRandomState(summary.session, { random: rng, steps: { min: 1, max: 1 } });
      steps += 1;
      record();
      const snap = summary.session.activeSnapshot;
      if (snap.index === before || snap.hand.stage === 'settled') {
        handOver = true;
      }
    } catch {
      // A genuine engine exception must not hide behind the "violations stay at
      // zero" claim, so count it as a violation (it will show on screen) before
      // recovering with a fresh hand rather than wedging the demo. In normal
      // operation the engine never throws here; the property tests drive
      // thousands of hands through these same calls without one.
      violations += 1;
      summary = await generateRandomState({ config, seats: SEATS, random: rng, steps: { min: 0, max: 0 } });
      hands += 1;
      handOver = false;
      record();
    }
  }

  function view(): HarnessView {
    const snap = summary.session.activeSnapshot;
    const settled = snap.hand.stage === 'settled';
    const board = [
      ...(snap.cards.community.flop ?? []),
      ...(snap.cards.community.turn ? [snap.cards.community.turn] : []),
      ...(snap.cards.community.river ? [snap.cards.community.river] : []),
    ];
    const buckets = [snap.pots.main, ...snap.pots.sides];
    const foldedSet = new Set<string>();
    for (const round of snap.hand.bettingRounds) {
      for (const turn of round.turns) {
        if (turn.action.type === 'fold') foldedSet.add(turn.actor);
      }
    }
    const wonBy = new Map<string, number>();
    for (const p of snap.hand.payouts?.entries ?? []) {
      wonBy.set(p.playerId, (wonBy.get(p.playerId) ?? 0) + p.amount);
    }
    const actor = snap.clock.currentActor;
    const seats: HarnessSeat[] = snap.seating.seats
      .filter((seat) => seat.occupant)
      .map((seat) => {
        const id = seat.occupant!.playerId;
        const committed = buckets.reduce((sum, b) => sum + (b.contributions[id] ?? 0), 0);
        return {
          id,
          name: nameOf(id),
          stack: seat.stack,
          committed,
          isAllIn: seat.stack === 0 && !foldedSet.has(id),
          folded: foldedSet.has(id),
          isActor: id === actor,
          won: settled ? wonBy.get(id) : undefined,
        } satisfies HarnessSeat;
      });
    const pots: HarnessPot[] = buckets
      .filter((b) => b.amount > 0)
      .map((b, i) => ({
        label: i === 0 ? 'Main' : `Side ${i}`,
        amount: b.amount,
        eligible: [...b.eligiblePlayers],
      }));
    const events = summary.session.events.map((env) => ({
      actor: env.event.actor,
      action: env.event.action.type,
      amount: env.event.contribution,
    }));
    const chipsNow = chipsInPlay(snap);
    return {
      hands,
      steps,
      checks,
      violations,
      chipsNow,
      handTotal: HAND_TOTAL,
      conserved: chipsNow === HAND_TOTAL,
      stage: snap.hand.stage,
      settled,
      board,
      seats,
      pots,
      potTotal: pots.reduce((sum, p) => sum + p.amount, 0),
      events,
    };
  }

  return { step, view };
}
