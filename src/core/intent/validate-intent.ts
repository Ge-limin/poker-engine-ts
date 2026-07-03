import type {
  PlayerAction,
  PlayerOption,
  TableSnapshot,
  TurnEvent,
  TurnIntent,
  ValidationResult,
} from '../../types/index';

import { ENGINE_VERSION } from '../errors';
import { findSeatByPlayerId, sumPotAmounts } from '../utils/snapshot';
import { determineLegalOptions } from './legal-options';
import { deriveRoundComputation } from './round-context';
import type {
  LegalOptionsResult,
  ValidationConfig,
  ValidationOptions,
} from './types';

const DEFAULT_ENGINE_CONFIG: ValidationConfig = {
  bettingStructure: 'no-limit',
  bigBlind: 0,
  smallBlind: 0,
};

export interface ResolvedValidationContext {
  readonly config: ValidationConfig;
  readonly legalOptions: LegalOptionsResult;
  readonly stackBefore: number;
  readonly callAmount: number;
  readonly playerContribution: number;
  readonly highestContribution: number;
}

export function validateIntent(
  snapshot: TableSnapshot,
  intent: TurnIntent,
  options?: Partial<ValidationOptions>,
): ValidationResult {
  const seatingLookup = findSeatByPlayerId(snapshot.seating, intent.actor);
  if (!seatingLookup) {
    return {
      kind: 'rejected',
      reason: `Player ${intent.actor} is not seated`,
      recovery: {
        advise: 'retry',
      },
    };
  }

  if (
    intent.expectedSnapshotVersion !== undefined &&
    intent.expectedSnapshotVersion !== snapshot.index
  ) {
    return {
      kind: 'rejected',
      reason: 'version-mismatch',
      recovery: { advise: 'retry' },
    };
  }

  const currentRound = snapshot.hand.bettingRounds.at(-1);
  if (!currentRound) {
    return {
      kind: 'rejected',
      reason: 'No active betting round',
      recovery: { advise: 'retry' },
    };
  }

  if (snapshot.clock.currentActor !== intent.actor) {
    return {
      kind: 'rejected',
      reason: 'not-actors-turn',
      recovery: {
        advise: 'retry',
      },
    };
  }

  const config = resolveValidationConfig(snapshot, options?.config);
  const computation = deriveRoundComputation(currentRound);
  const playerContribution = computation.contributions.get(intent.actor) ?? 0;
  const highestContribution = computation.highestContribution;
  const callAmount = Math.max(0, highestContribution - playerContribution);
  const stackBefore = seatingLookup.seat.stack;

  const totalPot = sumPotAmounts(snapshot.pots);
  const legalOptions = determineLegalOptions({
    config,
    context: {
      callAmount,
      highestContribution,
      lastRaiseSize: computation.lastAggressiveRaise,
      playerContribution,
      remainingStack: stackBefore,
      totalPot,
      raisesThisRound: computation.raisesThisRound,
      lastActedHighestContribution:
        computation.lastActedHighestContribution.get(intent.actor),
    },
  });

  const event = buildEvent({
    intent,
    legalOptions,
    playerContribution,
    stackBefore,
    callAmount,
    highestContribution,
  });

  if (!event) {
    return {
      kind: 'rejected',
      reason: 'illegal-action',
      recovery: { advise: 'retry' },
    };
  }

  return {
    kind: 'accepted',
    event,
  };
}

function resolveValidationConfig(
  snapshot: TableSnapshot,
  overrides?: Partial<ValidationConfig>,
): ValidationConfig {
  const smallBlindAmount = snapshot.hand.blinds.smallBlind.amount ?? 0;
  const bigBlindAmount = snapshot.hand.blinds.bigBlind.amount ?? 0;

  return {
    ...DEFAULT_ENGINE_CONFIG,
    bigBlind: overrides?.bigBlind ?? bigBlindAmount,
    smallBlind: overrides?.smallBlind ?? smallBlindAmount,
    bettingStructure:
      overrides?.bettingStructure ?? DEFAULT_ENGINE_CONFIG.bettingStructure,
    minRaiseIncrement: overrides?.minRaiseIncrement ?? bigBlindAmount,
    maxRaisesPerRound: overrides?.maxRaisesPerRound,
    ruleSet: overrides?.ruleSet,
  } satisfies ValidationConfig;
}

