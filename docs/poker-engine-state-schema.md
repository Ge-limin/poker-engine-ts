# Poker Engine State Schema

This document describes the engine's core state model: the `Session` aggregate,
the immutable event log, the derived `TableSnapshot`, and the ledgers that make up
a hand. It is the reference for how state is shaped and how it moves.

## Concept

- **Runtime Session**: a transient in-memory aggregate that owns the reducer
  inputs, cached snapshot, metrics, and observers while a hand is in progress.
- **Persistent storage**: a persistence adapter retains the immutable
  `initialSnapshot` plus the append-only event log. To reconstruct a `Session`,
  the backend loads those records and replays the events in order. Persistence is
  a pluggable interface; a Supabase adapter ships as an optional subpath.

## Design goals

1. **Deterministic state transitions**: every change to game state is captured as
   an immutable event, so the table can be reconstructed at any point.
2. **Single source of truth**: the authoritative state lives in one normalized
   structure, with computed views derived for presentation and decisions.
3. **Explicit boundaries**: rules, presentation, and persistence are separate
   concerns; the reducer only knows the rules.
4. **First-class personas**: persona profiles live in a dedicated capability
   model rather than ad-hoc fields on players.
5. **Audit-ready telemetry**: every hand keeps the metadata needed for analytics,
   debugging, and compliance.

## Top-level overview

```
Session
├── initialSnapshot (TableSnapshot at index 0)
├── events (immutable TurnEvent[])
└── activeSnapshot (derived TableSnapshot)
    ├── SeatingChart
    ├── HandLedger
    │   └── BettingRound
    │       └── TurnEvent
    ├── PotLedger
    ├── CardLedger
    └── PersonaMatrix
```

- `Session` is the runtime shell tying together configuration, the event log, and
  observers.
- Player-facing state is derived by replaying `events` against `initialSnapshot`,
  then caching the result in `activeSnapshot` for fast reads.
- `TurnEvent`s are the single source of truth; the reducer applies them to
  materialize snapshots, and `EngineHooks` provide opt-in extensibility without
  reaching into the core reducer.

## Cross-layer responsibilities

Durability, performance, and correctness depend on each tier owning a narrow slice
of state.

### Storage

- **Durable source of truth**: persist the immutable history that can recreate any
  table state: the canonical `initialSnapshot` plus an append-only `TurnEvent`
  log. Derived snapshots are never the system of record.
- **Auditability**: because the log is immutable, downstream analytics and
  compliance tooling get a tamper-evident record of every action without
  duplicating reducer logic.

### Backend

- **Authoritative computation**: hydrate a `Session` by replaying `TurnEvent`s over
  the stored `initialSnapshot`, then cache the resulting `activeSnapshot` for hot
  paths. Only new, validated `TurnEvent`s are appended.
- **Broadcast full snapshots**: fan out refreshed `TableSnapshot`s (or read views
  such as `TableView`) on every change. Do not emit diffs; clients replace their
  prior snapshot with the latest authoritative copy.
- **Historical replay**: derive requested frames server-side from the event log, so
  historical views never depend on client caches.

### Frontend

- **Immutable reception**: treat received snapshots as read-only and replace them
  wholesale rather than mutating.
- **Separation of concerns**: UI formats data, runs animations, and queues intents,
  but never recomputes pot totals, stack movements, or other reducer work.
- **Read-only replay caching**: an optional in-memory cache keyed by event index can
  accelerate scrubbing, but it is a hint, not an authority: the first access to any
  historical frame comes from the backend, and live updates never mutate cached
  history.

## Entity catalogue

### Session

