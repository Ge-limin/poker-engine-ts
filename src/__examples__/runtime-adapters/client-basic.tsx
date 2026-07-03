'use client';

import type { Session } from '../../index';
import {
  isInteractiveRuntime,
  useScenarioTimeline,
  useSessionView,
} from '../../session/adapters/client';

interface SessionPanelProps {
  readonly session: Session | null;
}

export function SessionPanel({ session }: SessionPanelProps) {
  const view = useSessionView(session);
  const timeline = useScenarioTimeline(session);

  if (!view) {
    return <div data-test="session-empty">Waiting for session data…</div>;
  }

  return (
    <section data-test="session-panel">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Hand #{view.table.handNumber}</h2>
        <span className="text-muted-foreground text-sm">
          Runtime: {view.runtime.mode}
        </span>
      </header>
      <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Current actor</dt>
          <dd>{view.decision.actor ?? 'Waiting for action'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pot total</dt>
          <dd>{view.table.potTotal}</dd>
        </div>
      </dl>
      <ol className="mt-4 space-y-1 text-xs" data-test="timeline">
        {timeline.map((entry) => (
          <li
            key={entry.event.id}
            className={
              entry.isCurrent
                ? 'text-primary font-semibold'
                : entry.isFuture
                  ? 'text-muted-foreground'
                  : ''
            }
          >
            #{entry.index + 1} · {entry.event.action.type}
          </li>
        ))}
      </ol>
      <footer className="mt-4 text-xs">
        {session && isInteractiveRuntime(session)
          ? 'Interactive session'
          : 'Playback mode'}
      </footer>
    </section>
  );
}
