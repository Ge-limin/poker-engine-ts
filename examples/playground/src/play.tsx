// Tab 1: sit in a seat and play a hand against three bots. Every action, yours
// and theirs, is a TurnIntent submitted to SessionManager.applyIntent, and the
// engine's validation verdict is shown as-is. At any moment you can kill the
// in-memory session and rebuild it from nothing but the event log.
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatOptionLabel } from 'poker-engine-ts/format';
import { createSeededRandom } from 'poker-engine-ts/testing';
import type { PlayerOption, SerializableSessionState, TableSnapshot } from 'poker-engine-ts';
import {
  bootstrapHand,
  buildIntent,
  decisionOf,
  describeOptionWindow,
  diffValues,
  makeConfig,
  pickBotOption,
  resumeFromState,
  serializeManager,
  type DiffResult,
  type PersistedLog,
} from './engine-helpers';
import { Board, PotsView, SeatsView, TimelineView } from './table-view';

export const HERO = 'hero';
export const PLAY_NAMES: Record<string, string> = {
  hero: 'Hero',
  ada: 'Ada',
  bix: 'Bix',
  cleo: 'Cleo',
};
const ORDER = ['hero', 'ada', 'bix', 'cleo'] as const;
const DEFAULT_STACKS: Record<string, number> = { hero: 100, ada: 60, bix: 80, cleo: 120 };
const CONFIG = makeConfig(1, 2);
const STORAGE_KEY = 'poker-playground.session.v3';

interface StoredSession {
  readonly handNumber: number;
  readonly state: SerializableSessionState;
}

interface CurrentView {
  readonly state: SerializableSessionState;
  readonly actor?: string;
  readonly options: readonly PlayerOption[];
}

interface KilledView {
  readonly logJson: string;
  readonly lastSeen: TableSnapshot;
  readonly eventCount: number;
}

interface ParityReport {
  readonly source: 'rebuild' | 'reload';
  readonly diff: DiffResult;
  readonly eventCount: number;
}

export interface PlayTabProps {
  readonly onOpenInReplay: (state: SerializableSessionState, names: Record<string, string>) => void;
}

