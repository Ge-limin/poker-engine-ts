import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSummaryFixture } from '../src/testing/fixtures';
import {
  createSeededRandom,
  runHeadlessRandomState,
} from '../src/testing/random-state-headless-runner';
import type { HandStage } from '../src/types/common';

interface FixturePlan {
  readonly id: string;
  readonly street: Exclude<HandStage, 'deal' | 'showdown' | 'settled'>;
  readonly seatCount: number;
  readonly steps: number;
  readonly decisionMode: 'uniform' | 'policy' | 'first-legal';
}

interface FixtureBuildResult {
  readonly seed: number;
  readonly summary: Awaited<ReturnType<typeof runHeadlessRandomState>>['final'];
}

const FIXTURE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'testing',
  'fixtures',
);

const FIXTURE_PLANS: readonly FixturePlan[] = [
  {
    id: 'street-preflop-heads-up',
    street: 'preflop',
    seatCount: 2,
    steps: 4,
    decisionMode: 'uniform',
  },
  {
    id: 'street-preflop-six-max',
    street: 'preflop',
    seatCount: 6,
    steps: 4,
    decisionMode: 'uniform',
  },
  {
    id: 'street-flop-heads-up',
    street: 'flop',
    seatCount: 2,
    steps: 16,
    decisionMode: 'uniform',
  },
  {
    id: 'street-flop-six-max',
    street: 'flop',
    seatCount: 6,
    steps: 16,
    decisionMode: 'uniform',
  },
  {
    id: 'street-turn-heads-up',
    street: 'turn',
    seatCount: 2,
    steps: 24,
    decisionMode: 'uniform',
  },
  {
    id: 'street-turn-six-max',
    street: 'turn',
    seatCount: 6,
    steps: 24,
    decisionMode: 'uniform',
  },
  {
    id: 'street-river-heads-up',
    street: 'river',
    seatCount: 2,
    steps: 32,
    decisionMode: 'uniform',
  },
  {
    id: 'street-river-six-max',
    street: 'river',
    seatCount: 6,
    steps: 32,
    decisionMode: 'uniform',
  },
] as const;

async function main(): Promise<void> {
  for (const plan of FIXTURE_PLANS) {
    const { seed, summary } = await buildFixture(plan);
    const timestamp = new Date().toISOString();
    const metadata = {
      id: plan.id,
      description: buildDescription(plan, seed, timestamp),
      origin: 'headless-script',
    } as const;
    const fixture = createSummaryFixture(metadata, summary);
    const filepath = join(FIXTURE_DIRECTORY, `${plan.id}.json`);
    writeFileSync(filepath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Created ${filepath} (seed=${seed})`);
  }
}

async function buildFixture(plan: FixturePlan): Promise<FixtureBuildResult> {
  const stageTarget = plan.street;
  let attempt = 0;

  while (attempt < 10_000) {
    const seed = createSeed(plan.id, attempt);
    const random = createSeededRandom(seed);
    const { final } = await runHeadlessRandomState({
      seatCount: plan.seatCount,
      steps: plan.steps,
      decisionMode: plan.decisionMode,
      random,
    });

    const stage = final.session.activeSnapshot.hand.stage;
    const seatOccupancy = final.session.activeSnapshot.seating.seats.filter(
      (seat) => seat.status === 'occupied',
    ).length;

    if (stage === stageTarget && seatOccupancy === plan.seatCount) {
      return { seed, summary: final };
    }

    attempt += 1;
  }

  throw new Error(
    `Unable to generate fixture for ${plan.id} after ${attempt} attempts.`,
  );
}

function createSeed(id: string, attempt: number): number {
  const base = Math.abs(hashString(id));
  return base + attempt + 1;
}

function buildDescription(
  plan: FixturePlan,
  seed: number,
  timestamp: string,
): string {
  return [
    `${capitalize(plan.street)} baseline generated via headless random state runner`,
    `(${plan.seatCount} players, decision mode: ${plan.decisionMode}, steps: ${plan.steps}, seed: ${seed}).`,
    `Captured on ${timestamp}.`,
  ].join(' ');
}

function hashString(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index)!;
    hash |= 0;
  }
  return hash;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
