import type { PlayerId, SeatIndex } from '../types/common';
import type { TableSnapshot } from '../types/snapshot';

const POSITION_TEMPLATES: Record<number, readonly string[]> = {
  2: ['BTN/SB', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'UTG'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'HJ', 'CO'],
  8: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO'],
  10: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'MP', 'LJ', 'HJ', 'CO'],
} as const;

export function deriveSeatPositionLabels(
  snapshot: TableSnapshot,
): Map<SeatIndex, string> {
  const occupiedSeats = snapshot.seating.seats.filter((seat) => seat?.occupant);
  const template = POSITION_TEMPLATES[occupiedSeats.length] ?? [];

  const lookup = new Map<SeatIndex, string>();
  if (occupiedSeats.length === 0) {
    return lookup;
  }

  const buttonSeat = snapshot.hand.buttonSeat ?? snapshot.seating.dealerButton;
  const totalSeats = snapshot.seating.seats.length;

  let templateIndex = 0;
  for (
    let step = 0;
    step < totalSeats && templateIndex < occupiedSeats.length;
    step += 1
  ) {
    const seatIndex = ((buttonSeat + step) % totalSeats) as SeatIndex;
    const seat = snapshot.seating.seats[seatIndex];
    if (!seat?.occupant) {
      continue;
    }

    const label = template[templateIndex] ?? `Seat ${seat.index + 1}`;
    lookup.set(seatIndex, label);
    templateIndex += 1;
  }

  return lookup;
}

export function derivePlayerPositionLabel(
  snapshot: TableSnapshot,
  playerId: PlayerId,
): string | null {
  const lookup = deriveSeatPositionLabels(snapshot);
  const seat = snapshot.seating.seats.find(
    (entry) => entry.occupant?.playerId === playerId,
  );

  if (!seat) {
    return null;
  }

  return lookup.get(seat.index) ?? null;
}
