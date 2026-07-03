import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANDOM_STATE_SEATS,
  generateRandomState,
} from '../simulation/random-state-generator';
import type { TableSnapshot } from '../types/snapshot';
import { deriveSeatPositionLabels } from '../utils/position-labels';

function constantRng(value: number) {
  return () => value;
}

function findSeatIndex(snapshot: TableSnapshot, playerId: string) {
  const seat = snapshot.seating.seats.find(
    (entry) => entry.occupant?.playerId === playerId,
  );
  return seat?.index ?? null;
}

describe('deriveSeatPositionLabels', () => {
  it('labels six-handed tables with canonical positions', async () => {
    const summary = await generateRandomState({
      seats: DEFAULT_RANDOM_STATE_SEATS,
      steps: { min: 0, max: 0 },
      random: constantRng(0.25),
    });

    const snapshot = summary.session.activeSnapshot;
    const lookup = deriveSeatPositionLabels(snapshot);

    const occupied = snapshot.seating.seats.filter(
      (seat) => seat.occupant,
    ).length;
    expect(lookup.size).toBe(occupied);

    const buttonSeat =
      snapshot.hand.buttonSeat ?? snapshot.seating.dealerButton;
    expect(lookup.get(buttonSeat)).toBe('BTN');

    const smallBlindPlayer = snapshot.hand.blinds.smallBlind.playerId;
    const smallBlindSeat = findSeatIndex(snapshot, smallBlindPlayer);
    expect(smallBlindSeat).not.toBeNull();
    expect(lookup.get(smallBlindSeat!)).toBe('SB');

    expect(Array.from(lookup.values())).toContain('CO');
  });

  it('labels three-handed tables with distinct blinds', async () => {
    const summary = await generateRandomState({
      seats: DEFAULT_RANDOM_STATE_SEATS.slice(0, 3),
      steps: { min: 0, max: 0 },
      random: constantRng(0.42),
    });

    const snapshot = summary.session.activeSnapshot;
    const lookup = deriveSeatPositionLabels(snapshot);

    expect(lookup.size).toBe(3);

    const buttonSeat =
      snapshot.hand.buttonSeat ?? snapshot.seating.dealerButton;
    expect(lookup.get(buttonSeat)).toBe('BTN');

    const smallBlindSeat = findSeatIndex(
      snapshot,
      snapshot.hand.blinds.smallBlind.playerId,
    );
    expect(smallBlindSeat).not.toBeNull();
    expect(lookup.get(smallBlindSeat!)).toBe('SB');

    const bigBlindSeat = findSeatIndex(
      snapshot,
      snapshot.hand.blinds.bigBlind.playerId,
    );
    expect(bigBlindSeat).not.toBeNull();
    expect(lookup.get(bigBlindSeat!)).toBe('BB');

    expect(new Set(lookup.values())).toEqual(new Set(['BTN', 'SB', 'BB']));
  });

  it('labels heads-up tables with button and big blind positions', async () => {
    const summary = await generateRandomState({
      seats: DEFAULT_RANDOM_STATE_SEATS.slice(0, 2),
      steps: { min: 0, max: 0 },
      random: constantRng(0.11),
    });

    const snapshot = summary.session.activeSnapshot;
    const lookup = deriveSeatPositionLabels(snapshot);

    expect(lookup.size).toBe(2);

    const buttonSeat =
      snapshot.hand.buttonSeat ?? snapshot.seating.dealerButton;
    expect(lookup.get(buttonSeat)).toBe('BTN/SB');

    const bigBlindSeat = findSeatIndex(
      snapshot,
      snapshot.hand.blinds.bigBlind.playerId,
    );
    expect(bigBlindSeat).not.toBeNull();
    expect(lookup.get(bigBlindSeat!)).toBe('BB');
  });
});