| Field | Type | Description |
| --- | --- | --- |
| `id` | `UUID` | Distinguishes concurrent sessions (tables, test harnesses). |
| `config` | `SessionConfig` | Static parameters (stakes, blind schedule, seat count, persona policy). |
| `runtimeContext` | `RuntimeContext` | Discriminated union selecting live / replay / simulation / scenario behavior. |
| `initialSnapshot` | `TableSnapshot` | Baseline state (index 0) before any events are applied. |
| `events` | `TurnEvent[]` | Append-only log of immutable events that reconstruct the table. |
| `activeSnapshot` | `TableSnapshot` | Cached snapshot derived from `initialSnapshot` + `events`. |
| `metrics` | `SessionMetrics` | Running aggregates (hands dealt, pots awarded, latencies). |
| `channels` | `SessionChannels` | Observability endpoints (realtime topic, analytics sink, replay queue, advisor bridge). |
| `hooks` | `EngineHooks` | Optional plugin callbacks for logging, simulation, or extensions. |

### SessionConfig

```ts
interface SessionConfig {
  tableVariant: 'texas-holdem';
  bettingStructure: 'no-limit' | 'pot-limit' | 'fixed-limit';
  maxSeats: 2 | 6 | 9;
  startingStack: number;
  blindSchedule: BlindLevel[];
  antePolicy?: AntePolicy;
  personaPolicy: PersonaPolicy;
  ruleSet: RuleSetDescriptor;
  evaluationPolicy: EvaluationPolicy;
  simulationPolicy?: SimulationPolicy;
  autoAdvance: boolean;
}

interface PersonaPolicy {
  defaultStyle: PersonaArchetype;
  fallbackStyle?: PersonaArchetype;
  overrides?: Record<PlayerId, PersonaArchetype>;
}
```

Splitting structural rules (`ruleSet`, `bettingStructure`) from runtime values keeps
the reducer focused on gameplay. The engine ships a lookup-table evaluator;
`evaluationPolicy` and `simulationPolicy` are the extension points that make the
evaluator and simulation surfaces explicit, so an alternative engine (for example a
Monte Carlo evaluator) can be selected by configuration rather than by editing
control flow.

### RuleSetDescriptor & EvaluationPolicy

```ts
interface RuleSetDescriptor {
  streets: HandStage[]; // e.g. ['preflop', 'flop', 'turn', 'river', 'showdown']
  postingOrder: ('small-blind' | 'big-blind' | 'straddle' | 'ante')[];
  minRaisePolicy: 'double-last-bet' | 'fixed-increment' | 'pot-limit';
  maxRaisePolicy?: 'pot' | 'all-in';
  cardDistribution: DistributionRule;
  showdownOrdering: 'high-card' | 'lowball' | 'hi-lo';
}

interface DistributionRule {
  holeCardsPerPlayer: number;
  burnPerStreet: number[]; // aligns with streets
  communityReveal: number[]; // cards exposed per street
}

interface EvaluationPolicy {
  engine: 'lookup-table' | 'monte-carlo' | 'hybrid';
  evaluatorId: string;
  supportsHiLo: boolean;
  cacheSize: number;
}

interface SimulationPolicy {
  maxIterations: number;
  convergenceEpsilon: number;
  supportsPartialInformation: boolean;
  scenarioHooks?: SimulationHookDescriptor[];
}

interface SimulationHookDescriptor {
  id: string;
  trigger: 'preflop' | 'postflop' | 'river' | 'showdown';
  payloadSchema: Record<string, unknown>;
}
```

The street map and card-distribution rules live in configuration, so the same
reducer drives no-limit, pot-limit, and fixed-limit hold'em by swapping data rather
than code paths.

### TableSnapshot

| Field | Type | Description |
| --- | --- | --- |
| `index` | number | Monotonic snapshot counter; the first applied event advances it from 0. |
| `handNumber` | number | Sequential identifier for the current hand. |
| `seating` | `SeatingChart` | Seat assignments in order. |
| `hand` | `HandLedger` | Full state of the current hand. |
| `pots` | `PotLedger` | Main pot and side pots. |
| `cards` | `CardLedger` | Deck, burn pile, and community exposure. |
| `personas` | `PersonaMatrix` | Resolved persona profile per seat. |
| `clock` | `ActionClock` | Turn timers, time banks, and pending deadlines. |
| `flags` | `HandFlags` | Derived flags (showdown locked, auto-runout, and so on). |

### SeatingChart

