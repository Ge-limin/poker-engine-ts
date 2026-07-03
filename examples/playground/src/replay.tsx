// Tab 2: real time travel. The slider rebuilds the table from a prefix of the
// event log with SessionManager.resume; the fork panel rebuilds a prefix and
// then plays a different legal action into it; the guard panel shows what the
// runtime mode guards do to a mutation attempt while the session is in replay.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSeededRandom } from 'poker-engine-ts/testing';
import type { PlayerOption, SerializableSessionState, TableSnapshot } from 'poker-engine-ts';
import {
  bootstrapHand,
  buildIntent,
  decisionOf,
  describeOptionWindow,
  makeConfig,
  pickBotOption,
  resumeFromState,
  serializeManager,
} from './engine-helpers';
import { Board, PotsView, SeatsView, TimelineView } from './table-view';

const FAMOUS_NAMES: Record<string, string> = {
  alice: 'Alice',
  bob: 'Bob',
  carol: 'Carol',
  dave: 'Dave',
};

export interface ReplaySubject {
  readonly state: SerializableSessionState;
  readonly names: Record<string, string>;
  readonly label: string;
}

// Four unequal stacks, everyone all in: the hand that builds a main pot and
// three side pots. Driven through applyIntent once, here, in your browser.
async function buildFamousHand(): Promise<SerializableSessionState> {
  const rng = createSeededRandom(42);
  const seats = [
    { playerId: 'alice', seatIndex: 0, stack: 20 },
    { playerId: 'bob', seatIndex: 1, stack: 45 },
    { playerId: 'carol', seatIndex: 2, stack: 80 },
    { playerId: 'dave', seatIndex: 3, stack: 120 },
  ];
  const state = await bootstrapHand(makeConfig(1, 2), seats, rng);
  const manager = resumeFromState(state);
  for (let guard = 0; guard < 60; guard += 1) {
    const decision = decisionOf(manager);
    if (!decision.actor) break;
    const legal = decision.availableActions.filter((option) => !option.disabled);
    const choice =
      legal.find((option) => option.type === 'all-in') ??
      legal.find((option) => option.type === 'call') ??
      legal.find((option) => option.type === 'check') ??
      legal[0];
    if (!choice) break;
    const result = await manager.applyIntent(
      buildIntent(decision.actor, choice, manager.session, 'automation'),
    );
    if (result.validation.kind !== 'accepted') {
      throw new Error(`featured hand intent rejected: ${result.validation.reason}`);
    }
    if (manager.session.activeSnapshot.hand.stage === 'settled') break;
  }
  return serializeManager(manager);
}

interface ForkRun {
  readonly atIndex: number;
  readonly actorName: string;
  readonly taken: string;
  readonly state: SerializableSessionState;
}

