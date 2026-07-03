import { determineLegalOptions } from '../core/intent/legal-options';
import {
  resolveMaxRaisePolicy,
  resolveMinRaisePolicy,
} from '../core/intent/policy-utils';
import { deriveRoundComputation } from '../core/intent/round-context';
import type { ValidationConfig } from '../core/intent/types';
import {
  collectAllInPlayers,
  collectFoldedPlayers,
  findSeatByPlayerId,
  sumPotAmounts,
} from '../core/utils/snapshot';
import type { PlayerId } from '../types/common';
import type { SessionConfig } from '../types/session';
import type { TableSnapshot } from '../types/snapshot';

export function createValidationConfig(
  snapshot: TableSnapshot,
  sessionConfig?: SessionConfig,
): ValidationConfig {
  const blinds = snapshot.hand.blinds;
  const currentRound = snapshot.hand.bettingRounds.at(-1);
  const bettingStructure = sessionConfig?.bettingStructure ?? 'no-limit';
  const baseBigBlind = blinds.bigBlind.amount;
  const minRaiseIncrement = deriveMinRaiseIncrement({
    bettingStructure,
    ruleSet: sessionConfig?.ruleSet,
    bigBlind: baseBigBlind,
    currentStage: currentRound?.stage ?? snapshot.hand.stage,
  });

  return {
    bettingStructure,
    bigBlind: blinds.bigBlind.amount,
    smallBlind: blinds.smallBlind.amount,
    minRaiseIncrement,
    maxRaisesPerRound: deriveMaxRaisesPerRound({
      bettingStructure,
      ruleSet: sessionConfig?.ruleSet,
    }),
    ruleSet: sessionConfig?.ruleSet,
  } satisfies ValidationConfig;
}

export function deriveLegalOptionsForActor(
  snapshot: TableSnapshot,
  actor: PlayerId | undefined,
  options: {
    readonly sessionConfig?: SessionConfig;
    readonly overrides?: Partial<ValidationConfig>;
  } = {},
): TableSnapshot['hand']['bettingRounds'][number]['turns'][number]['legalOptions'] {
  if (snapshot.hand.stage === 'showdown' || snapshot.hand.stage === 'settled') {
    return [];
  }

  if (!actor) {
    return [];
  }
  const round = snapshot.hand.bettingRounds.at(-1);
  if (!round) {
    return [];
  }

  const seatLookup = findSeatByPlayerId(snapshot.seating, actor);
  if (!seatLookup) {
    return [];
  }

  const computation = deriveRoundComputation(round);
  const playerContribution = computation.contributions.get(actor) ?? 0;
  const callAmount = Math.max(
    0,
    computation.highestContribution - playerContribution,
  );

  const foldedPlayers = collectFoldedPlayers(snapshot.hand);
  const pendingEliminations = new Set(snapshot.flags.pendingEliminations);
  const allInPlayers = collectAllInPlayers(snapshot);
  const opponents = snapshot.seating.seats.filter((seat) => {
    const occupant = seat.occupant;
    if (!occupant) {
      return false;
    }
    if (occupant.playerId === actor) {
      return false;
    }
    if (foldedPlayers.has(occupant.playerId)) {
      return false;
    }
    if (pendingEliminations.has(occupant.playerId)) {
      return false;
    }
    return true;
  });

  const hasOpponentWithChips = opponents.some((seat) => {
    const occupant = seat.occupant;
    if (!occupant) {
      return false;
    }
    if (allInPlayers.has(occupant.playerId)) {
      return false;
    }
    return seat.stack > 0;
  });

  if (opponents.length > 0 && !hasOpponentWithChips && callAmount === 0) {
    return [];
  }

  const totalPot = sumPotAmounts(snapshot.pots);

  const resolvedBettingStructure =
    options.overrides?.bettingStructure ??
    options.sessionConfig?.bettingStructure ??
    'no-limit';
  const resolvedRuleSet =
    options.overrides?.ruleSet ?? options.sessionConfig?.ruleSet;
  const resolvedSmallBlind =
    options.overrides?.smallBlind ?? snapshot.hand.blinds.smallBlind.amount;
  const resolvedBigBlind =
    options.overrides?.bigBlind ?? snapshot.hand.blinds.bigBlind.amount;
  const resolvedMinRaiseIncrement =
    options.overrides?.minRaiseIncrement ??
    deriveMinRaiseIncrement({
      bettingStructure: resolvedBettingStructure,
      ruleSet: resolvedRuleSet,
      bigBlind: resolvedBigBlind,
      currentStage: round.stage,
    });
  const resolvedMaxRaisesPerRound =
    options.overrides?.maxRaisesPerRound ??
    deriveMaxRaisesPerRound({
      bettingStructure: resolvedBettingStructure,
      ruleSet: resolvedRuleSet,
    });

  const config: ValidationConfig = {
    bettingStructure: resolvedBettingStructure,
    smallBlind: resolvedSmallBlind,
    bigBlind: resolvedBigBlind,
    minRaiseIncrement: resolvedMinRaiseIncrement,
    maxRaisesPerRound: resolvedMaxRaisesPerRound,
    ruleSet: resolvedRuleSet,
  } satisfies ValidationConfig;

  const computed = determineLegalOptions({
    config,
    context: {
      callAmount,
      highestContribution: computation.highestContribution,
      lastRaiseSize: computation.lastAggressiveRaise,
      playerContribution,
      remainingStack: seatLookup.seat.stack,
      totalPot,
      raisesThisRound: computation.raisesThisRound,
      lastActedHighestContribution:
        computation.lastActedHighestContribution.get(actor),
    },
  });

  return computed.options;
}

interface MinRaiseConfig {
  readonly bettingStructure: ValidationConfig['bettingStructure'];
  readonly ruleSet?: SessionConfig['ruleSet'];
  readonly bigBlind: number;
  readonly currentStage: TableSnapshot['hand']['stage'];
}

function deriveMinRaiseIncrement(config: MinRaiseConfig): number | undefined {
  const baseIncrement = Math.max(config.bigBlind, 1);
  const policy = resolveMinRaisePolicy(config.bettingStructure, config.ruleSet);

  if (policy !== 'fixed-increment') {
    return baseIncrement;
  }

  const isLateStreet =
    config.currentStage === 'turn' || config.currentStage === 'river';
  return isLateStreet ? baseIncrement * 2 : baseIncrement;
}

interface MaxRaiseConfig {
  readonly bettingStructure: ValidationConfig['bettingStructure'];
  readonly ruleSet?: SessionConfig['ruleSet'];
}

function deriveMaxRaisesPerRound(config: MaxRaiseConfig): number | undefined {
  const minPolicy = resolveMinRaisePolicy(
    config.bettingStructure,
    config.ruleSet,
  );
  if (minPolicy !== 'fixed-increment') {
    return undefined;
  }

  const maxPolicy = resolveMaxRaisePolicy(
    config.bettingStructure,
    config.ruleSet,
  );
  if (maxPolicy === 'pot') {
    return undefined;
  }

  return 4;
}
