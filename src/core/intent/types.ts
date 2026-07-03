import type {
  BettingStructure,
  Chips,
  Milliseconds,
  PlayerOption,
  RuleSetDescriptor,
} from '../../types/index';

export interface ValidationConfig {
  readonly bettingStructure: BettingStructure;
  readonly bigBlind: Chips;
  readonly smallBlind: Chips;
  readonly minRaiseIncrement?: Chips;
  readonly maxRaisesPerRound?: number;
  readonly ruleSet?: RuleSetDescriptor;
}

export interface ValidationTelemetry {
  readonly enabled: boolean;
  readonly logValidationMs?: boolean;
}

export interface ValidationOptions {
  readonly now?: Milliseconds;
  readonly config: ValidationConfig;
  readonly telemetry?: ValidationTelemetry;
}

export interface LegalOptionContext {
  readonly playerContribution: Chips;
  readonly highestContribution: Chips;
  readonly callAmount: Chips;
  readonly remainingStack: Chips;
  readonly lastRaiseSize: Chips;
  readonly totalPot: Chips;
  readonly raisesThisRound?: number;
  /**
   * Highest table contribution at the moment this actor last voluntarily
   * acted in the current round; undefined when they have not acted yet
   * (blind and ante posts do not count as acting). Used to decide whether
   * a short all-in has reopened the betting for them.
   */
  readonly lastActedHighestContribution?: Chips;
}

export interface LegalOptionsResult {
  readonly options: readonly PlayerOption[];
  readonly minRaiseTo: Chips;
  readonly maxRaiseTo: Chips;
}

export function buildStandardOptions(
  configs: LegalOptionConfig,
): readonly PlayerOption[] {
  const { canFold, canCheck, callAmount, callAvailable, betWindow } = configs;
  const options: PlayerOption[] = [];

  if (canFold) {
    options.push({ type: 'fold' });
  }

  if (canCheck) {
    options.push({ type: 'check' });
  }

  if (callAvailable) {
    options.push({ type: 'call', amount: callAmount });
  }

  if (betWindow) {
    if (betWindow.mode === 'bet') {
      options.push({
        type: 'bet',
        min: betWindow.min,
        max: betWindow.max,
        increment: betWindow.increment,
      });
    } else {
      options.push({
        type: 'raise',
        min: betWindow.min,
        max: betWindow.max,
        increment: betWindow.increment,
      });
    }
  }

  if (configs.allInAmount) {
    options.push({ type: 'all-in', amount: configs.allInAmount });
  }

  return options;
}

export interface LegalOptionConfig {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly callAmount: Chips;
  readonly callAvailable: boolean;
  readonly betWindow?:
    | {
        readonly mode: 'bet';
        readonly min: Chips;
        readonly max: Chips;
        readonly increment: Chips;
      }
    | {
        readonly mode: 'raise';
        readonly min: Chips;
        readonly max: Chips;
        readonly increment: Chips;
      };
  readonly allInAmount?: Chips;
}
