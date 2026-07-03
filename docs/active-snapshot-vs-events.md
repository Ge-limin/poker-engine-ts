# Active Snapshot vs. Event Log

This note explains the difference between the cached `activeSnapshot` the engine
returns and the immutable `events` log that accompanies it, and why clients must
drive history from the event batches rather than diffing snapshots.

## Surfaces and their responsibilities

| Surface | What it contains | How it is produced | Intended usage |
| --- | --- | --- | --- |
| `initialSnapshot` | Fully materialized table state at the checkpoint boundary. | Persisted reducer output for the moment the session was captured. | The baseline when a session resumes. |
| `events` | Ordered list of immutable `TurnEvent`s committed after the baseline. | Transactionally appended to storage; each append increments the shared event index. | Source of truth for time-travel, audit, and replay. |
| `activeSnapshot` | Cached `TableSnapshot` derived from `initialSnapshot` + every `TurnEvent`. | Recomputed by replaying the log, then memoized for fast reads. | Instant render of the latest table view. No provenance metadata. |

Only the event log carries the incremental timeline. Both snapshots are
**projections** of that timeline.

## Why diffing `activeSnapshot.hand.bettingRounds[].turns` fails

1. **No batch-boundary metadata.** The `turns` array inside `activeSnapshot` is the
   reducer's fully-applied state. When several `TurnEvent`s land in one tick (say, a
   bet and an auto-call in a single transaction), the snapshot shows a merged list
   with no marker for which entries just arrived. A client diffing two snapshots
   would have to guess the grouping, which breaks animation timing and double-counts
   in optimistic UI. Side effects such as card reveals ride inside the authoritative
   `TurnEvent`'s metadata, so no synthetic entries appear in `turns` to delineate a
   step.

2. **Reducer-side rewrites.** Some events prune or correct earlier turn entries
   before the snapshot is cached (folding a seat and sweeping its pending chips, or
   cancelling an illegal action). The reducer emits a corrected `turns` array, but
   the event log still records the exact sequence, including the correction.
   Snapshot-only diffs lose that provenance.

3. **Concurrent-resume protection.** Resume uses a shared `eventIndex`; each client
   acknowledges the highest index it has processed, and the server uses that to
   detect a caller replaying stale history. A snapshot diff has no notion of the
   index and cannot confirm the client and server agree on the processed prefix.

4. **Historical-frame reconstruction.** Scrubber replays ask the server for "frame
   N," which it recomputes by replaying the first N events over the initial
   snapshot. A client rebuilding history from snapshot diffs would need every
   intermediate snapshot and still could not reproduce order-dependent reducer side
   effects (delayed pot creation, decision clocks).

## Service contract example

The JSON below is an illustrative app-layer transport envelope, not the literal
`TurnEvent` shape: a `TurnEvent` nests its action (`action.type`) and its position
in the log is its index. What matters here is the shape of the exchange.

```
POST /api/table/{session}/turn
→ server validates and commits two new events (log indices 41 and 42)
→ response payload:
   {
     "activeSnapshot": { ... },
     "events": [
       { "index": 41, "action": { "type": "bet" }, ... },
       { "index": 42, "action": { "type": "call" }, ... }
     ]
   }
```

If the client discards the returned event batch and diffs the `turns` array
instead, it loses:

- the authoritative indices (41, 42) it needs to acknowledge processing,
- the guarantee that exactly two events were committed (transports may merge
  responses, retries may replay older snapshots), and
- the ability to share the same reducer code for replays, which expects canonical
  `TurnEvent`s.

### Card reveals and other reducer side effects

`TurnEvent.metadata` carries the board cards exposed during the tick. After the
reducer applies a betting action, the manager captures the community cards revealed
by an auto-runout and merges them into the persisted event before it is appended.
Automatic street transitions work the same way: when no one has action, the stage
advance returns the cards it just dealt so they are folded into the very event that
triggered the advance.

Because the reducer understands `metadata.cardReveals`, replaying the event log
reproduces the community board without consulting snapshot diffs, and clients can
drive animations directly from the immutable event stream.

## Recommended client workflow

1. Apply `activeSnapshot` directly to render the latest table state.
2. Iterate the returned `events` batch in order to drive animations, optimistic
   updates, analytics, or playback timelines.
3. Persist the highest processed event index, so the next request can advertise
   which prefix is already acknowledged.

Following this contract keeps the client in lockstep with the server, preserves full
auditability, and avoids the desynchronization bugs that snapshot diffing
introduces.

## Why `turns` is still part of `activeSnapshot`

The snapshot surfaces are for immediate rendering. Each betting round's `turns`
ledger is still needed to:

- render full hand history when a spectator joins mid-hand or a client resumes after
  suspension,
- support UI features such as a "hand recap" panel, and
- allow integrity checks (verifying pot totals or stack movements) without replaying
  the entire event log on the client.

In other words, `turns` stays in the snapshot because it is part of the canonical
hand state, not because it replaces the transport of event batches.

## Related reading

- [`poker-engine-state-schema.md`](./poker-engine-state-schema.md)
- [`engine-session-runtime-context.md`](./engine-session-runtime-context.md)
