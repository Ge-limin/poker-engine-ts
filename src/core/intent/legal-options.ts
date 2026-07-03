import {
  type MaxRaisePolicy,
  type MinRaisePolicy,
  resolveMaxRaisePolicy,
  resolveMinRaisePolicy,
} from './policy-utils';
import { buildStandardOptions } from './types';
import type {
  LegalOptionConfig,
  LegalOptionContext,
  LegalOptionsResult,
  ValidationConfig,
} from './types';

export interface LegalOptionsInput {
  readonly config: ValidationConfig;
  readonly context: LegalOptionContext;
}

export function determineLegalOptions(
  input: LegalOptionsInput,
): LegalOptionsResult {
  const { config, context } = input;
  const {
    callAmount,
    highestContribution,
    lastRaiseSize,
    playerContribution,
    remainingStack,
    totalPot,
    raisesThisRound = 0,
    lastActedHighestContribution,
  } = context;

  const minPolicy = resolveMinRaisePolicy(
    config.bettingStructure,
    config.ruleSet,
  );
  const maxPolicy = resolveMaxRaisePolicy(
    config.bettingStructure,
    config.ruleSet,
  );

  const baseIncrement = Math.max(
    config.minRaiseIncrement ?? config.bigBlind,
    1,
  );
  const effectiveStack = playerContribution + remainingStack;
  const callableAmount = Math.min(callAmount, remainingStack);
  const allInTo = playerContribution + remainingStack;
  const canCheck = callAmount === 0;
  const canFold = true;
  const callAvailable = callAmount > 0 && remainingStack >= callAmount;

  const minimumRaiseSize = resolveMinimumRaiseSize({
    minPolicy,
    baseIncrement,
    lastRaiseSize,
  });

  // A player who has already voluntarily acted this round may only raise
  // again once the wagering since that action amounts to at least a full
  // raise. A short all-in below that threshold does not reopen the betting:
  // such a player may only call or fold, and all-in stays available to them
  // only when their stack cannot cover the call. Fixed-limit shares the
  // full-bet threshold; the half-bet completion rule is not modeled.
  const reopenAllowed =
    lastActedHighestContribution === undefined ||
    highestContribution - lastActedHighestContribution >= minimumRaiseSize;

  const raisesRemaining = resolveRaisesRemaining(
    config.maxRaisesPerRound,
    raisesThisRound,
  );

  const limitResult =
    minPolicy === 'fixed-increment'
      ? deriveFixedLimitWindow({
          highestContribution,
          baseIncrement,
          effectiveStack,
          raisesRemaining,
        })
      : undefined;

  const rawMinRaiseTo =
    limitResult?.minRaiseTo ??
    deriveMinRaiseTarget({
      highestContribution,
      minimumRaiseSize,
      baseIncrement,
      bigBlind: config.bigBlind,
    });

  let minRaiseTo = rawMinRaiseTo;

  if (minRaiseTo > effectiveStack) {
    minRaiseTo = effectiveStack;
  }

  const rawMaxRaiseTo =
    limitResult?.maxRaiseTo ??
    deriveMaxRaiseTo({
      maxPolicy,
      callAmount,
      playerContribution,
      remainingStack,
      totalPot,
    });

  let maxRaiseTo = Math.min(rawMaxRaiseTo, effectiveStack);
  maxRaiseTo = Math.max(maxRaiseTo, minRaiseTo);

  const structureAllowsGenericWindow =
    config.bettingStructure !== 'fixed-limit';
  const policyAllowsGenericWindow =
    structureAllowsGenericWindow && minPolicy !== 'fixed-increment';
  const hasRaiseCapacity = maxRaiseTo > highestContribution;
  const minAffordable = minRaiseTo <= effectiveStack;

  const shouldDeriveGenericWindow =
    reopenAllowed &&
    !limitResult?.window &&
    raisesRemaining > 0 &&
    policyAllowsGenericWindow &&
    hasRaiseCapacity &&
    minAffordable;

  const betWindow = reopenAllowed
    ? (limitResult?.window ??
      (shouldDeriveGenericWindow
        ? deriveBetWindow({
            highestContribution,
            minRaiseTo,
            maxRaiseTo,
            baseIncrement,
            callAmount,
          })
        : undefined))
    : undefined;

  const allInAvailable =
    remainingStack > 0 && (reopenAllowed || allInTo <= highestContribution);

  const configPayload: LegalOptionConfig = {
    canFold,
    canCheck,
    callAmount: callableAmount,
    callAvailable,
    betWindow,
    allInAmount: allInAvailable ? allInTo : undefined,
  };

  return {
    options: buildStandardOptions(configPayload),
    minRaiseTo,
    maxRaiseTo,
  };
}

