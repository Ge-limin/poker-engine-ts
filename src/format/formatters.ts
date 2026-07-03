import type { Card } from '../types/common';
import type {
  CardRevealMetadata,
  PlayerAction,
  PlayerOption,
  TurnEventEnvelope,
} from '../types/events';

export function formatOptionLabel(option: PlayerOption): string {
  switch (option.type) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return option.amount === 0 ? 'Check' : `Call ${option.amount}`;
    case 'bet':
      return `Bet ${option.min}`;
    case 'raise':
      return `Raise ${option.min}`;
    case 'all-in':
      return `All-in ${option.amount}`;
    default:
      return 'Action';
  }
}

export function formatCards(
  cards:
    | readonly string[]
    | readonly [string, string, string]
    | null
    | undefined,
): string {
  if (!cards || cards.length === 0) {
    return '—';
  }

  return cards.join(' ');
}

export function formatDeckSummary(cards: readonly Card[]): string {
  if (cards.length === 0) {
    return 'Empty';
  }

  if (cards.length <= 12) {
    return cards.join(' ');
  }

  const preview = cards.slice(0, 12).join(' ');
  return `${preview} … (${cards.length} cards)`;
}

export function formatFrequency(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }

  const normalized = Math.min(Math.max(value, 0), 1);
  const percentage = normalized * 100;
  const decimals = percentage >= 10 ? 1 : 2;

  return `${percentage.toFixed(decimals)}%`;
}

export function formatPlayerAction(action: PlayerAction): string {
  switch (action.type) {
    case 'fold':
      return 'folds';
    case 'check':
      return 'checks';
    case 'call':
      return `calls ${action.amount}`;
    case 'bet':
      return `${action.isAllIn ? 'shoves' : 'bets'} ${action.amount}`;
    case 'raise': {
      const raiseTarget = action.to ? ` to ${action.to}` : '';
      return `${action.isAllIn ? 'raises all-in' : 'raises'} ${action.amount}${raiseTarget}`;
    }
    case 'all-in':
      return `moves all-in (${action.from}) for ${action.amount}`;
    case 'post-blind':
      return `posts ${action.blind} blind ${action.amount}`;
    case 'post-ante':
      return `posts ante ${action.amount}`;
    case 'timeout':
      return `times out (defaults to ${action.fallback})`;
    case 'resume':
      return 'resumes play';
    default:
      return 'acts';
  }
}

export function describeCardReveals(
  metadata: CardRevealMetadata | undefined,
  playerNameById: Map<string, string>,
): string | null {
  if (!metadata) {
    return null;
  }

  const segments: string[] = [];

  metadata.community?.forEach((entry) => {
    segments.push(`${entry.stage}: ${formatCards(entry.cards)}`);
  });

  if (metadata.holeCards) {
    Object.entries(metadata.holeCards).forEach(([playerId, cards]) => {
      if (!cards || cards.length === 0) {
        return;
      }

      const name = playerNameById.get(playerId) ?? playerId;
      segments.push(`${name} shows ${formatCards(cards)}`);
    });
  }

  return segments.length > 0 ? segments.join(' • ') : null;
}

export function formatTimelineTimestamp(timestamp: unknown): string | null {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  if (typeof timestamp === 'string' && timestamp.length > 0) {
    return timestamp;
  }

  return null;
}

export interface TimelineEntry {
  readonly id: string;
  readonly label: string;
  readonly timestamp: string | null;
  readonly details: string;
}

export function buildTimelineEntries(
  events: readonly TurnEventEnvelope[],
  playerNameById: Map<string, string>,
): TimelineEntry[] {
  return events.map((envelope, index) => {
    const event = envelope.event;
    const actor = playerNameById.get(event.actor) ?? event.actor;
    const actionSummary = formatPlayerAction(event.action);
    const stageTransition = event.metadata?.nextHandStage
      ? `→ ${event.metadata.nextHandStage}`
      : null;
    const revealSummary = describeCardReveals(
      event.metadata?.cardReveals,
      playerNameById,
    );
    const timestampLabel = formatTimelineTimestamp(event.timestamp);

    const details = [
      `${actor} ${actionSummary}`,
      stageTransition ? `(${stageTransition})` : null,
      revealSummary ? `• ${revealSummary}` : null,
    ]
      .filter(Boolean)
      .join(' ');

    return {
      id: event.id,
      label: `#${index + 1}`,
      timestamp: timestampLabel,
      details,
    };
  });
}
