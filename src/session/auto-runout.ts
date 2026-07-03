import {
  collectAllInPlayers,
  collectFoldedPlayers,
} from '../core/utils/snapshot';
import type {
  CardRevealMetadata,
  CommunityRevealMetadata,
  TurnEvent,
} from '../types/events';
import type { SessionConfig } from '../types/session';
import type { CardLedger, TableSnapshot } from '../types/snapshot';
import { deriveLegalOptionsForActor } from './legal-options';
import { applyCommunityDistribution } from './lifecycle';

interface AutoRunoutResult {
  readonly snapshot: TableSnapshot;
  readonly cardReveals?: CardRevealMetadata;
}

interface AutoRunoutParams {
  readonly snapshot: TableSnapshot;
  readonly config: SessionConfig;
  readonly recentEvent: TurnEvent;
  readonly timestamp: number;
}

export function applyAutoRunout(params: AutoRunoutParams): AutoRunoutResult {
  const { snapshot, config, recentEvent, timestamp } = params;

  if (snapshot.flags.autoRunout) {
    return { snapshot };
  }

  const foldedPlayers = collectFoldedPlayers(snapshot.hand);
  const contenders = snapshot.seating.seats.filter((seat) => {
    const playerId = seat.occupant?.playerId;
    if (!playerId) {
      return false;
    }
    if (foldedPlayers.has(playerId)) {
      return false;
    }
    return true;
  });

  if (contenders.length <= 1) {
    return { snapshot };
  }

  const allInPlayers = collectAllInPlayers(snapshot, recentEvent);
  const activePlayers = contenders.filter((seat) => {
    const playerId = seat.occupant!.playerId;
    if (allInPlayers.has(playerId)) {
      return false;
    }
    return seat.stack > 0;
  });

  const actor = snapshot.clock.currentActor;
  const actorHasActions = actor
    ? deriveLegalOptionsForActor(snapshot, actor, {
        sessionConfig: config,
      }).some((option) => !option.disabled)
    : false;

  const shouldRunout =
    activePlayers.length === 0 ||
    (activePlayers.length === 1 && !actorHasActions);

  if (!shouldRunout) {
    return { snapshot };
  }

  const cardsResult = revealRemainingBoard(snapshot.cards, config, timestamp);
  const flags = {
    ...snapshot.flags,
    autoRunout: true,
  };
  const clock = {
    ...snapshot.clock,
    currentActor: undefined,
    deadline: undefined,
  };

  const updatedSnapshot: TableSnapshot = {
    ...snapshot,
    cards: cardsResult.ledger,
    flags,
    clock,
  };

  const cardReveals =
    cardsResult.reveals.length > 0
      ? ({ community: cardsResult.reveals } as CardRevealMetadata)
      : undefined;

  return {
    snapshot: updatedSnapshot,
    cardReveals,
  };
}

interface RevealResult {
  readonly ledger: CardLedger;
  readonly reveals: readonly CommunityRevealMetadata[];
}

function revealRemainingBoard(
  ledger: CardLedger,
  config: SessionConfig,
  timestamp: number,
): RevealResult {
  const stages: ReadonlyArray<'flop' | 'turn' | 'river'> = [
    'flop',
    'turn',
    'river',
  ];

  let workingLedger = ledger;
  const reveals: CommunityRevealMetadata[] = [];

  for (const stage of stages) {
    const alreadyRevealed =
      stage === 'flop'
        ? Boolean(workingLedger.community.flop)
        : stage === 'turn'
          ? Boolean(workingLedger.community.turn)
          : Boolean(workingLedger.community.river);

    if (alreadyRevealed) {
      continue;
    }

    try {
      const scheduleStart = workingLedger.community.revealSchedule.length;
      const result = applyCommunityDistribution({
        ledger: workingLedger,
        config,
        stage,
        timestamp,
      });
      workingLedger = result.ledger;
      const newEntries =
        result.ledger.community.revealSchedule.slice(scheduleStart);
      for (const entry of newEntries) {
        if (
          entry.stage === 'flop' ||
          entry.stage === 'turn' ||
          entry.stage === 'river'
        ) {
          reveals.push({
            stage: entry.stage,
            cards: entry.cards,
            reason: entry.reason,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isDeckExhausted = message.includes('Insufficient cards remaining');

      if (isDeckExhausted) {
        // Stop attempting further reveals when the deck runs out of cards.
        break;
      }

      throw error;
    }
  }

  return { ledger: workingLedger, reveals };
}
