# Design docs

The design behind the engine: the state model, the event-sourcing contract, and the
runtime modes. These describe how the engine is built and how to build on it.

- [`poker-engine-state-schema.md`](./poker-engine-state-schema.md) covers the state
  model: `Session`, `TableSnapshot`, `TurnEvent`, the pot / card / persona ledgers,
  the derived views, and the validate → reduce → replay pipeline. Start here.
- [`active-snapshot-vs-events.md`](./active-snapshot-vs-events.md) explains why the
  immutable event log, not the cached snapshot, is the source of truth for history,
  replay, and concurrency.
- [`engine-session-runtime-context.md`](./engine-session-runtime-context.md) defines the
  runtime-context union (live / replay / simulation / scenario) that lets one engine
  serve live play, replays, headless simulations, and guided scenarios off the same
  state.
