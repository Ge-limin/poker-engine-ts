import type { SeatBootstrapConfig } from '../src/session/lifecycle';
import { createSimulationRunner } from '../src/simulation/runner';
import {
  createConsoleSink,
  createRuntimeDispatchBus,
} from '../src/telemetry/runtime-dispatch';
import type { SessionConfig } from '../src/types/session';

async function main(): Promise<void> {
  const bus = createRuntimeDispatchBus();
  bus.register(createConsoleSink({ id: 'scenario-console' }));

  const runner = createSimulationRunner({
    config: createConfig(),
    seats: createSeats(),
    hands: 3,
    dispatchBus: bus,
    checkpointEvery: 1,
  });

  const result = await runner.run();
  process.stdout.write(
    `Completed ${result.handsCompleted} hands with ${result.intentsApplied} intents.\n`,
  );
  process.stdout.write(
    `Telemetry samples captured: ${result.dispatches.telemetry.length}\n`,
  );
}

function createConfig(): SessionConfig {
  return {
    tableVariant: 'texas-holdem',
    bettingStructure: 'no-limit',
    maxSeats: 2,
    startingStack: 100,
    blindSchedule: [{ level: 1, smallBlind: 1, bigBlind: 2 }],
    antePolicy: undefined,
    personaPolicy: { defaultStyle: 'balanced' },
    ruleSet: {
      streets: ['preflop', 'flop', 'turn', 'river', 'showdown'],
      postingOrder: ['small-blind', 'big-blind'],
      minRaisePolicy: 'double-last-bet',
      showdownOrdering: 'high-card',
      cardDistribution: {
        holeCardsPerPlayer: 2,
        burnPerStreet: [0, 1, 1],
        communityReveal: [0, 3, 1, 1],
      },
    },
    evaluationPolicy: {
      engine: 'lookup-table',
      evaluatorId: 'default',
      supportsHiLo: false,
      cacheSize: 1_024,
    },
    simulationPolicy: undefined,
    autoAdvance: true,
  } satisfies SessionConfig;
}

function createSeats(): readonly SeatBootstrapConfig[] {
  return [
    { playerId: 'alice', seatIndex: 0, stack: 100 },
    { playerId: 'bob', seatIndex: 1, stack: 100 },
  ];
}

main().catch((error) => {
  process.stderr.write(`Scenario runner failed: ${String(error)}\n`);
  process.exitCode = 1;
});