```ts
interface SeatingChart {
  dealerButton: SeatIndex;
  seats: Seat[];
}

interface Seat {
  index: SeatIndex;
  occupant?: PlayerRef;
  status: 'open' | 'reserved' | 'occupied' | 'leaving';
  stack: Stack; // chips at rest, excluding what is committed to pots
  rebuyTokens?: number;
}
```

Seats stay stable even when the occupant changes (rebuy, reconnection, substitution),
so position and continuity survive between hands.

### Player & persona

```ts
interface PlayerRef {
  playerId: string;
  displayName: string;
  avatarUrl?: string;
  personaId?: string;
}

interface PersonaMatrix {
  entries: Record<PlayerId, PersonaProfile>;
}

interface PersonaProfile {
  personaId?: PersonaId;
  style: PersonaArchetype;
  aggression: number; // 0-100
  tightness: number; // 0-100
  bluffIndex: number; // 0-100
  riskTolerance: number; // 0-100
  adaptation: PersonaAdaptation;
}

interface PersonaAdaptation {
  trackedMetrics: PersonaTelemetry;
  lastUpdated: number;
  featureVector: number[]; // normalized inputs for agents
  notes?: string;
}

interface PersonaTelemetry {
  vpip: number;
  pfr: number;
  aggressionFactor: number;
  showdownRate: number;
  tiltIndicator?: number;
}
```

Persona metadata is centralized and normalized to percentages, so opponent
statistics (VPIP, aggression, tilt) are consistent for UI binding and analytics.

### HandLedger

```ts
interface HandLedger {
  id: string; // deterministic id seeded by session + handNumber
  stage: HandStage; // deal, preflop, flop, turn, river, showdown, settled
  deckSeed: string; // RNG seed used to build the CardLedger
  buttonSeat: SeatIndex;
  blinds: BlindPosting;
  ante: AntePosting | null;
  bettingRounds: BettingRound[];
  showdown?: ShowdownSummary;
  payouts?: PayoutSummary;
}
```

`HandLedger` is intentionally verbose so any reducer can reconstruct the state even
when cards or bets are replayed later.

```ts
interface ShowdownSummary {
  evaluatedHands: EvaluatedHand[];
  board: Card[];
  evaluatorId: string;
  equities?: EquityBreakdown[];
}

interface EvaluatedHand {
  playerId: PlayerId;
  rankClass: string; // e.g. 'flush'
  rankValue: number; // comparable integer
  bestFive: Card[];
  kickers: Card[];
}

interface EquityBreakdown {
  playerId: PlayerId;
  winPct: number;
  tiePct: number;
  lossPct: number;
  iterations: number;
}

interface PayoutSummary {
  entries: PayoutEntry[];
  rake?: number;
}

interface PayoutEntry {
  playerId: PlayerId;
  amount: number;
  potIds: string[]; // which pot buckets funded this award
}
```

Capturing both the deterministic evaluator output and optional simulation equities
lets analysis compare ground-truth ranks with probabilistic forecasts from the same
ledger entry.

### Actions, options & TurnEvent

Players submit **intents**; the reducer validates them into authoritative
**events**. Actions and legal options are discriminated unions:

```ts
type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call'; amount: number; isAllIn?: boolean }
  | { type: 'bet'; amount: number; isAllIn?: boolean }
  | { type: 'raise'; amount: number; to?: number; isAllIn?: boolean }
  | { type: 'all-in'; amount: number; from: 'bet' | 'call' | 'raise' }
  | { type: 'post-blind'; blind: 'small' | 'big' | 'straddle'; amount: number }
  | { type: 'post-ante'; amount: number }
  | { type: 'timeout'; fallback: 'fold' | 'check' }
  | { type: 'resume' };

type PlayerOption =
  | { type: 'fold'; disabled?: boolean }
  | { type: 'check'; disabled?: boolean }
  | { type: 'call'; amount: number; disabled?: boolean }
  | { type: 'bet'; min: number; max: number; increment: number; disabled?: boolean }
  | { type: 'raise'; min: number; max: number; increment: number; disabled?: boolean }
  | { type: 'all-in'; amount: number; disabled?: boolean };
```