interface EventBuilderParams {
  readonly intent: TurnIntent;
  readonly legalOptions: LegalOptionsResult;
  readonly stackBefore: number;
  readonly playerContribution: number;
  readonly callAmount: number;
  readonly highestContribution: number;
}

function buildEvent(params: EventBuilderParams): TurnEvent | undefined {
  const {
    intent,
    legalOptions,
    stackBefore,
    playerContribution,
    callAmount,
    highestContribution,
  } = params;

  const action = intent.requested;
  const options = legalOptions.options;
  const duplicatedOptions = options.map((option) => ({ ...option }));

  switch (action.type) {
    case 'fold': {
      if (!hasOption(options, 'fold')) {
        return undefined;
      }
      return makeBaseEvent({
        intent,
        stackBefore,
        stackAfter: stackBefore,
        contribution: 0,
        legalOptions: duplicatedOptions,
        action: { type: 'fold' },
      });
    }
    case 'check': {
      if (!hasOption(options, 'check')) {
        return undefined;
      }
      return makeBaseEvent({
        intent,
        stackBefore,
        stackAfter: stackBefore,
        contribution: 0,
        legalOptions: duplicatedOptions,
        action: { type: 'check' },
      });
    }
    case 'call': {
      const option = getOption(options, 'call');
      if (!option) {
        const cannotCover = callAmount > stackBefore && stackBefore > 0;
        if (!cannotCover) {
          return undefined;
        }
        const contribution = stackBefore;
        const stackAfter = 0;
        return makeBaseEvent({
          intent,
          stackBefore,
          stackAfter,
          contribution,
          legalOptions: duplicatedOptions,
          action: {
            type: 'call',
            amount: contribution,
            isAllIn: true,
          },
        });
      }
      const amount = Math.min(option.amount, stackBefore);
      const stackAfter = stackBefore - amount;
      return makeBaseEvent({
        intent,
        stackBefore,
        stackAfter,
        contribution: amount,
        legalOptions: duplicatedOptions,
        action: {
          type: 'call',
          amount,
          isAllIn: stackAfter === 0,
        },
      });
    }
    case 'bet': {
      const option = getOption(options, 'bet');
      if (!option || action.amount === undefined) {
        return undefined;
      }
      if (action.amount < option.min || action.amount > option.max) {
        return undefined;
      }
      if (action.amount > stackBefore) {
        return undefined;
      }
      const contribution = action.amount;
      const stackAfter = stackBefore - contribution;
      return makeBaseEvent({
        intent,
        stackBefore,
        stackAfter,
        contribution,
        legalOptions: duplicatedOptions,
        action: {
          type: 'bet',
          amount: contribution,
          isAllIn: stackAfter === 0,
        },
      });
    }
    case 'raise': {
      const option = getOption(options, 'raise');
      if (!option) {
        if (highestContribution === 0) {
          const betOption = getOption(options, 'bet');
          if (!betOption) {
            return undefined;
          }
          const target = resolveRaiseTarget({
            action,
            playerContribution,
            callAmount,
          });
          const contribution = target - playerContribution;
          if (
            contribution < betOption.min ||
            contribution > betOption.max ||
            contribution > stackBefore
          ) {
            return undefined;
          }
          const stackAfter = stackBefore - contribution;
          return makeBaseEvent({
            intent,
            stackBefore,
            stackAfter,
            contribution,
            legalOptions: duplicatedOptions,
            action: {
              type: 'bet',
              amount: contribution,
              isAllIn: stackAfter === 0,
            },
          });
        }
        return undefined;
      }
      const target = resolveRaiseTarget({
        action,
        playerContribution,
        callAmount,
      });
      if (target <= highestContribution) {
        return undefined;
      }
      const totalAvailable = playerContribution + stackBefore;
      const violatesMinRaise =
        target < option.min && totalAvailable >= option.min;
      if (violatesMinRaise || target > option.max) {
        return undefined;
      }
      const contribution = target - playerContribution;
      if (contribution > stackBefore) {
        return undefined;
      }
      const stackAfter = stackBefore - contribution;
      return makeBaseEvent({
        intent,
        stackBefore,
        stackAfter,
        contribution,
        legalOptions: duplicatedOptions,
        action: {
          type: 'raise',
          amount: contribution,
          to: target,
          isAllIn: stackAfter === 0,
        },
      });
    }
    case 'all-in': {
      if (stackBefore <= 0) {
        return undefined;
      }
      const allInTarget = playerContribution + stackBefore;
      const contribution = stackBefore;
      const stackAfter = 0;
      const becomesRaise = allInTarget > highestContribution;
      const coercedAction: PlayerAction = becomesRaise
        ? {
            type: 'raise',
            amount: contribution,
            to: allInTarget,
            isAllIn: true,
          }
        : {
            type: 'call',
            amount: contribution,
            isAllIn: true,
          };

      const isAllowed =
        hasOption(options, 'all-in') ||
        (becomesRaise
          ? Boolean(getOption(options, 'raise'))
          : Boolean(getOption(options, 'call')));

      if (!isAllowed) {
        return undefined;
      }

      return makeBaseEvent({
        intent,
        stackBefore,
        stackAfter,
        contribution,
        legalOptions: duplicatedOptions,
        action: coercedAction,
      });
    }
    default:
      return undefined;
  }
}

