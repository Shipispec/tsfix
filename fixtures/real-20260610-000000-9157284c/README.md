# real-20260610-000000-9157284c — return-type vs body mismatch (TS2322)

**Seed fixture** (hand-authored, not machine-captured) that exercises the
`mustPass:false` report-only path introduced in **T-3b-3**. It stands in for a
real production capture until a genuine `scripts/capture-fixture.mjs` run lands
one.

## The pattern

`formatTotal(items: Money[]): number` is annotated to return a `number` but its
body returns a formatted **string** (`${(totalCents / 100).toFixed(2)}`). TSC
flags `TS2322: Type 'string' is not assignable to type 'number'.`

There is **no safe quick-fix**: a mechanical fixer cannot know whether the
*signature* (`: number`) or the *body* (the string) expresses the author's
intent — fixing either direction could silently change behaviour. So Layer 0/1
correctly **abstain**, the error survives, and the fixture stays *red*.

## Why it's `mustPass:false`

Per `fixtures/REAL.md`, a captured failure Layer 0/1 cannot yet fix is committed
report-only: the benchmark runs it and reports the outcome, but it does **not**
gate the run/CI. When a fix ships (e.g. a Layer-2 rule that asks for the intended
contract), flip `mustPass` to `true` — `errorsAfterMax` is already `0` — and it
becomes a hard regression gate.

## Dependencies

This seed uses **only TypeScript stdlib types** (no external imports), so it
needs no `node_modules` / `setup.sh` and runs deterministically in the free
`npm run benchmark` gate. A real version-specific capture would instead ship
`package-lock.json` + `setup.sh` (strategy (a) in `fixtures/REAL.md`).
