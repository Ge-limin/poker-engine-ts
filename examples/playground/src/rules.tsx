// Tab 3: the short all-in rule, step by step. The script picks the actions,
// the engine computes everything else: every step is a validated applyIntent,
// and the option panels are selectDecisionContext output, verbatim. The
// regression test for this rule lives in src/__tests__/short-all-in-reopen.test.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createSeededRandom } from 'poker-engine-ts/testing';
import type { PlayerOption, SessionManager, TurnIntent } from 'poker-engine-ts';
import {
  FIXED_NOW,
  bootstrapHand,
  buildIntent,
  decisionOf,
  describeOptionWindow,
  makeConfig,
  resumeFromState,
} from './engine-helpers';

const NAMES: Record<string, string> = {
  utg: 'UTG',
  button: 'Button',
  shorty: 'Shorty',
  bigblind: 'Big blind',
};

interface ScriptStep {
  readonly title: string;
  readonly want: 'raise-30' | 'call' | 'all-in' | 'fold';
}

const SCRIPT: readonly ScriptStep[] = [
  { title: 'UTG raises to 30. Over the 10 big blind that is a full raise of 20.', want: 'raise-30' },
  { title: 'Button calls 30.', want: 'call' },
  {
    title: 'Shorty moves all in for 45 total. That raises by only 15, short of the 20 a full raise needs.',
    want: 'all-in',
  },
  { title: 'Big blind folds.', want: 'fold' },
];

interface TraceEntry {
  readonly title: string;
  readonly actorName: string;
  readonly options: readonly PlayerOption[];
}

export function RulesTab() {
  const managerRef = useRef<SessionManager | null>(null);
  const bootedRef = useRef(false);
  const [trace, setTrace] = useState<readonly TraceEntry[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const snapshotTrace = useCallback((title: string): TraceEntry | null => {
    const manager = managerRef.current;
    if (!manager) return null;
    const decision = decisionOf(manager);
    if (!decision.actor) return null;
    return {
      title,
      actorName: NAMES[decision.actor] ?? decision.actor,
      options: decision.availableActions,
    };
  }, []);

  const boot = useCallback(async () => {
    const rng = createSeededRandom(11);
    const seats = [
      { playerId: 'button', seatIndex: 0, stack: 1000 },
      { playerId: 'shorty', seatIndex: 1, stack: 45 },
      { playerId: 'bigblind', seatIndex: 2, stack: 1000 },
      { playerId: 'utg', seatIndex: 3, stack: 1000 },
    ];
    const state = await bootstrapHand(makeConfig(5, 10), seats, rng);
    managerRef.current = resumeFromState(state);
    setStepIndex(0);
    setVerdict(null);
    setFatal(null);
    const first = snapshotTrace('Blinds 5 and 10 are posted. Shorty sits in the small blind with 45 chips.');
    setTrace(first ? [first] : []);
  }, [snapshotTrace]);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void boot();
  }, [boot]);

  const applyStep = useCallback(async () => {
    const manager = managerRef.current;
    const step = SCRIPT[stepIndex];
    if (!manager || !step) return;
    const decision = decisionOf(manager);
    if (!decision.actor) return;
    const legal = decision.availableActions.filter((option) => !option.disabled);
    let picked: { option: PlayerOption; sizeTo?: number } | null = null;
    if (step.want === 'raise-30') {
      const option = legal.find((candidate) => candidate.type === 'raise');
      if (option) picked = { option, sizeTo: 30 };
    } else {
      const option = legal.find((candidate) => candidate.type === step.want);
      if (option) picked = { option };
    }
    if (!picked) {
      setFatal(`Script expected ${step.want} to be legal for ${decision.actor}, but the engine disagrees.`);
      return;
    }
    const result = await manager.applyIntent(
      buildIntent(decision.actor, picked.option, manager.session, 'ui', picked.sizeTo),
    );
    if (result.validation.kind !== 'accepted') {
      setFatal(`Script step rejected by the engine: ${result.validation.reason}`);
      return;
    }
    const entry = snapshotTrace(step.title);
    if (entry) setTrace((previous) => [...previous, entry]);
    setStepIndex((index) => index + 1);
  }, [stepIndex, snapshotTrace]);

  const submitIllegalRaise = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager) return;
    const decision = decisionOf(manager);
    if (!decision.actor) return;
    const intent: TurnIntent = {
      id: 'illegal-raise-attempt',
      actor: decision.actor,
      requested: { type: 'raise', amount: 90, to: 90 },
      origin: 'ui',
      issuedAt: FIXED_NOW,
      expectedSnapshotVersion: manager.session.activeSnapshot.index,
    };
    const result = await manager.applyIntent(intent);
    setVerdict(
      result.validation.kind === 'accepted'
        ? 'Accepted. That would be a bug; please report it.'
        : `Rejected, reason: ${result.validation.reason}. The log did not move.`,
    );
  }, []);

  if (fatal) {
    return (
      <section>
        <pre className="error">{fatal}</pre>
        <button onClick={() => void boot()}>Reset the scene</button>
      </section>
    );
  }

  const done = stepIndex >= SCRIPT.length;
  const latest = trace[trace.length - 1];

  return (
    <section>
      <p className="tagline">
        Tournament rules say an all-in that is short of a full raise does not
        reopen the betting: players who already acted may only call or fold.
        Toy engines get this wrong. Step through the classic case and watch the
        legal options shrink. The script only picks which action to take; the
        options and the verdicts all come from the engine.
      </p>

      <ol className="rules-steps">
        {trace.map((entry, index) => (
          <li key={index} className={index === trace.length - 1 ? 'current' : ''}>
            <div>{entry.title}</div>
            <div className="option-line">
              <span className="ev-actor">{entry.actorName} may:</span>
              <span className="option-chips">
                {entry.options.map((option, optionIndex) => (
                  <span key={optionIndex} className={`chip ${option.disabled ? 'chip-off' : ''}`}>
                    {describeOptionWindow(option)}
                  </span>
                ))}
              </span>
            </div>
          </li>
        ))}
      </ol>

      {!done && (
        <footer className="controls">
          <button className="primary" onClick={() => void applyStep()}>
            Next: {SCRIPT[stepIndex]?.title}
          </button>
          <button onClick={() => void boot()}>Reset</button>
        </footer>
      )}

      {done && latest && (
        <div className="kill-card punchline">
          <h2>The betting did not reopen</h2>
          <p className="muted small">
            {latest.actorName} already matched the last full raise, so facing
            Shorty's short all-in the engine offers exactly two options: fold or
            call. There is no raise to click because the engine never derived
            one. Submit a raise intent anyway and see what validation says.
          </p>
          <div className="controls">
            <button className="primary" onClick={() => void submitIllegalRaise()}>
              Submit raise to 90 anyway
            </button>
            <button onClick={() => void boot()}>Reset</button>
          </div>
          {verdict && <div className="banner banner-bad">{verdict}</div>}
        </div>
      )}
    </section>
  );
}
