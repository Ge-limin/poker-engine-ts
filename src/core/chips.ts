import type { Chips } from '../types';

/**
 * Ensures that a chip amount is represented as a safe integer.
 * The engine treats chips as indivisible units, so any fractional
 * value indicates upstream validation drift that must be corrected.
 */
export function requireIntegerChips(value: number, context: string): Chips {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid chip amount for ${context}: ${value}`);
  }

  if (!Number.isSafeInteger(value)) {
    throw new Error(`Chips must be integers (${context}); received ${value}`);
  }

  return value as Chips;
}

/**
 * Convenience helper that validates both operands before producing a sum.
 */
export function sumChips(left: number, right: number, context: string): Chips {
  const leftInt = requireIntegerChips(left, `${context} (left)`);
  const rightInt = requireIntegerChips(right, `${context} (right)`);
  return requireIntegerChips(leftInt + rightInt, `${context} (sum)`);
}
