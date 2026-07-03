export interface ReplayQueueEntry {
  readonly id: string;
  readonly recordedAt: number;
  readonly payloadVersion: number;
}

export function appendReplayEntry(
  queue: readonly ReplayQueueEntry[],
  entry: ReplayQueueEntry,
  retentionHands: number,
): readonly ReplayQueueEntry[] {
  const filtered = queue.filter((existing) => existing.id !== entry.id);
  const next = [...filtered, entry];
  next.sort((a, b) => {
    if (a.recordedAt !== b.recordedAt) {
      return a.recordedAt - b.recordedAt;
    }
    return a.id.localeCompare(b.id);
  });

  if (retentionHands <= 0) {
    return next;
  }

  return next.slice(-retentionHands);
}
