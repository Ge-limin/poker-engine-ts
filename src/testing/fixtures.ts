import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  PokerStateFixtureOrigin,
  RandomStateSummary,
  UniversalPokerStateFixture,
} from '../types/random-state';
import type { TableSnapshot } from '../types/snapshot';

const FIXTURES_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

export interface FixtureMetadata {
  readonly id: string;
  readonly description: string;
  readonly origin?: string;
}

export interface SnapshotFixture extends FixtureMetadata {
  readonly payload: TableSnapshot;
}

export interface FixtureEnvelope<TPayload> extends FixtureMetadata {
  readonly payload: TPayload;
}

export type SummaryFixture = UniversalPokerStateFixture;

const SUMMARY_FIXTURE_ORIGINS = new Set<PokerStateFixtureOrigin>([
  'headed-ui',
  'headless-script',
  'test-suite',
  'manual',
]);

export function createSnapshotFixture(
  metadata: FixtureMetadata,
  snapshot: TableSnapshot,
): SnapshotFixture {
  assertMetadata(metadata);
  const payload = cloneValue(snapshot);
  deepFreeze(payload);
  return { ...metadata, payload } satisfies SnapshotFixture;
}

export function loadSnapshotFixture(fixture: SnapshotFixture): SnapshotFixture {
  assertMetadata(fixture);
  const payload = cloneValue(fixture.payload);
  deepFreeze(payload);
  return { ...fixture, payload } satisfies SnapshotFixture;
}

export function createSummaryFixture(
  metadata: FixtureMetadata,
  summary: RandomStateSummary,
): SummaryFixture {
  assertMetadata(metadata);
  const payload = cloneValue(summary);
  deepFreeze(payload);
  return {
    id: metadata.id,
    description: metadata.description,
    origin: resolveSummaryOrigin(metadata.origin),
    payload,
  } satisfies SummaryFixture;
}

export function loadSummaryFixture(fixture: SummaryFixture): SummaryFixture {
  assertMetadata(fixture);
  const payload = cloneValue(fixture.payload);
  deepFreeze(payload);
  return {
    id: fixture.id,
    description: fixture.description,
    origin: fixture.origin,
    payload,
  } satisfies SummaryFixture;
}

export function createFixture<TPayload>(
  metadata: FixtureMetadata,
  payload: TPayload,
): FixtureEnvelope<TPayload> {
  assertMetadata(metadata);
  const cloned = cloneValue(payload);
  deepFreeze(cloned);
  return { ...metadata, payload: cloned } satisfies FixtureEnvelope<TPayload>;
}

export function loadFixture<TPayload>(
  fixture: FixtureEnvelope<TPayload>,
): FixtureEnvelope<TPayload> {
  assertMetadata(fixture);
  const cloned = cloneValue(fixture.payload);
  deepFreeze(cloned);
  return { ...fixture, payload: cloned } satisfies FixtureEnvelope<TPayload>;
}

export function readSummaryFixture(name: string): SummaryFixture {
  const payload = readFixtureFile(name);
  return loadSummaryFixture(payload);
}

export function readSnapshotFixture(name: string): SnapshotFixture {
  const summary = readSummaryFixture(name);
  return createSnapshotFixture(summary, summary.payload.session.activeSnapshot);
}

export function listSnapshotFixtures(): readonly SnapshotFixture[] {
  const files = readdirSync(FIXTURES_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name);

  const fixtures: SnapshotFixture[] = [];

  for (const file of files) {
    const id = basename(file, '.json');
    fixtures.push(readSnapshotFixture(id));
  }

  return fixtures;
}

export function listSummaryFixtures(): readonly SummaryFixture[] {
  const files = readdirSync(FIXTURES_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => basename(entry.name, '.json'));

  return files.map((id) => readSummaryFixture(id));
}

function assertMetadata(metadata: FixtureMetadata): void {
  if (!metadata.id.trim()) {
    throw new Error('Fixture metadata requires a non-empty id.');
  }
  if (!metadata.description.trim()) {
    throw new Error('Fixture metadata requires a description.');
  }
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

function deepFreeze<TValue>(value: TValue): TValue {
  const visited = new WeakSet<object>();

  const freeze = (current: unknown): void => {
    if (current === null || typeof current !== 'object') {
      return;
    }

    const target = current as Record<PropertyKey, unknown>;

    if (visited.has(target)) {
      return;
    }
    visited.add(target);

    if (!Object.isFrozen(target)) {
      Object.freeze(target);
    }

    if (Array.isArray(target)) {
      for (const entry of target) {
        if (entry === null || entry === undefined) {
          continue;
        }
        if (typeof entry !== 'object') {
          continue;
        }
        freeze(entry);
      }
      return;
    }

    for (const key of Reflect.ownKeys(target)) {
      const entry = target[key as keyof typeof target];
      if (entry === null || entry === undefined) {
        continue;
      }
      if (typeof entry !== 'object') {
        continue;
      }
      freeze(entry);
    }
  };

  freeze(value);

  return value;
}

function readFixtureFile(name: string): SummaryFixture {
  const target = join(FIXTURES_DIRECTORY, `${name}.json`);
  const raw = readFileSync(target, 'utf-8');
  const parsed = JSON.parse(raw) as SummaryFixture;
  return parsed;
}

function resolveSummaryOrigin(origin?: string): PokerStateFixtureOrigin {
  if (!origin) {
    return 'manual';
  }

  if (SUMMARY_FIXTURE_ORIGINS.has(origin as PokerStateFixtureOrigin)) {
    return origin as PokerStateFixtureOrigin;
  }

  return 'manual';
}