```ts
interface BettingRound {
  stage: HandStage;
  turnOrder: SeatIndex[];
  turns: TurnEvent[];
  roundPot: number; // total committed this round
  highestBet: number; // running max, enforces min-raise logic
  lastAggressor?: PlayerId;
}

interface TurnEvent {
  id: string; // unique, chronologically sortable
  actor: PlayerId;
  action: PlayerAction;
  legalOptions: PlayerOption[]; // captured for audit and training
  stackBefore: number;
  stackAfter: number;
  contribution: number; // chips moved from stack to pot this turn
  timestamp: number;
  metadata?: TurnMetadata;
}
```

Storing the legal options with every turn retains the validation context, so replays
are never ambiguous about what was allowed at the time.

### TurnIntent & ValidationResult

```ts
interface TurnIntent {
  id: string;
  actor: PlayerId;
  requested: PlayerAction;
  amount?: number;
  issuedAt: number;
  origin: 'ui' | 'ai' | 'automation';
  latencyMs?: number;
  expectedSnapshotVersion?: number; // optimistic concurrency guard
}

type ValidationResult =
  | { kind: 'accepted'; event: TurnEvent; warnings?: ValidationWarning[] }
  | { kind: 'rejected'; reason: string; recovery?: RecoveryDirective };

interface ValidationWarning {
  code: 'timeout_soft' | 'misclick_protection' | 'auto_muck';
  message: string;
}

interface RecoveryDirective {
  advise: 'retry' | 'stand_pat' | 'auto_fold';
  substitution?: PlayerId;
}
```

Making the intent envelope explicit keeps human intents, automation, and AI retries
from racing each other.

### Versioned payload contracts

```ts
interface TurnEventEnvelope {
  envelopeVersion: number;
  event: TurnEvent;
}

interface SnapshotEnvelope<TSnapshot = unknown> {
  envelopeVersion: number;
  snapshot: TSnapshot;
}

type Upcaster<TTarget> = (legacy: unknown) => TTarget;
```

Persisted artifacts ship inside versioned envelopes so the engine can evolve without
invalidating stored hands. The reducer reads an envelope, looks up an `Upcaster` for
its version, and normalizes the payload before replay continues, so a log written
against an older shape still loads. Bump the envelope version whenever a breaking
shape change lands.

### EngineHooks & observers

```ts
type HookCollection<TPayload> =
  | HookRegistration<TPayload>
  | HookRegistration<TPayload>[];

interface EngineHooks {
  beforeIntent?: HookCollection<TurnIntent>;
  afterValidation?: HookCollection<ValidationResult>;
  afterReduction?: HookCollection<TableSnapshot>;
  handCompleted?: HookCollection<HandLedger>;
  simulationRequested?: HookCollection<SimulationRequest>;
}

interface HookRegistration<TPayload> {
  id: string;
  priority: number;
  handler: (payload: TPayload, session: Session) => void | Promise<void>;
}

interface SimulationRequest {
  context: DecisionContextView;
  policy: SimulationPolicy;
  iterations: number;
  resultChannel: string;
}
```

Hooks fire before and after each action in priority order, letting loggers,
simulators, and UI synchronizers extend the engine without forking the reducer.

### PotLedger

```ts
interface PotLedger {
  main: PotBucket;
  sides: PotBucket[];
  rake: number;
}

interface PotBucket {
  id: string;
  amount: number;
  eligiblePlayers: PlayerId[];
  contributions: Record<PlayerId, number>;
}
```

Every bucket tracks its individual contributions, which is what makes multi-way
unequal all-ins resolve correctly: each side pot knows exactly who funded it, so
payouts and audits reconcile to the chip.

### CardLedger

```ts
interface CardLedger {
  remainingDeck: Card[];
  burnPile: Card[];
  community: CommunityBoard;
  holeCards: Record<PlayerId, Card[] | null>;
}

interface CommunityBoard {
  flop?: [Card, Card, Card];
  turn?: Card;
  river?: Card;
  revealSchedule: RevealEvent[];
}

interface RevealEvent {
  stage: HandStage;
  cards: Card[];
  timestamp: number;
  reason: 'deal' | 'burn' | 'expose' | 'rollback';
}
```

