import type { EvaluationPolicy } from '../types/config';
import type { EquityBreakdown, ShowdownSummary } from '../types/snapshot';

const STANDARD_RANK_CLASSES = new Set<
  ShowdownSummary['evaluatedHands'][number]['rankClass']
>([
  'high-card',
  'pair',
  'two-pair',
  'three-of-a-kind',
  'straight',
  'flush',
  'full-house',
  'four-of-a-kind',
  'straight-flush',
]);

export interface ShowdownValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export function validateShowdownAgainstPolicy(
  showdown: ShowdownSummary | undefined,
  policy: EvaluationPolicy,
): ShowdownValidationResult {
  if (!showdown) {
    return { ok: false, issues: ['missing-showdown-summary'] };
  }

  const issues: string[] = [];

  if (showdown.evaluatorId !== policy.evaluatorId) {
    issues.push('evaluator-mismatch');
  }

  for (const hand of showdown.evaluatedHands) {
    if (!STANDARD_RANK_CLASSES.has(hand.rankClass)) {
      issues.push(`unknown-rank:${hand.rankClass}`);
    }

    if (hand.rankValue < 0) {
      issues.push(`invalid-rank-value:${hand.playerId}`);
    }

    if (hand.bestFive.length !== 5) {
      issues.push(`invalid-best-five:${hand.playerId}`);
    }
  }

  if (showdown.board.length < 3) {
    issues.push('insufficient-board-cards');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, issues: [] };
}

export interface EquityValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export function validateEquityBreakdown(
  showdown: ShowdownSummary,
  tolerance = 0.5,
): EquityValidationResult {
  if (!showdown.equities || showdown.equities.length === 0) {
    return { ok: false, issues: ['missing-equity-breakdown'] };
  }

  const issues: string[] = [];
  let referenceIterations: number | null = null;

  for (const entry of showdown.equities) {
    const total = entry.winPct + entry.tiePct + entry.lossPct;
    if (Math.abs(total - 100) > tolerance) {
      issues.push(`equity-sum-out-of-range:${entry.playerId}`);
    }

    if (entry.iterations <= 0) {
      issues.push(`invalid-iterations:${entry.playerId}`);
    }

    if (referenceIterations === null) {
      referenceIterations = entry.iterations;
    } else if (referenceIterations !== entry.iterations) {
      issues.push('iteration-mismatch');
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, issues: [] };
}

export function sumEquityPercentages(
  entries: readonly EquityBreakdown[],
): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.winPct + entry.tiePct + entry.lossPct;
  }
  return total;
}