function resolveRaisesRemaining(
  maxRaisesPerRound: ValidationConfig['maxRaisesPerRound'],
  raisesThisRound: number,
): number {
  if (maxRaisesPerRound === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(maxRaisesPerRound - raisesThisRound, 0);
}

interface FixedLimitParams {
  readonly highestContribution: number;
  readonly baseIncrement: number;
  readonly effectiveStack: number;
  readonly raisesRemaining: number;
}

interface FixedLimitResult {
  readonly minRaiseTo: number;
  readonly maxRaiseTo: number;
  readonly window?: LegalOptionConfig['betWindow'];
}

function deriveFixedLimitWindow(params: FixedLimitParams): FixedLimitResult {
  const {
    highestContribution,
    baseIncrement,
    effectiveStack,
    raisesRemaining,
  } = params;
  const increment = Math.max(baseIncrement, 1);

  if (raisesRemaining <= 0) {
    const target = highestContribution === 0 ? increment : highestContribution;
    return {
      minRaiseTo: target,
      maxRaiseTo: target,
      window: undefined,
    };
  }

  const requiredContribution =
    highestContribution === 0 ? increment : highestContribution + increment;

  if (effectiveStack < requiredContribution) {
    return {
      minRaiseTo: requiredContribution,
      maxRaiseTo: requiredContribution,
      window: undefined,
    };
  }

  const window: LegalOptionConfig['betWindow'] =
    highestContribution === 0
      ? {
          mode: 'bet',
          min: requiredContribution,
          max: requiredContribution,
          increment,
        }
      : {
          mode: 'raise',
          min: requiredContribution,
          max: requiredContribution,
          increment,
        };

  return {
    minRaiseTo: requiredContribution,
    maxRaiseTo: requiredContribution,
    window,
  };
}

interface MinimumRaiseSizeParams {
  readonly minPolicy: MinRaisePolicy;
  readonly baseIncrement: number;
  readonly lastRaiseSize: number;
}

function resolveMinimumRaiseSize(params: MinimumRaiseSizeParams): number {
  const { minPolicy, baseIncrement, lastRaiseSize } = params;

  if (minPolicy === 'fixed-increment') {
    return baseIncrement;
  }

  return Math.max(lastRaiseSize || baseIncrement, baseIncrement);
}

interface MinRaiseTargetParams {
  readonly highestContribution: number;
  readonly minimumRaiseSize: number;
  readonly baseIncrement: number;
  readonly bigBlind: number;
}

function deriveMinRaiseTarget(params: MinRaiseTargetParams): number {
  const { highestContribution, minimumRaiseSize, baseIncrement, bigBlind } =
    params;

  if (highestContribution === 0) {
    return Math.max(baseIncrement, bigBlind, minimumRaiseSize);
  }

  return highestContribution + minimumRaiseSize;
}

interface MaxRaiseParams {
  readonly maxPolicy: MaxRaisePolicy;
  readonly callAmount: number;
  readonly playerContribution: number;
  readonly remainingStack: number;
  readonly totalPot: number;
}

function deriveMaxRaiseTo(params: MaxRaiseParams): number {
  const {
    maxPolicy,
    callAmount,
    playerContribution,
    remainingStack,
    totalPot,
  } = params;
  const stackCap = playerContribution + remainingStack;

  if (maxPolicy === 'pot') {
    const potCeiling = playerContribution + callAmount + totalPot + callAmount;
    return Math.min(potCeiling, stackCap);
  }

  return stackCap;
}

interface BetWindowParams {
  readonly highestContribution: number;
  readonly minRaiseTo: number;
  readonly maxRaiseTo: number;
  readonly baseIncrement: number;
  readonly callAmount: number;
}

function deriveBetWindow(
  params: BetWindowParams,
): LegalOptionConfig['betWindow'] {
  const {
    highestContribution,
    minRaiseTo,
    maxRaiseTo,
    baseIncrement,
    callAmount,
  } = params;

  if (maxRaiseTo <= highestContribution) {
    return undefined;
  }

  const increment = Math.max(baseIncrement, 1);

  if (highestContribution === 0) {
    const min = Math.max(minRaiseTo, increment);
    const max = maxRaiseTo - callAmount;

    if (max < min) {
      return undefined;
    }

    return {
      mode: 'bet',
      min,
      max,
      increment,
    };
  }

  const min = Math.max(minRaiseTo, highestContribution + increment);
  const max = maxRaiseTo;

  if (max < min) {
    return undefined;
  }

  return {
    mode: 'raise',
    min,
    max,
    increment,
  };
}