`RevealEvent`s record exactly when and why each card was exposed, which keeps
animations, replays, and misdeal handling deterministic.

#### Visibility & transport

- The canonical reducer retains every seat's hole cards so simulation, showdown
  evaluation, and telemetry stay deterministic.
- Before a snapshot leaves the server (HTTP responses, realtime fan-out, advisor
  bridges), clone the `CardLedger` and null out `holeCards` for every seat the
  recipient is not authorized to see.
- Multi-viewer transports publish either per-subscriber payloads (preferred) or a
  shared redacted snapshot paired with user-scoped private card deliveries.
- The redaction step applies only to derived payloads; automation and analytics run
  against the full reducer state.

### ActionClock

```ts
interface ActionClock {
  currentActor?: PlayerId;
  deadline?: number;
  perTurnMs: number;
  bankMs: Record<PlayerId, number>; // time banks
  pauses: PauseWindow[];
}
```

Centralizing timing here allows server-side enforcement and synchronized UI timers.

### HandFlags

```ts
interface HandFlags {
  showdownLocked: boolean;
  autoRunout: boolean; // true when the board should run out because players are all in
  pendingEliminations: PlayerId[];
  rebuyAvailable: boolean;
  advisoryPending: boolean;
  recoveryMode: boolean; // true when resuming from event-log replay
}
```

Explicit flags make it obvious when the reducer must short-circuit into showdown
flows or resume from a replay.

### Audit & telemetry

```ts
interface TurnMetadata {
  advisorSnapshotId?: string;
  misclickProtection?: boolean;
  networkLatencyMs?: number;
  validationMs?: number;
  engineVersion: string;
  availableActionsAtDecision: PlayerOption[];
  retryCount?: number;
  nextHandStage?: HandStage;
  nextActorId?: PlayerId;
  showdownSummary?: ShowdownSummary;
  payoutSummary?: PayoutSummary;
  cardReveals?: CardRevealMetadata;
  personaFlagUpdates?: Partial<HandFlags>;
}

interface SessionMetrics {
  handsDealt: number;
  potsAwarded: number;
  averagePot: number;
  avgIntentLatencyMs: number;
  maxIntentLatencyMs: number;
  timeoutsHard: number;
  recoveries: number; // successful event-log replays
  simulationsRun: number;
  advisoryEquityRequests: number;
}
```

Each event carries the metadata needed to trace bugs, feed analytics, or satisfy an
audit. Board reveals and stage transitions travel inside `TurnMetadata.cardReveals`
and `nextHandStage`, so replaying the log reproduces the board without consulting
snapshot diffs.

## Derived views

The engine exposes read-only selectors that reshape normalized state for
presentation and decisions. They are deterministic pure functions, evaluated
server-side against a live `Session`:

- `TableView`: the table for rendering, with seats in order, pot totals, the board, the
  current actor, and `availableActions` already normalized to bet/raise min-max-
  increment semantics.
- `DecisionContextView`: the minimal state a decision needs, covering `handStage`,
  `potSize`, `effectiveStack`, `playersLeftToAct`, and `availableActions`.
- `HandSummaryView`: a scoreboard of winners, pending eliminations, and the showdown
  for lobby or results screens.
- `TelemetryEventView`: one event shape for streaming analytics, bundling
  `TurnMetadata`, pot deltas, persona adjustments, and clock usage so a sink can log
  a hand without re-querying the reducer.
- `SimulationView`: the minimal context (board, remaining deck, stacks, `ruleSet`,
  persona digests) for Monte Carlo or lookup-table evaluation, without exposing
  private cards.

Clients consume sanitized payloads rather than importing these types into browser
bundles.

## Lifecycle flows

### Session initialization

1. Materialize a `Session` from a `SessionConfig`.
2. Seed the initial `TableSnapshot` (`index = 0`) with empty ledgers and register
   channel endpoints (realtime topic, analytics stream, advisor bridge).
