import type { Session } from '../types/session';

export interface SessionStore {
  readonly saveSession: (session: Session) => Session;
  readonly getSession: (sessionId: Session['id']) => Session | undefined;
  readonly listSessions: () => readonly Session[];
  readonly reset: () => void;
  readonly hydrate: (sessions: Iterable<Session>) => void;
}

export function createSessionStore(
  initialSessions: Iterable<Session> = [],
): SessionStore {
  const registry = new Map<Session['id'], Session>();

  function freezeSession(session: Session): Session {
    const clone: Session = {
      ...session,
      config: cloneValue(session.config),
      runtimeContext: cloneValue(session.runtimeContext),
      initialSnapshot: cloneValue(session.initialSnapshot),
      events: session.events.map((event) => cloneValue(event)),
      activeSnapshot: cloneValue(session.activeSnapshot),
      metrics: cloneValue(session.metrics),
      channels: cloneValue(session.channels),
      hooks: cloneHooks(session.hooks),
    };

    deepFreeze(clone);
    return clone;
  }

  function ensureSession(session: Session): Session {
    const existing = registry.get(session.id);
    if (existing) {
      return existing;
    }
    const frozen = freezeSession(session);
    registry.set(frozen.id, frozen);
    return frozen;
  }

  function saveSession(session: Session): Session {
    const frozen = freezeSession(session);
    registry.set(frozen.id, frozen);
    return frozen;
  }

  function getSession(id: Session['id']): Session | undefined {
    return registry.get(id);
  }

  function listSessions(): readonly Session[] {
    return Array.from(registry.values());
  }

  function reset(): void {
    registry.clear();
  }

  function hydrate(sessions: Iterable<Session>): void {
    for (const session of sessions) {
      ensureSession(session);
    }
  }

  hydrate(initialSessions);

  return {
    saveSession,
    getSession,
    listSessions,
    reset,
    hydrate,
  } satisfies SessionStore;
}

function cloneValue<TValue>(value: TValue): TValue {
  try {
    return structuredClone(value);
  } catch {
    return deepClone(value);
  }
}

function deepClone<T>(
  input: T,
  seen: WeakMap<object, unknown> = new WeakMap(),
): T {
  if (input === null) {
    return input;
  }

  const type = typeof input;
  if (type !== 'object' && type !== 'function') {
    return input;
  }

  if (type === 'function') {
    return input;
  }

  const objectInput = input as unknown as object;
  const cached = seen.get(objectInput);
  if (cached !== undefined) {
    return cached as T;
  }

  if (objectInput instanceof Date) {
    return new Date(objectInput.getTime()) as unknown as T;
  }

  if (objectInput instanceof RegExp) {
    return new RegExp(objectInput) as unknown as T;
  }

  if (objectInput instanceof Map) {
    const mapClone = new Map<unknown, unknown>();
    seen.set(objectInput, mapClone);
    for (const [key, value] of objectInput) {
      mapClone.set(deepClone(key, seen), deepClone(value, seen));
    }
    return mapClone as unknown as T;
  }

  if (objectInput instanceof Set) {
    const setClone = new Set<unknown>();
    seen.set(objectInput, setClone);
    for (const value of objectInput) {
      setClone.add(deepClone(value, seen));
    }
    return setClone as unknown as T;
  }

  if (Array.isArray(objectInput)) {
    const arrayClone: unknown[] = new Array(objectInput.length);
    seen.set(objectInput, arrayClone);
    for (let index = 0; index < objectInput.length; index += 1) {
      arrayClone[index] = deepClone(objectInput[index], seen);
    }
    return arrayClone as unknown as T;
  }

  const prototype = Object.getPrototypeOf(objectInput);
  const objectClone = Object.create(prototype) as Record<PropertyKey, unknown>;
  seen.set(objectInput, objectClone);

  for (const key of Reflect.ownKeys(objectInput)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectInput, key);
    if (!descriptor) {
      continue;
    }

    if ('value' in descriptor) {
      const valueDescriptor: PropertyDescriptor = { ...descriptor };
      valueDescriptor.value = deepClone(descriptor.value, seen);
      Object.defineProperty(objectClone, key, valueDescriptor);
      continue;
    }

    Object.defineProperty(objectClone, key, descriptor);
  }

  return objectClone as unknown as T;
}

function cloneHooks(sessionHooks: Session['hooks']): Session['hooks'] {
  if (!sessionHooks) {
    return {};
  }

  const cloned: Partial<
    Record<keyof Session['hooks'], Session['hooks'][keyof Session['hooks']]>
  > = {};

  for (const stage of Object.keys(sessionHooks) as (keyof Session['hooks'])[]) {
    const registration = sessionHooks[stage];
    if (registration === undefined) {
      continue;
    }
    cloned[stage] = cloneHookCollection(registration);
  }

  return cloned as Session['hooks'];
}

function cloneHookCollection(
  collection: Session['hooks'][keyof Session['hooks']],
): Session['hooks'][keyof Session['hooks']] {
  if (collection === undefined) {
    return collection;
  }
  if (Array.isArray(collection)) {
    return collection.map((entry) => cloneValue(entry));
  }
  return cloneValue(collection);
}

function deepFreeze<TValue>(
  value: TValue,
  seen = new WeakSet<object>(),
): TValue {
  if (!isFreezableObject(value)) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }

  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      continue;
    }
    const entry = descriptor.value;
    if (entry === undefined || typeof entry === 'function') {
      continue;
    }
    deepFreeze(entry, seen);
  }

  Object.freeze(value);
  return value;
}

function isFreezableObject(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}
