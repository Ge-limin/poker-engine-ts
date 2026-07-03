import { useState } from 'react';
import type { SerializableSessionState } from 'poker-engine-ts';
import { PlayTab } from './play';
import { ReplayTab, type ReplaySubject } from './replay';
import { RulesTab } from './rules';
import { TortureTab } from './torture';

type TabId = 'play' | 'replay' | 'rules' | 'torture';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'play', label: 'Play a hand' },
  { id: 'replay', label: 'Replay and fork' },
  { id: 'rules', label: 'Rules lab' },
  { id: 'torture', label: 'Torture test' },
];

export function App() {
  const [tab, setTab] = useState<TabId>('play');
  const [imported, setImported] = useState<ReplaySubject | null>(null);

  const openInReplay = (state: SerializableSessionState, names: Record<string, string>) => {
    setImported({ state, names, label: 'Your hand from the play tab' });
    setTab('replay');
  };

  return (
    <main className="app">
      <header className="masthead">
        <h1>
          poker-engine-ts <span className="muted">· playground</span>
          <a
            className="repo-link"
            href="https://github.com/Ge-limin/poker-engine-ts"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </h1>
        <p className="masthead-sub">
          Everything on this page is computed by the engine running in this
          browser tab, through the same public API a Node backend imports.
          None of it is prerecorded.
        </p>
        <nav className="tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              className={tab === entry.id ? 'active' : ''}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>
      <div style={{ display: tab === 'play' ? 'block' : 'none' }}>
        <PlayTab onOpenInReplay={openInReplay} />
      </div>
      {tab === 'replay' && <ReplayTab imported={imported} />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'torture' && <TortureTab />}
    </main>
  );
}
