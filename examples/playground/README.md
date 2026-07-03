# poker-engine-ts playground

An interactive demo of `poker-engine-ts`, driven entirely through its public
API and deployed at https://ge-limin.github.io/poker-engine-ts/. Four tabs:

**Play a hand** (default). You against three bots. Every action, yours and
theirs, is a TurnIntent submitted to `SessionManager.applyIntent`; the raise
field accepts any number and shows the engine's rejection verbatim when the
number is illegal. Kill the session mid-hand and the page rebuilds it from
nothing but the event log, diffing the rebuilt snapshot against the last one
field by field. Refreshing the page resumes from localStorage the same way.

**Replay and fork**. A featured four-pot all-in hand, or the hand you just
played. Every timeline position is rebuilt on the spot by
`SessionManager.resume` over a log prefix; pick any decision and play a
different legal action to fork the hand. Also demos the runtime mode guards:
a session in replay mode rejects mutations with a typed error.

**Rules lab**. The tournament short all-in rule, step by step. The legal
options visibly narrow to fold or call, and a forced raise intent comes back
rejected.

**Torture test**. The engine deals and plays hands forever, and the page
re-checks chip conservation after every single step.

## Run

From the repository root:

```bash
pnpm install
pnpm --filter playground dev
```

Then open the URL Vite prints (default http://localhost:5173).

In dev, `poker-engine-ts` resolves straight to `../../src` (see `vite.config.ts`),
so the demo runs the real engine source with no build step. `pnpm --filter
playground build` produces a static bundle under `dist/`; CI deploys it to
GitHub Pages on every push to main.
