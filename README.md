# poker-engine-ts

The most complete open-source, event-sourced poker engine for production backends.

English | [简体中文](https://github.com/Ge-limin/poker-engine-ts/blob/main/README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/poker-engine-ts.svg)](https://www.npmjs.com/package/poker-engine-ts)
[![CI](https://github.com/Ge-limin/poker-engine-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/Ge-limin/poker-engine-ts/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

Explore the engine's features in the **[live playground](https://ge-limin.github.io/poker-engine-ts/)**. You can play a hand against bots, kill and rebuild a session from its event log, fork timelines at any decision point, and step through complex rule interactions, all using the public API.

## What it is

This library provides the machinery for running real poker hands inside a server application. At its core, it is a poker state machine. The most difficult part of building a poker engine is correctly managing state transitions: whose turn it is, which actions are legal, when a betting round ends, and how edge cases like a short all-in do—or do not—reopen the action.

This engine approaches that problem by modeling the game's rules as data and implementing the game state as a pure reduction over an append-only event log. This event-sourced architecture means the state machine's correctness can be verified by replaying a hand from its log, ensuring a rebuilt table state is identical to the live one. It also guarantees that complex scenarios, like multi-way side pots with unequal all-ins, are calculated correctly. Chip conservation is verified with property-based tests that run randomized action sequences, ensuring the math holds up in every scenario.

The underlying engine is variant-agnostic by design. The rules for dealing, betting, and showdown are defined in a `RuleSetDescriptor`. Today, it ships with a complete, well-tested implementation for Texas Hold'em (No-Limit, Pot-Limit, and Fixed-Limit). The core has just one runtime dependency (`@noble/hashes`) and is fully isomorphic, running identically in Node.js, browsers, and edge environments.

## Install

```bash
npm install poker-engine-ts
```

The core package is self-contained. Optional adapters for persistence and client-side integration can be installed and will only pull in their peer dependencies if you import them.

```bash
# Required only for poker-engine-ts/persistence/supabase
npm install @supabase/supabase-js

# Required only for poker-engine-ts/adapters/client
npm install react
```

The package is distributed as ESM with full TypeScript support via bundled `.d.ts` files.

## Quickstart

This example demonstrates running a complete hand, from table configuration to showdown, using the public API. All symbols shown are exported from the main package.

```ts
import {
  SessionManager,
  selectDecisionContext,
  selectTableView,
} from 'poker-engine-ts';
import type {
  Card,
  SeatBootstrapConfig,
  SessionConfig,
} from 'poker-engine-ts';

// Describe the table. bettingStructure: 'no-limit' | 'pot-limit' | 'fixed-limit'.
// autoAdvance lets the engine roll streets forward and settle on its own.
const config: SessionConfig = {
  tableVariant: 'texas-holdem',
  bettingStructure: 'no-limit',
  maxSeats: 2,
  startingStack: 100,
  blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
  personaPolicy: { defaultStyle: 'balanced' },
  ruleSet: {
    streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
    postingOrder: ['small-blind', 'big-blind'],
    minRaisePolicy: 'double-last-bet',
    showdownOrdering: 'high-card',
    cardDistribution: {
      holeCardsPerPlayer: 2,
      burnPerStreet: [0, 1, 1],
      communityReveal: [0, 3, 1, 1],
    },
  },
  evaluationPolicy: {
    engine: 'lookup-table',
    evaluatorId: 'default',
    supportsHiLo: false,
    cacheSize: 1024,
  },
  autoAdvance: true,
};

const seats: readonly SeatBootstrapConfig[] = [
  { playerId: 'hero', seatIndex: 0, stack: 100 },
  { playerId: 'villain', seatIndex: 1, stack: 100 },
];

// A fixed, ordered deck feeds the community board as streets auto-advance.
const deck: readonly Card[] = [
  'As', 'Ks', 'Qs', 'Js', 'Ts', '9s', '8s', '7s', '6s', '5s',
];

// The event log is the source of truth; the manager holds the reduced
// TableSnapshot plus checkpoints for replay.
const manager = SessionManager.create(config, seats, { deck });

// Drive the hand: ask the engine whose turn it is and what is legal, then
// submit one intent per decision. Checking and calling runs the board out.
for (let guard = 0; guard < 100; guard += 1) {
  const decision = selectDecisionContext(manager.session);
  if (!decision.actor) break; // nobody left to act: settled or run out

  const legal = decision.availableActions.filter((o) => !o.disabled);
  const choice =
    legal.find((o) => o.type === 'check') ??
    legal.find((o) => o.type === 'call');
  if (!choice) break;

  const result = await manager.applyIntent({
    id: `${decision.actor}-${guard}`,
    actor: decision.actor,
    requested:
      choice.type === 'call'
        ? { type: 'call', amount: choice.amount }
        : { type: 'check' },
    origin: 'ui',
    issuedAt: Date.now(),
    expectedSnapshotVersion: manager.session.activeSnapshot.index,
  });
  if (result.validation.kind !== 'accepted') {
    throw new Error(`intent rejected: ${result.validation.reason}`);
  }
}

const table = selectTableView(manager.session);
console.log('stage', manager.session.activeSnapshot.hand.stage); // 'showdown'
console.log('board', table.board.flop, table.board.turn, table.board.river);
console.log('pot  ', table.potTotal);
```

Note that `SessionManager.create` uses the provided deck for community cards but does not deal hole cards by default. In this check/call scenario, the hand resolves when only one player remains, without a card-based showdown. For hands that involve dealing hole cards and evaluating hand ranks, see the `generateRandomState` and `advanceRandomState` functions used in the playground. The runnable version of this example can be found at [`examples/quickstart.ts`](./examples/quickstart.ts) (`pnpm example:quickstart`).

## Demo

An interactive playground is available at [ge-limin.github.io/poker-engine-ts](https://ge-limin.github.io/poker-engine-ts/) and also runs locally from the [`examples/playground`](./examples/playground) directory. It showcases the engine's capabilities through its public API. The demo is organized into four tabs:

-   **Play a hand:** Play against three bots where every action is processed by `applyIntent`. You can terminate the session at any point and reconstruct it from the event log, with a field-by-field diff to prove the rebuilt state is identical.
-   **Replay and fork:** Scrub through any hand's timeline to see the table state at each decision. You can also fork the timeline by choosing a different legal action at any point, creating a new branch of history.
-   **Rules lab:** Observe a step-by-step demonstration of the tournament short all-in rule, where the option to raise is correctly disabled for subsequent players.
-   **Torture test:** Runs hands on a continuous loop, re-validating chip conservation invariants after every single action to ensure the system's integrity over thousands of hands.

To run the demo locally:

```bash
pnpm install
pnpm --filter playground dev
```

## Features

-   **Event-Sourced Architecture:** The append-only event log is the single source of truth. Table state is a pure reduction of events (`reduce(snapshot, event)`), which allows a session to be perfectly rehydrated from its log. This design also powers timeline features like `rewindTo` and `replaceFrom`. Events are versioned to ensure backward compatibility with older logs.
-   **Four Runtime Modes:** A single `RuntimeContext` supports four distinct operational modes—`live`, `replay`, `simulation`, and `scenario`—with typed runtime guards to prevent illegal state transitions.
-   **Correct Side Pot Calculation:** The `PotLedger` and `PayoutSummary` objects correctly manage and resolve complex multi-way all-in scenarios, ensuring each player is awarded the correct portion of the main and side pots.
-   **Custom Hand Evaluator:** The 7-card Texas Hold'em evaluator is hand-written for full control, with no external dependencies like `pokersolver` or `treys`.
-   **Property-Tested Chip Conservation:** We use `fast-check` to generate randomized sequences of actions, asserting that ledger invariants and chip totals are maintained through every state transition, including showdown and settlement. This provides strong guarantees about the correctness of the side-pot logic.
-   **Concurrent-Safe API:** Calls to `applyIntent` are serialized through an async mutex, ensuring that concurrent requests against a single session are handled safely and in order.
-   **Isomorphic Core:** The engine has only one runtime dependency (`@noble/hashes`) and runs the same code in Node.js, the browser, and edge computing environments.
-   **TypeScript-First:** The library is written in TypeScript and ships a complete type surface with its generated `.d.ts` declaration files.

## Optional adapters

The core engine is decoupled from persistence and UI concerns. The `SessionManager` interacts with a minimal `SessionRepository` interface (`get`, `set`, and optional hooks), which can be implemented with any database. `createServerSessionAdapter` is used to wire in your chosen implementation.

-   **poker-engine-ts/persistence/supabase**: Provides a concrete `SessionRepository` implementation for Supabase with `createSupabaseSessionRepository`, alongside helpers for hand history and realtime updates. This serves as a blueprint for other adapters (e.g., Postgres, Redis, or a local file system). Requires optional peer `@supabase/supabase-js`.
-   **poker-engine-ts/adapters/client**: Includes utilities for client-side applications, such as the `createClientSessionAdapter`, React hooks (`useSessionView`, `useScenarioTimeline`), and pure view helpers. Requires optional peer `react`.
-   **poker-engine-ts/testing**: A collection of in-memory helpers for writing tests and simulations, including `createSeededRandom` and `runHeadlessRandomState`.
-   **poker-engine-ts/format**: A dependency-free rendering layer that transforms engine output into human-readable text, suitable for everything from UI labels to a replayable event timeline.

## How this compares

The open-source poker ecosystem includes excellent tools for academic research and game-theory solving. This engine is different: it was built to do the unglamorous, load-bearing work of running live poker games in a production backend.

-   **PokerKit** (University of Toronto, IEEE Transactions on Games 2025) is the reference standard for simulation and hand notation, with support for over 14 variants. For academic research, offline analysis, or any work requiring the citable PHH notation format, PokerKit is the superior tool.

-   **rs-poker** is an advanced Rust toolkit for high-performance evaluation and solving, featuring ~20ns hand evaluations, CFR, ICM calculations, and PLO support. For building a solver or training a bot, rs-poker is the right choice, and this engine does not attempt to compete in that domain.

This library's focus is on the specific challenges of a live game server: maintaining an authoritative event log for replay and audits, ensuring correct side-pot arithmetic, offering a pluggable persistence layer for any database, and providing a core that behaves identically across server, browser, and edge environments.

## Scope

`poker-engine-ts` currently implements Texas Hold'em with no-limit, pot-limit, and fixed-limit betting structures, supporting tables of 2, 6, or 9 seats.

Beneath this single variant lies a generic engine for dealing, betting, all-in runouts, showdown, and persistence. The architecture is designed to be extensible; adding another community-card variant like Omaha would primarily involve implementing a new card-selection rule for the evaluator, as the surrounding interfaces are already in place.

## Testing

The library is extensively tested, with roughly as much test code (10.8k lines) as engine code (11.6k lines). A significant portion of this is dedicated to property-based testing with `fast-check`. These tests generate randomized sequences of player actions to validate invariants that must always hold true: the total chips in play never change, the pot ledger remains internally consistent, and chips are conserved through complex showdowns with unequal stacks. This rigorous testing provides a high degree of confidence in the logic that is most difficult to get right, such as the side-pot calculations in multi-way all-in situations.

## License

MIT. Copyright Limin.

Built by [liminge studio](https://liminge.space).
