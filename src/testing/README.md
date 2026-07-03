# Poker Engine Testing Utilities

This directory provides reusable helpers for Vitest batches, regression fixtures, and deterministic session orchestration.

## Fixture Registry

- Persist JSON fixtures under [`fixtures/`](./fixtures) using the `UniversalPokerStateFixture` envelope where the `payload` is a `RandomStateSummary`.
- Use `createFixture`/`createSnapshotFixture` to persist new payloads and `readSnapshotFixture` to load them in tests.
- All fixtures are deeply frozen on load so reducers cannot mutate shared references.

Run the fixture linter before committing new assets:

```bash
pnpm fixtures:lint
```

## Session Store Helpers

`createSessionStore` hydrates deterministic in-memory sessions and exposes `reset`, `saveSession`, and `listSessions` helpers to isolate Vitest batches.

## Structured Test Logger

`createTestLogger` records structured telemetry events (`severity`, `category`, `message`, and optional context) for scenario suites. Call `flush()` to snapshot immutable copies for assertions without leaking mutable references into reducers or hooks.