interface RaiseTargetParams {
  readonly action: Extract<PlayerAction, { type: 'raise' }>;
  readonly playerContribution: number;
  readonly callAmount: number;
}

function resolveRaiseTarget(params: RaiseTargetParams): number {
  const { action, playerContribution, callAmount } = params;
  if (action.to !== undefined) {
    return action.to;
  }
  if (action.amount !== undefined) {
    return action.amount;
  }
  return playerContribution + callAmount;
}

interface BaseEventParams {
  readonly intent: TurnIntent;
  readonly stackBefore: number;
  readonly stackAfter: number;
  readonly contribution: number;
  readonly action: PlayerAction;
  readonly legalOptions: readonly PlayerOption[];
}

function makeBaseEvent(params: BaseEventParams): TurnEvent {
  const {
    intent,
    stackBefore,
    stackAfter,
    contribution,
    action,
    legalOptions,
  } = params;

  const metadata: TurnEvent['metadata'] = {
    engineVersion: ENGINE_VERSION,
    availableActionsAtDecision: legalOptions,
    ...(intent.latencyMs !== undefined
      ? { networkLatencyMs: intent.latencyMs }
      : {}),
    ...(intent.origin === 'ai' ? { advisorSnapshotId: intent.id } : {}),
  };

  return {
    id: intent.id,
    actor: intent.actor,
    action,
    legalOptions,
    stackBefore,
    stackAfter,
    contribution,
    timestamp: intent.issuedAt,
    metadata,
  } satisfies TurnEvent;
}

function hasOption(
  options: readonly PlayerOption[],
  type: PlayerOption['type'],
): boolean {
  return options.some((option) => option.type === type);
}

function getOption<TType extends PlayerOption['type']>(
  options: readonly PlayerOption[],
  type: TType,
): Extract<PlayerOption, { type: TType }> | undefined {
  return options.find(
    (option): option is Extract<PlayerOption, { type: TType }> =>
      option.type === type,
  );
}
