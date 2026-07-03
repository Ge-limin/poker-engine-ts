// Tab 4: the endurance run. The engine deals and plays hands forever through
// the public API, and after every single step the demo re-adds every chip on
// the table and asserts the total never moved. This is the same invariant the
// property tests hammer, running live in your browser.
import { useEffect, useRef, useState } from 'react';
import { createHarness, nameOf, type Harness, type HarnessView } from './harness';
import { Card } from './table-view';

export function TortureTab() {
  const harnessRef = useRef<Harness | null>(null);
  const [view, setView] = useState<HarnessView | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(450);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    let cancelled = false;
    createHarness(20260701).then((h) => {
      if (cancelled) return;
      harnessRef.current = h;
      setView(h.view());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    let stop = false;
    const loop = async () => {
      while (!stop && !harnessRef.current) {
        await new Promise((r) => setTimeout(r, 40));
      }
      while (!stop && harnessRef.current) {
        await harnessRef.current.step();
        if (stop) break;
        setView(harnessRef.current.view());
        await new Promise((r) => setTimeout(r, speedRef.current));
      }
    };
    void loop();
    return () => {
      stop = true;
    };
  }, [playing]);

  const stepOnce = async () => {
    if (!harnessRef.current) return;
    await harnessRef.current.step();
    setView(harnessRef.current.view());
  };

  const reseed = async () => {
    setPlaying(false);
    const h = await createHarness(Math.floor((Date.now() % 1_000_000) * 997 + 1));
    harnessRef.current = h;
    setView(h.view());
  };

  if (!view) {
    return <p className="muted">Starting the engine…</p>;
  }

  return (
    <section className="live">
      <p className="tagline">
        The engine deals and plays a fresh hand, over and over. After every
        single step the demo re-adds every chip on the table (stacks plus every
        pot) and checks the total never moved. This is the property test,
        running in your browser.
      </p>

      <div className="scoreboard">
        <div className="score">
          <span className="score-num">{view.hands.toLocaleString()}</span>
          <span className="score-label">hands played</span>
        </div>
        <div className="score">
          <span className="score-num">{view.steps.toLocaleString()}</span>
          <span className="score-label">actions applied</span>
        </div>
        <div className="score">
          <span className="score-num">{view.checks.toLocaleString()}</span>
          <span className="score-label">invariant checks</span>
        </div>
        <div className={`score ${view.violations === 0 ? 'score-good' : 'score-bad'}`}>
          <span className="score-num">{view.violations}</span>
          <span className="score-label">chip violations</span>
        </div>
        <div className={`score ${view.conserved ? 'score-good' : 'score-bad'}`}>
          <span className="score-num">
            {view.chipsNow}/{view.handTotal}
          </span>
          <span className="score-label">{view.conserved ? 'chips conserved ✓' : 'MISMATCH'}</span>
        </div>
      </div>

      <div className="board-area">
        <div className="board-label">Board</div>
        <div className="board">
          {view.board.length === 0 ? (
            <span className="muted">preflop, nothing dealt yet</span>
          ) : (
            view.board.map((c, i) => <Card key={`${c}-${i}`} card={c} />)
          )}
        </div>
        <div className="stage-pill">stage: {view.stage}</div>
      </div>

      <div className="live-cols">
        <section className="players live-players">
          {view.seats.map((seat) => (
            <div
              key={seat.id}
              className={`player ${seat.isActor ? 'actor' : ''} ${seat.isAllIn ? 'all-in' : ''} ${
                seat.folded ? 'loser' : ''
              } ${view.settled && seat.won ? 'winner' : ''}`}
            >
              <div className="player-top">
                <span className="player-name">{seat.name}</span>
                {seat.isActor && <span className="tag tag-actor">to act</span>}
              </div>
              <div className="player-stats">
                <span>
                  stack <strong>{seat.stack}</strong>
                </span>
                <span>
                  in pot <strong>{seat.committed}</strong>
                </span>
                {seat.folded && <span className="tag tag-lose">folded</span>}
                {seat.isAllIn && <span className="tag tag-allin">all in</span>}
                {view.settled && seat.won ? <span className="tag tag-win">+{seat.won}</span> : null}
              </div>
            </div>
          ))}
        </section>

        <section className="pots">
          <h2>Pots</h2>
          {view.pots.length === 0 ? (
            <p className="muted small">between hands…</p>
          ) : (
            view.pots.map((pot, i) => (
              <div key={i} className={`pot ${i === 0 ? 'pot-main' : 'pot-side'}`}>
                <div className="pot-head">
                  <span className="pot-label">{pot.label}</span>
                  <span className="pot-amount">{pot.amount}</span>
                </div>
                <div className="pot-eligible">for {pot.eligible.map((id) => nameOf(id)).join(', ')}</div>
              </div>
            ))
          )}
        </section>

        <section className="log">
          <h2>Event log (this hand)</h2>
          <ol className="events">
            {view.events.length === 0 && <li className="muted">dealing…</li>}
            {view.events.slice(-12).map((ev, i) => (
              <li key={i}>
                <span className="ev-actor">{nameOf(ev.actor)}</span>{' '}
                <span className="ev-action">{ev.action}</span>
                {ev.amount > 0 && <span className="ev-amount"> +{ev.amount}</span>}
              </li>
            ))}
          </ol>
        </section>
      </div>

      <footer className="controls">
        <button onClick={() => setPlaying((p) => !p)}>{playing ? '⏸ pause' : '▶ play'}</button>
        <button onClick={stepOnce} disabled={playing}>
          step ▶
        </button>
        <button onClick={reseed}>⟳ new run</button>
        <label className="speed">
          speed
          <input
            type="range"
            min={60}
            max={900}
            step={30}
            value={960 - speed}
            onChange={(e) => setSpeed(960 - Number(e.target.value))}
          />
        </label>
        <span className="frame-label">
          Alice 60, Bob 100, Carol 80, Dave 120: the same 360 chips, every hand
        </span>
      </footer>
    </section>
  );
}
