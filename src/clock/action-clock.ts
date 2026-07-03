import type { ActionClock, PauseWindow } from '../types/snapshot';

export interface ClockAdvanceResult {
  readonly clock: ActionClock;
  readonly usedBankMs: number;
  readonly exhausted: boolean;
}

export function advanceActionClock(
  clock: ActionClock,
  actor: string,
  now: number,
): ClockAdvanceResult {
  if (clock.currentActor !== actor) {
    return { clock, usedBankMs: 0, exhausted: false };
  }

  if (clock.perTurnMs <= 0) {
    if (clock.deadline === undefined) {
      return { clock, usedBankMs: 0, exhausted: false };
    }

    return {
      clock: { ...clock, deadline: undefined },
      usedBankMs: 0,
      exhausted: false,
    } satisfies ClockAdvanceResult;
  }

  const activePause = clock.pauses.find(
    (pause) => pause.resumedAt === undefined,
  );
  if (activePause) {
    return { clock, usedBankMs: 0, exhausted: false };
  }

  const deadline = clock.deadline;
  if (deadline === undefined) {
    return {
      clock: {
        ...clock,
        deadline: now + clock.perTurnMs,
      },
      usedBankMs: 0,
      exhausted: false,
    };
  }

  if (now <= deadline) {
    return {
      clock: {
        ...clock,
        deadline: now + clock.perTurnMs,
      },
      usedBankMs: 0,
      exhausted: false,
    };
  }

  const pausedDuration = computePausedDuration(clock.pauses, deadline, now);
  const overtime = Math.max(0, now - deadline - pausedDuration);
  if (overtime === 0) {
    return {
      clock: {
        ...clock,
        deadline: now + clock.perTurnMs,
      },
      usedBankMs: 0,
      exhausted: false,
    };
  }

  const availableBank = clock.bankMs[actor] ?? 0;
  const usedBankMs = Math.min(availableBank, overtime);
  const exhausted = overtime > availableBank;
  const updatedBank = {
    ...clock.bankMs,
    [actor]: Math.max(0, availableBank - overtime),
  };

  return {
    clock: {
      ...clock,
      bankMs: updatedBank,
      deadline: exhausted ? undefined : now + clock.perTurnMs,
    },
    usedBankMs,
    exhausted,
  };
}

export function startDealerPause(clock: ActionClock, now: number): ActionClock {
  const pause: PauseWindow = {
    reason: 'dealer-action',
    startedAt: now,
  };
  return { ...clock, pauses: clock.pauses.concat(pause) };
}

export function endDealerPause(clock: ActionClock, now: number): ActionClock {
  const updatedPauses: PauseWindow[] = [];
  let resolved = false;
  for (const pause of clock.pauses) {
    if (
      !resolved &&
      pause.reason === 'dealer-action' &&
      pause.resumedAt === undefined
    ) {
      updatedPauses.push({ ...pause, resumedAt: now });
      resolved = true;
    } else {
      updatedPauses.push(pause);
    }
  }
  return { ...clock, pauses: updatedPauses };
}

function computePausedDuration(
  pauses: readonly PauseWindow[],
  from: number,
  to: number,
): number {
  let total = 0;
  for (const pause of pauses) {
    if (pause.resumedAt === undefined) {
      continue;
    }
    const overlapStart = Math.max(from, pause.startedAt);
    const overlapEnd = Math.min(to, pause.resumedAt);
    if (overlapEnd > overlapStart) {
      total += overlapEnd - overlapStart;
    }
  }
  return total;
}
