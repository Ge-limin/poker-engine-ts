export type TestLogSeverity = 'info' | 'warn' | 'error';

export interface TestLogEntry<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly timestamp: number;
  readonly severity: TestLogSeverity;
  readonly category: string;
  readonly message: string;
  readonly context?: TContext;
}

export interface TestLogger<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly info: (message: string, context?: TContext) => void;
  readonly warn: (message: string, context?: TContext) => void;
  readonly error: (message: string, context?: TContext) => void;
  readonly flush: () => readonly TestLogEntry<TContext>[];
  readonly snapshot: () => readonly TestLogEntry<TContext>[];
}

export function createTestLogger<
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(category: string): TestLogger<TContext> {
  const entries: TestLogEntry<TContext>[] = [];

  function write(
    severity: TestLogSeverity,
    message: string,
    context?: TContext,
  ): void {
    const entry: TestLogEntry<TContext> = {
      timestamp: Date.now(),
      severity,
      category,
      message,
      context,
    };

    entries.push(freezeEntry(entry));
  }

  return {
    info(message, context) {
      write('info', message, context);
    },
    warn(message, context) {
      write('warn', message, context);
    },
    error(message, context) {
      write('error', message, context);
    },
    flush() {
      const snapshot = entries.splice(0, entries.length);
      return snapshot;
    },
    snapshot() {
      return entries.slice();
    },
  } satisfies TestLogger<TContext>;
}

function freezeEntry<TContext extends Record<string, unknown>>(
  entry: TestLogEntry<TContext>,
): TestLogEntry<TContext> {
  const frozenContext = entry.context
    ? deepFreeze({ ...entry.context })
    : undefined;
  const frozen: TestLogEntry<TContext> = {
    ...entry,
    context: frozenContext,
  };
  return deepFreeze(frozen);
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value === null) {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return value;
  }

  const record = value as Record<PropertyKey, unknown>;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (entry === undefined) {
      continue;
    }
    deepFreeze(entry);
  }

  return value;
}
