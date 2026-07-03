import type {
  BettingStructure,
  RuleSetDescriptor,
} from '../../types/index';

export type MinRaisePolicy = RuleSetDescriptor['minRaisePolicy'];
export type MaxRaisePolicy =
  | NonNullable<RuleSetDescriptor['maxRaisePolicy']>
  | 'all-in';

export function resolveMinRaisePolicy(
  structure: BettingStructure,
  ruleSet?: RuleSetDescriptor,
): MinRaisePolicy {
  if (ruleSet?.minRaisePolicy) {
    return ruleSet.minRaisePolicy;
  }
  return structure === 'fixed-limit' ? 'fixed-increment' : 'double-last-bet';
}

export function resolveMaxRaisePolicy(
  structure: BettingStructure,
  ruleSet?: RuleSetDescriptor,
): MaxRaisePolicy {
  if (ruleSet?.maxRaisePolicy) {
    return ruleSet.maxRaisePolicy;
  }
  return structure === 'pot-limit' ? 'pot' : 'all-in';
}