export function ReplayTab({ imported }: { imported: ReplaySubject | null }) {
  const [famous, setFamous] = useState<ReplaySubject | null>(null);
  const [useImported, setUseImported] = useState(true);
  const [position, setPosition] = useState(0);
  const [fork, setFork] = useState<ForkRun | null>(null);
  const [guardLog, setGuardLog] = useState<readonly string[] | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const bootedRef = useRef(false);
  const cacheRef = useRef(new Map<number, TableSnapshot>());

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    buildFamousHand()
      .then((state) =>
        setFamous({
          state,
          names: FAMOUS_NAMES,
          label: 'Featured hand: four stacks, four pots',
        }),
      )
      .catch((error) => setFatal(String(error)));
  }, []);

  const subject = (useImported ? imported : null) ?? famous;
  const eventCount = subject?.state.events.length ?? 0;

  // Whenever the subject changes, jump to the end and drop derived state.
  useEffect(() => {
    cacheRef.current.clear();
    setFork(null);
    setGuardLog(null);
    setPosition(subject?.state.events.length ?? 0);
  }, [subject]);

  const snapshotAt = useCallback(
    (index: number): TableSnapshot | null => {
      if (!subject) return null;
      const cached = cacheRef.current.get(index);
      if (cached) return cached;
      const manager = resumeFromState({
        ...subject.state,
        events: subject.state.events.slice(0, index),
      });
      const snapshot = manager.session.activeSnapshot;
      cacheRef.current.set(index, snapshot);
      return snapshot;
    },
    [subject],
  );

  const snapshot = useMemo(() => snapshotAt(position), [snapshotAt, position]);

  const forkOptions = useMemo(() => {
    if (!subject || position >= eventCount) return null;
    const manager = resumeFromState({
      ...subject.state,
      events: subject.state.events.slice(0, position),
    });
    const decision = decisionOf(manager);
    if (!decision.actor) return null;
    return {
      actor: decision.actor,
      options: decision.availableActions.filter((option) => !option.disabled),
    };
  }, [subject, position, eventCount]);

  const runFork = useCallback(
    async (option: PlayerOption) => {
      if (!subject || !forkOptions) return;
      const manager = resumeFromState({
        ...subject.state,
        events: subject.state.events.slice(0, position),
      });
      const first = await manager.applyIntent(
        buildIntent(forkOptions.actor, option, manager.session, 'ui'),
      );
      if (first.validation.kind !== 'accepted') {
        setFatal(`fork intent rejected: ${first.validation.reason}`);
        return;
      }
      const rng = createSeededRandom(1000 + position);
      for (let guard = 0; guard < 120; guard += 1) {
        if (manager.session.activeSnapshot.hand.stage === 'settled') break;
        const decision = decisionOf(manager);
        if (!decision.actor) break;
        const pick = pickBotOption(decision.availableActions, rng);
        if (!pick) break;
        const result = await manager.applyIntent(
          buildIntent(decision.actor, pick.option, manager.session, 'automation', pick.sizeTo),
        );
        if (result.validation.kind !== 'accepted') {
          setFatal(`fork playout rejected: ${result.validation.reason}`);
          return;
        }
      }
      setFork({
        atIndex: position,
        actorName: subject.names[forkOptions.actor] ?? forkOptions.actor,
        taken: describeOptionWindow(option),
        state: serializeManager(manager),
      });
    },
    [subject, forkOptions, position],
  );

  const runGuardDemo = useCallback(async () => {
    if (!subject) return;
    const steps: string[] = [];
    let manager = null;
    for (let index = 0; index <= eventCount; index += 1) {
      const candidate = resumeFromState({
        ...subject.state,
        events: subject.state.events.slice(0, index),
      });
      if (decisionOf(candidate).actor) {
        manager = candidate;
        steps.push(`resume() rebuilt the session at event ${index}, someone is to act`);
        break;
      }
    }
    if (!manager) {
      setGuardLog(['No decision point found in this hand.']);
      return;
    }
    const decision = decisionOf(manager);
    const option = decision.availableActions.filter((candidate) => !candidate.disabled)[0];
    if (!decision.actor || !option) return;
    const intent = buildIntent(decision.actor, option, manager.session, 'ui');
    manager.enterReplay();
    steps.push('enterReplay(): the session is now a read-only timeline');
    try {
      await manager.applyIntent(intent);
      steps.push('applyIntent(): accepted. That would be a bug; please report it.');
    } catch (error) {
      const err = error as Error;
      steps.push(`applyIntent() threw ${err.name}: ${err.message}`);
    }
    manager.exitReplay();
    steps.push('exitReplay(): back to live mode');
    const retry = await manager.applyIntent(intent);
    steps.push(
      retry.validation.kind === 'accepted'
        ? 'applyIntent(): the same intent is accepted and appended to the log'
        : `applyIntent(): rejected (${retry.validation.reason})`,
    );
    setGuardLog(steps);
  }, [subject, eventCount]);

  if (fatal) return <pre className="error">{fatal}</pre>;
  if (!subject || !snapshot) return <p className="muted">Building the featured hand…</p>;

  const names = subject.names;
  const originalFinal = snapshotAt(eventCount);

  return (
    <section>
      <p className="tagline">
        Every position on this timeline is rebuilt on the spot:
        SessionManager.resume replays the first N events of the log and hands
        back the table state. Scrubbing here replays history rather than paging
        through saved frames. Pick any decision and play a different legal
        action to fork the hand.
      </p>

      <div className="controls subject-bar">
        <span className="frame-label">{useImported && imported ? imported.label : subject.label}</span>
        {imported && (
          <button onClick={() => setUseImported((value) => !value)}>
            {useImported ? 'Show the featured hand' : 'Back to your hand'}
          </button>
        )}
      </div>

      <Board snapshot={snapshot} />

      <div className="live-cols">
        <SeatsView snapshot={snapshot} names={names} revealAll />
        <PotsView snapshot={snapshot} names={names} />
        <section className="log">
          <h2>Timeline</h2>
          <p className="muted small">Click an event to rebuild the table right after it.</p>
          <TimelineView
            events={subject.state.events}
            names={names}
            highlightUpTo={position}
            onPick={setPosition}
          />
        </section>
      </div>

      <footer className="controls">
        <button onClick={() => setPosition(0)} disabled={position === 0}>
          start
        </button>
        <button onClick={() => setPosition((value) => Math.max(0, value - 1))} disabled={position === 0}>
          back
        </button>
        <button
          onClick={() => setPosition((value) => Math.min(eventCount, value + 1))}
          disabled={position >= eventCount}
        >
          forward
        </button>
        <input
          type="range"
          min={0}
          max={eventCount}
          value={position}
          onChange={(event) => setPosition(Number(event.target.value))}
        />
        <span className="frame-label">
          rebuilt after event {position} of {eventCount}
        </span>
      </footer>

      <div className="side-actions">
        <div className="kill-card">
          <h2>Fork the timeline</h2>
          {forkOptions ? (
            <>
              <p className="muted small">
                At this point {names[forkOptions.actor] ?? forkOptions.actor} could
                have chosen any of these. Pick one; the engine rebuilds the first{' '}
                {position} events, validates the new action, and plays the rest out.
              </p>
              <div className="option-chips">
                {forkOptions.options.map((option, index) => (
                  <button key={index} className="chip chip-button" onClick={() => void runFork(option)}>
                    {describeOptionWindow(option)}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="muted small">
              Nobody is to act at this position. Step to a decision point to fork.
            </p>
          )}
        </div>

        <div className="kill-card">
          <h2>Replay mode is guarded</h2>
          <p className="muted small">
            A session in replay mode refuses mutations with a typed error. Run
            the sequence and read the engine's own words.
          </p>
          <button onClick={() => void runGuardDemo()}>Run the guard sequence</button>
          {guardLog && (
            <ol className="guard-log">
              {guardLog.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          )}
        </div>
      </div>

      {fork && originalFinal && (
        <div className="fork-compare">
          <h2>
            Fork at event {fork.atIndex}: {fork.actorName} plays {fork.taken} instead
          </h2>
          <div className="fork-cols">
            <div>
              <h3>Original ending</h3>
              <Board snapshot={originalFinal} />
              <PotsView snapshot={originalFinal} names={names} />
            </div>
            <div>
              <h3>Forked ending</h3>
              <Board snapshot={fork.state.activeSnapshot} />
              <PotsView snapshot={fork.state.activeSnapshot} names={names} />
              <TimelineView events={fork.state.events} names={names} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
