import type { PokerStateFixtureOrigin } from '../types/random-state';

export function formatFixtureTimestamp(date: Date): string {
  return date
    .toISOString()
    .toLowerCase()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}z$/, 'z');
}

export function buildFixtureId(
  origin: PokerStateFixtureOrigin,
  createdAt: Date,
): string {
  return `${origin}-${formatFixtureTimestamp(createdAt)}`;
}
