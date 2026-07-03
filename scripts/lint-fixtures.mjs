#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import process from 'node:process';

const fixturesDirectory = new URL('../src/testing/fixtures/', import.meta.url);

async function main() {
  const entries = await readdir(fixturesDirectory, { withFileTypes: true });
  const fixtures = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));

  if (fixtures.length === 0) {
    console.log('No fixtures found.');
    return;
  }

  const failures = [];

  for (const fixture of fixtures) {
    const id = basename(fixture.name, '.json');
    const url = new URL(fixture.name, fixturesDirectory);
    const raw = await readFile(url, 'utf8');

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      failures.push(`❌ ${fixture.name} is not valid JSON: ${(error instanceof Error && error.message) || error}`);
      continue;
    }

    validateFixture(id, parsed, failures);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`✅ Validated ${fixtures.length} poker engine fixtures.`);
}

const allowedOrigins = new Set([
  'headed-ui',
  'headless-script',
  'test-suite',
  'manual',
]);

function validateFixture(id, fixture, failures) {
  if (typeof fixture !== 'object' || fixture === null) {
    failures.push(`❌ ${id}: fixture must be an object.`);
    return;
  }

  const requiredFields = ['id', 'description', 'origin', 'payload'];
  for (const field of requiredFields) {
    if (!(field in fixture)) {
      failures.push(`❌ ${id}: missing required field "${field}".`);
    }
  }

  if (typeof fixture.id !== 'string' || fixture.id.trim() === '') {
    failures.push(`❌ ${id}: id must be a non-empty string.`);
  }

  if (typeof fixture.description !== 'string' || fixture.description.trim() === '') {
    failures.push(`❌ ${id}: description must be a non-empty string.`);
  }

  if (typeof fixture.origin !== 'string' || fixture.origin.trim() === '') {
    failures.push(`❌ ${id}: origin must be a non-empty string.`);
  } else if (!allowedOrigins.has(fixture.origin)) {
    failures.push(
      `❌ ${id}: origin must be one of ${Array.from(allowedOrigins).join(', ')}.`,
    );
  }

  if (typeof fixture.payload !== 'object' || fixture.payload === null) {
    failures.push(`❌ ${id}: payload must be an object.`);
    return;
  }

  const { session, decision, stepsApplied } = fixture.payload;

  if (typeof session !== 'object' || session === null) {
    failures.push(`❌ ${id}: payload.session must be an object.`);
  } else {
    if (typeof session.id !== 'string' || session.id.trim() === '') {
      failures.push(`❌ ${id}: payload.session.id must be a non-empty string.`);
    }
    if (
      typeof session.activeSnapshot !== 'object' ||
      session.activeSnapshot === null
    ) {
      failures.push(
        `❌ ${id}: payload.session.activeSnapshot must be an object.`,
      );
    }
  }

  if (typeof decision !== 'object' || decision === null) {
    failures.push(`❌ ${id}: payload.decision must be an object.`);
  }

  if (typeof stepsApplied !== 'number' || !Number.isFinite(stepsApplied)) {
    failures.push(`❌ ${id}: payload.stepsApplied must be a finite number.`);
  }
}

await main().catch((error) => {
  console.error('❌ Fixture lint failed:', error);
  process.exitCode = 1;
});