3. Persist the session metadata, `initialSnapshot`, and an empty `events` array
   together, so recovery always finds a coherent baseline.

### Seating & buy-in

1. Seats start `open` with zero stack.
2. On buy-in, assign the `occupant`, move to `reserved`, credit the `stack`, and
   create or refresh the persona entry.
3. Leaving or busted players flip to `leaving` or a zero stack while staying in the
   chart, so position and continuity persist between hands.

### Hand startup

1. Run an elimination sweep on the prior snapshot: seats at zero stack move to
   `pendingEliminations` but remain visible.
2. Require at least two active occupants; otherwise the reducer rejects the new hand.
3. Increment `handNumber`, rotate the button and blinds, and mint a new `HandLedger`
   with a deterministic `deckSeed`.

### Betting round progression

1. Validation confirms the actor matches `ActionClock.currentActor` and that the
   requested amount honors `highestBet` / `lastAggressor` from the active
   `BettingRound`.
2. Accepted intents produce `TurnEvent`s whose `legalOptions` carry the exact
   bet/raise bounds that were offered.
3. The reducer updates stacks, pots, and the `ActionClock`, then picks the next
   actor or advances the street when the round closes.

### All-in auto runout

1. After each reduction, `autoRunout` becomes true when only all-in or folded
   players remain.
2. When it is true, the reducer schedules `RevealEvent`s for the remaining community
   cards and stops collecting intents, running the board out on its own.

### Betting structure enforcement

1. `RuleSetDescriptor.minRaisePolicy` governs how `highestBet` evolves for no-limit,
   pot-limit, and fixed-limit play.
2. Before emitting a `TurnEvent`, the validator computes the legal raise ceiling from
   `bettingStructure`, the current pot, and player stacks. The logic is centralized,
   so switching structures swaps configuration rather than code.
3. For fixed-limit streets, `TurnEvent.metadata` records the enforced raise size.
4. An all-in of less than a full raise neither shrinks the minimum re-raise nor
   reopens the betting: a player who already acted may only call or fold until
   the wagering since their last action adds up to at least a full raise. Blind
   posts are forced wagers, not actions, so the big blind keeps its option.

### Showdown & settlement

1. On showdown, capture `ShowdownSummary` (hand ranks, winners) and compute
   `PayoutSummary` by walking `PotLedger` contributions. Uncontested and uncalled
   chips return to their contributor, so `sum(payouts)` always equals the pot total.
2. Emit a `TelemetryEventView` to the analytics channel with the hand result and
   ending stacks.
3. Apply eliminations and rebuy flags before materializing the next snapshot.

### Simulation & equity probing

The `simulationRequested` hook and the `SimulationPolicy` / `SimulationRequest` /
`EquityBreakdown` types are extension points, not shipped implementations. The
engine ships a headless runner that drives `TurnIntent`s through the reducer; an
equity or Monte Carlo evaluator is something a consumer plugs in.

1. When a hook registers `simulationRequested`, enqueue a `SimulationRequest` using
   the configured `SimulationPolicy`.
2. A consumer-supplied runner clones the current snapshot, hides opponents' hole
   cards per the visibility rules, and runs its own trials or evaluator sweeps.
3. Results publish to the advisory channel or an analytics queue without mutating the
   session's event log.

### Recovery & resilience

1. To resume a session, rebuild it from the persisted `initialSnapshot` and event
   log.
2. Reseat players, restore eliminated sets, and reconstruct hand counters from the
   replayed state, so recovery always starts from a coherent snapshot.

## State transition pipeline

1. **Input**: a `TurnIntent` arrives from the UI, automation, or an agent.
2. **Validation**: resolved against the latest snapshot, producing a
   `ValidationResult` with either a `TurnEvent` or a typed rejection.
3. **Reduction**: the event is applied to produce a new `TableSnapshot`.
4. **Broadcast**: observers and clients are notified through the derived views.
5. **Persistence**: the accepted event is appended to the log and caches refresh.

Because events and snapshots are immutable, the same pipeline gives you deterministic
replays, time-travel debugging, and an auditable record end to end.
