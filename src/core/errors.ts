export interface EngineErrorDetails {
  readonly code: string;
  readonly context?: Record<string, unknown>;
}

abstract class EngineError extends Error {
  readonly details: EngineErrorDetails;

  constructor(message: string, details: EngineErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class IllegalIntentError extends EngineError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: 'illegal_intent', context });
  }
}

export class RuntimeModeViolationError extends EngineError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: 'runtime_mode_violation', context });
  }
}

export class ReducerInvariantError extends EngineError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: 'reducer_invariant', context });
  }
}

export class SnapshotIntegrityError extends EngineError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { code: 'snapshot_integrity', context });
  }
}

export type EngineErrorType =
  | IllegalIntentError
  | RuntimeModeViolationError
  | ReducerInvariantError
  | SnapshotIntegrityError;

export const ENGINE_VERSION = 'engine.v0.phase3';
