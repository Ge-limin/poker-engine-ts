# Engine Session Runtime Context

## Purpose

A `Session` carries an explicit runtime context so engine subsystems can tell live
play, replays, high-speed simulations, and guided scenarios apart. Inferring the
mode from heuristics such as event-log length leads to fragile control flow and
mishandled actions.

## Data model

The `runtimeContext` field on the session is a discriminated union, so each mode
supplies only its own metadata.

```ts
interface Session {
  id: UUID;
  config: SessionConfig;
  initialSnapshot: TableSnapshot;
  events: TurnEvent[];
  activeSnapshot: TableSnapshot;
  runtimeContext: RuntimeContext;
  // other fields omitted for brevity
}

type RuntimeContext =
  | { mode: 'live' }
  | {
      mode: 'replay';
      timelineIndex: number; // event index currently in view
      isPlaying: boolean;    // whether autoplay is active
      speed: number;         // playback speed multiplier (1x, 2x, ...)
    }
  | {
      mode: 'simulation';
      simulationId: string;
      handsToRun: number;
      handsCompleted: number;
    }
  | {
      mode: 'scenario';
      scenarioId: string;
      isCompleted: boolean;
      viewingIndex: number | null; // null = live state; number = viewing a historical event
    };
```

## Mode semantics

- **live**: accepts player turn intents, keeps `activeSnapshot` aligned with the
  state produced by replaying all events, and runs the standard action clocks.
- **replay**: rejects new turn intents. The UI drives `timelineIndex`, and playback
  controls move through the immutable event log without mutating history.
- **simulation**: runs headless, typically fed by agents or batch scripts.
  Performance counters (hands completed) live on the context for monitoring.
- **scenario**: starts from a predefined snapshot, accepts a limited set of turn
  intents, and completes once its objective is met. When `viewingIndex` is `null`
  the user is aligned with live progress; a number means the UI is viewing a
  historical event and should switch to read-only controls.

  - **Bootstrap invariant**: a service reconstructing a scenario session should
    temporarily treat the context as live (`viewingIndex = null`,
    `isCompleted = false`) while automation replays any scripted setup turns. Once
    bootstrap succeeds, the persisted flags are restored without violating
    scenario-mode guards.

## Integration guidelines

1. Gate all action-handling code on `session.runtimeContext.mode` to prevent
   accidental cross-mode behavior.
2. Persist the runtime context with session state, so restarts, replays, and
   background jobs resume accurately.
3. Surface the context to clients, so UIs can toggle controls (replay scrubbers vs.
   action buttons) without inferring the mode.
4. Reset `viewingIndex` to `null` whenever the client returns to live play, so
   reducers and UI stay in sync with the append-only log.
5. Extend the union when a new mode is introduced; keep mode-specific state inside
   its branch so optional fields never bleed across modes.
