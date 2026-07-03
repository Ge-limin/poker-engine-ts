import { defineConfig } from 'vitest/config';

interface BatchParseResult {
  readonly tag?: string;
  readonly argv: string[];
}

function extractBatchTag(argv: readonly string[]): BatchParseResult {
  const sanitized: string[] = [];
  let tag: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith('--batch')) {
      sanitized.push(argument);
      continue;
    }

    const [flag, value] = argument.split('=');
    if (value) {
      tag = value.trim();
      continue;
    }

    const next = argv[index + 1];
    if (flag === '--batch' && typeof next === 'string' && !next.startsWith('--')) {
      tag = next.trim();
      index += 1;
      continue;
    }
  }

  return { tag, argv: sanitized };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const { tag: batchTag, argv } = extractBatchTag(process.argv);

if (argv.length !== process.argv.length) {
  process.argv = argv;
}

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    reporters: ['default'],
    coverage: {
      enabled: false,
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov', 'json-summary'],
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 70,
        lines: 75,
      },
    },
    ...(batchTag
      ? {
          testNamePattern: new RegExp(`@batch\\(${escapeRegExp(batchTag)}\\)`, 'i'),
        }
      : {}),
  },
});