export function PlayTab({ onOpenInReplay }: PlayTabProps) {
  const [current, setCurrent] = useState<CurrentView | null>(null);
  const [killed, setKilled] = useState<KilledView | null>(null);
  const [parity, setParity] = useState<ParityReport | null>(null);
  const [rejection, setRejection] = useState<{ attempted: string; reason: string } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [raiseTo, setRaiseTo] = useState('');
  const [handNumber, setHandNumber] = useState(0);
  const handNumberRef = useRef(0);
  const rngRef = useRef(createSeededRandom(Math.floor(Math.random() * 2 ** 31)));
  const bootedRef = useRef(false);

  const commit = useCallback((next: SerializableSessionState) => {
    const manager = resumeFromState(next);
    const decision = decisionOf(manager);
    setCurrent({ state: next, actor: decision.actor, options: decision.availableActions });
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ handNumber: handNumberRef.current, state: next } satisfies StoredSession),
    );
  }, []);

  const startHand = useCallback(
    async (stacks: Record<string, number>, hand: number) => {
      handNumberRef.current = hand;
      setHandNumber(hand);
      // The engine puts the button at seat 0, so shifting every player one
      // seat per hand moves the button and blinds around the table the way a
      // live game would.
      const alive = ORDER.filter((id) => (stacks[id] ?? 0) > 0);
      const seats = alive.map((playerId, position) => ({
        playerId,
        seatIndex: (position + hand) % alive.length,
        stack: stacks[playerId] ?? 0,
      }));
      const state = await bootstrapHand(CONFIG, seats, rngRef.current);
      setKilled(null);
      setRejection(null);
      commit(state);
    },
    [commit],
  );

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const revived = JSON.parse(stored) as StoredSession;
        handNumberRef.current = revived.handNumber ?? 0;
        setHandNumber(handNumberRef.current);
        const manager = resumeFromState(revived.state);
        const diff = diffValues(manager.session.activeSnapshot, revived.state.activeSnapshot);
        setParity({ source: 'reload', diff, eventCount: revived.state.events.length });
        commit(serializeManager(manager));
        return;
      } catch (error) {
        setFatal(`The stored session failed to rebuild: ${String(error)}`);
        return;
      }
    }
    void startHand(DEFAULT_STACKS, 0);
  }, [commit, startHand]);

  // Default the raise field to the engine's minimum whenever a new decision
  // comes up. The field itself accepts anything; legality is the engine's call.
  useEffect(() => {
    const sizing = current?.options.find(
      (option): option is Extract<PlayerOption, { type: 'bet' | 'raise' }> =>
        (option.type === 'raise' || option.type === 'bet') && !option.disabled,
    );
    setRaiseTo(sizing ? String(sizing.min) : '');
  }, [current]);

  // Bots act on a timer so you can watch the hand unfold.
  useEffect(() => {
    if (!current || killed) return;
    const snapshot = current.state.activeSnapshot;
    if (snapshot.hand.stage === 'settled') return;
    if (!current.actor || current.actor === HERO) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        const manager = resumeFromState(current.state);
        const decision = decisionOf(manager);
        if (!decision.actor || decision.actor === HERO) return;
        const pick = pickBotOption(decision.availableActions, rngRef.current);
        if (!pick) return;
        const intent = buildIntent(decision.actor, pick.option, manager.session, 'automation', pick.sizeTo);
        const result = await manager.applyIntent(intent);
        if (result.validation.kind !== 'accepted') {
          setFatal(`A bot intent was rejected (${result.validation.reason}). That is a bug worth reporting.`);
          return;
        }
        commit(serializeManager(manager));
      })();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [current, killed, commit]);

  const heroAct = useCallback(
    async (option: PlayerOption, sizeTo?: number) => {
      if (!current) return;
      const manager = resumeFromState(current.state);
      const decision = decisionOf(manager);
      if (decision.actor !== HERO) return;
      const intent = buildIntent(HERO, option, manager.session, 'ui', sizeTo);
      const result = await manager.applyIntent(intent);
      if (result.validation.kind !== 'accepted') {
        const attempted =
          option.type === 'raise' || option.type === 'bet'
            ? `${option.type} to ${sizeTo}`
            : formatOptionLabel(option);
        setRejection({ attempted, reason: result.validation.reason });
        return;
      }
      setRejection(null);
      commit(serializeManager(manager));
    },
    [current, commit],
  );

  const killSession = useCallback(() => {
    if (!current) return;
    const { activeSnapshot, ...log } = current.state;
    setKilled({
      logJson: JSON.stringify(log, null, 2),
      lastSeen: activeSnapshot,
      eventCount: current.state.events.length,
    });
    setCurrent(null);
    setParity(null);
    setRejection(null);
  }, [current]);

  const rebuildFromLog = useCallback(() => {
    if (!killed) return;
    const log = JSON.parse(killed.logJson) as PersistedLog;
    const manager = resumeFromState(log);
    const diff = diffValues(manager.session.activeSnapshot, killed.lastSeen);
    setParity({ source: 'rebuild', diff, eventCount: killed.eventCount });
    commit(serializeManager(manager));
    setKilled(null);
  }, [killed, commit]);

  const nextHand = useCallback(() => {
    if (!current) return;
    const stacks: Record<string, number> = {};
    for (const seat of current.state.activeSnapshot.seating.seats) {
      if (seat.occupant) stacks[seat.occupant.playerId] = seat.stack;
    }
    const alive = Object.values(stacks).filter((stack) => stack > 0).length;
    if ((stacks[HERO] ?? 0) <= 0 || alive < 2) {
      void startHand(DEFAULT_STACKS, 0);
      return;
    }
    void startHand(stacks, handNumberRef.current + 1);
  }, [current, startHand]);

  const newTable = useCallback(() => {
    setFatal(null);
    setParity(null);
    void startHand(DEFAULT_STACKS, 0);
  }, [startHand]);

  if (fatal) {
    return (
      <section>
        <pre className="error">{fatal}</pre>
        <button onClick={newTable}>Start a new table</button>
      </section>
    );
  }

  if (killed) {
    return (
      <section>
        <p className="tagline">
          The session object is gone. What you see below is everything that
          survived: the session config, the initial snapshot envelope, and{' '}
          {killed.eventCount} event envelopes. SessionManager.resume can turn
          this back into a live table.
        </p>
        <div className="controls">
          <button className="primary" onClick={rebuildFromLog}>
            Rebuild from the log
          </button>
        </div>
        <pre className="json-view">{killed.logJson}</pre>
      </section>
    );
  }

  if (!current) {
    return <p className="muted">Dealing…</p>;
  }

  const snapshot = current.state.activeSnapshot;
  const settled = snapshot.hand.stage === 'settled';
  const heroToAct = current.actor === HERO;
  const legal = current.options.filter((option) => !option.disabled);
  const sizing = legal.find(
    (option): option is Extract<PlayerOption, { type: 'bet' | 'raise' }> =>
      option.type === 'raise' || option.type === 'bet',
  );

  return (
    <section className="play">
      <p className="tagline">
        You play Hero against three bots. Every action on this table, yours
        included, is submitted to SessionManager.applyIntent and validated by
        the engine before it lands in the log. The buttons below are the legal
        options the engine derived for you; the raise field takes any number
        you like, because the engine is the one that says no.
      </p>

      {parity && (
        <div className={`banner ${parity.diff.mismatches.length === 0 ? 'banner-good' : 'banner-bad'}`}>
          {parity.source === 'reload'
            ? `Restored from localStorage: SessionManager.resume replayed ${parity.eventCount} events, `
            : `Rebuilt from the log alone: SessionManager.resume replayed ${parity.eventCount} events, `}
          {parity.diff.leaves} snapshot fields compared, {parity.diff.mismatches.length} differ.
          {parity.diff.mismatches.slice(0, 5).map((line) => (
            <div key={line} className="small">
              {line}
            </div>
          ))}
        </div>
      )}

      <Board snapshot={snapshot} />

      <div className="live-cols">
        <SeatsView snapshot={snapshot} names={PLAY_NAMES} heroId={HERO} />
        <PotsView snapshot={snapshot} names={PLAY_NAMES} />
        <section className="log">
          <h2>Event log</h2>
          <p className="muted small">
            Rendered from the engine's event envelopes by its own format
            helpers. This log is the whole story of the hand.
          </p>
          <TimelineView events={current.state.events} names={PLAY_NAMES} />
        </section>
      </div>

      {rejection && (
        <div className="banner banner-bad">
          You tried to {rejection.attempted}. The engine rejected it:{' '}
          <strong>{rejection.reason}</strong>. The log did not move.
        </div>
      )}

      {!settled && heroToAct && (
        <footer className="controls action-bar">
          <span className="frame-label">Your move. (hand {handNumber + 1})</span>
          {legal
            .filter((option) => option.type === 'fold' || option.type === 'check' || option.type === 'call' || option.type === 'all-in')
            .map((option) => (
              <button key={option.type} onClick={() => void heroAct(option)}>
                {formatOptionLabel(option)}
              </button>
            ))}
          {sizing && (
            <span className="raise-group">
              <input
                type="number"
                value={raiseTo}
                onChange={(event) => setRaiseTo(event.target.value)}
                aria-label={sizing.type === 'bet' ? 'bet amount' : 'raise target'}
              />
              <button onClick={() => void heroAct(sizing, Number(raiseTo))}>
                {sizing.type === 'bet' ? 'Bet' : 'Raise to'} {raiseTo || '?'}
              </button>
              <span className="muted small">
                engine window: {describeOptionWindow(sizing)}
              </span>
            </span>
          )}
        </footer>
      )}

      {!settled && !heroToAct && (
        <footer className="controls">
          <span className="muted">
            {current.actor ? `${PLAY_NAMES[current.actor] ?? current.actor} is thinking…` : 'Running the board…'}
          </span>
        </footer>
      )}

      {settled && (
        <footer className="controls">
          <span className="frame-label">Hand {handNumber + 1} over.</span>
          <button className="primary" onClick={nextHand}>
            Next hand
          </button>
        </footer>
      )}

      <div className="side-actions">
        <div className="kill-card">
          <h2>Kill the session</h2>
          <p className="muted small">
            Throws away the in-memory session object mid-hand. Only the event
            log survives, and the table comes back from it. You can also just
            refresh the page: the log sits in localStorage and goes through the
            same SessionManager.resume on load.
          </p>
          <button onClick={killSession} disabled={current.state.events.length === 0}>
            Kill session
          </button>
        </div>
        <div className="kill-card">
          <h2>Legal options, verbatim</h2>
          <p className="muted small">
            What selectDecisionContext returns for the player to act right now.
          </p>
          <div className="option-chips">
            {current.actor ? (
              current.options.map((option, index) => (
                <span key={index} className={`chip ${option.disabled ? 'chip-off' : ''}`}>
                  {describeOptionWindow(option)}
                </span>
              ))
            ) : (
              <span className="muted small">nobody to act</span>
            )}
          </div>
        </div>
        <div className="kill-card">
          <h2>Take it further</h2>
          <p className="muted small">
            Send this hand's log to the replay tab to scrub through it or fork
            it at any decision.
          </p>
          <button
            onClick={() => onOpenInReplay(current.state, PLAY_NAMES)}
            disabled={current.state.events.length === 0}
          >
            Open in replay tab
          </button>
        </div>
      </div>
    </section>
  );
}
