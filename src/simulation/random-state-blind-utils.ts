import type { Chips, PlayerId } from '../types/common';
import type { PlayerOption } from '../types/events';
import type { BettingRound, TableSnapshot } from '../types/snapshot';

type OptionWithAmount = {
  readonly type: PlayerOption['type'];
  readonly amount?: number;
};

type OptionWithCallAmount = OptionWithAmount & {
  readonly type: 'call';
  readonly amount: number;
};

function isCallOption(
  option: OptionWithAmount,
): option is OptionWithCallAmount {
  return option.type === 'call' && typeof option.amount === 'number';
}

function findCurrentBettingRound(snapshot: TableSnapshot): BettingRound | null {
  const stage = snapshot.hand.stage;
  for (
    let index = snapshot.hand.bettingRounds.length - 1;
    index >= 0;
    index -= 1
  ) {
    const round = snapshot.hand.bettingRounds[index];
    if (!round) {
      continue;
    }
    if (round.stage === stage) {
      return round;
    }
  }
  return null;
}

export function resolvePostedBlindAmount(
  snapshot: TableSnapshot,
  actor: PlayerId,
): Chips {
  if (snapshot.hand.stage !== 'preflop') {
    return 0;
  }

  const { smallBlind, bigBlind, straddles } = snapshot.hand.blinds;
  const commitments = [smallBlind, bigBlind, ...(straddles ?? [])];

  for (const commitment of commitments) {
    if (
      commitment.playerId === actor &&
      !commitment.isDead &&
      typeof commitment.amount === 'number'
    ) {
      return commitment.amount;
    }
  }

  return 0;
}

export function normalizeCallOptionForDisplay<TOption extends OptionWithAmount>(
  option: TOption,
  postedAmount: Chips,
): TOption {
  if (!isCallOption(option) || postedAmount <= 0) {
    return option;
  }

  const adjusted = Math.max(0, option.amount - postedAmount);
  if (adjusted === option.amount) {
    return option;
  }

  return { ...option, amount: adjusted } as TOption;
}

export function normalizeCallOptionForApi<TOption extends OptionWithAmount>(
  option: TOption,
  snapshot: TableSnapshot,
  actor: PlayerId,
): TOption {
  if (!isCallOption(option)) {
    return option;
  }

  const currentRound = findCurrentBettingRound(snapshot);
  const highestBet = currentRound?.highestBet ?? 0;
  if (highestBet > 0 && option.amount >= highestBet) {
    return option;
  }

  const posted = resolvePostedBlindAmount(snapshot, actor);
  if (posted <= 0) {
    return option;
  }

  const adjusted = option.amount + posted;
  if (adjusted === option.amount) {
    return option;
  }

  return { ...option, amount: adjusted } as TOption;
}
