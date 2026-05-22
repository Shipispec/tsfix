# tsfix — CLAUDE.md

> Standalone OSS package. Two-layer TypeScript error recovery: deterministic Layer 0/1 + opt-in Layer 2 LLM mend.
> **Live on npm at v0.4.0** (`@shipispec/tsfix`). Repo: `github.com/owgreen-dev/tsfix`.

## Why this package exists

LLM-generated TypeScript is the dominant failure mode for spec-to-code pipelines. Empirically, ~80% of code-gen tasks that fail, fail on `tsc --noEmit` errors; the rest cascade from a TSC error upstream. Spec quality, prompt design, model routing — none of it matters if the code doesn't compile.

The bet: **roughly half of TypeScript errors in LLM output are deterministically fixable** via the same engine VS Code Quick Fix uses (`ts.LanguageService.getCodeFixesAtPosition`). The remaining half need an LLM that can see the actual type declarations. By splitting these into two layers and letting callers opt into Layer 2, the trust model stays clean: the headline `tsfix --workspace ...` CLI never makes a network call.

As of v0.4.0 the bet is validated *enough* to be shippable:
- Layer 0 hits 56% auto-fix on the 14-fixture benchmark — every error fixed for free, no LLM cost.
- Layer 2 hits 100% on 35 synthetic + realistic fixtures at $0.001/fixture avg on `claude-haiku-4-5`. Caveat: 30/35 are mutations of 3 seeds; real-world diversity will move that number.

## What's here

```
src/                — Layer 0/1/2 implementation
  validatorInProcess.ts      — in-process tsc, structured diagnostics
  tsLanguageServiceFixer.ts  — Layer 0/1 LSP auto-fixer
  typeContext.ts             — Layer 2 moat: TypeChecker-driven context injection
  mendAgent.ts               — Layer 2 LLM call (Vercel AI SDK + Anthropic)
  applyEditBlock.ts          — SEARCH/REPLACE parser + 3-tier fuzzy applier
  runMendLoop.ts             — bounded retry with no-progress/regression detection
  index.ts                   — public API (re-exports + the MendContext/LayerEvent/Diagnostic types)
cli/                — CLI entry (Layer 0/1 only)
benchmark/          — fixture harness
  run-benchmark.ts           — Layer 0/1, no network
  run-llm-benchmark.ts       — Layer 2, gated on ANTHROPIC_API_KEY
fixtures/           — 14 Layer-0 (`synthetic-*`, `api-drift-*`, `clean-baseline`) +
                      35 Layer-2 (`mend-*`, `realistic-*`, `gen-*`) = 49 total
scripts/            — build.mjs (esbuild bundle), generate-fixtures.mjs (ts-morph
                      AST mutators), run-matrix.mjs (cold-install matrix), capture-fixture.mjs
seeds/              — ts-morph mutator inputs: userCrud.ts, validators.ts, apiRouter.ts
test-matrix/        — 6 project shapes for the cold-install gate
.github/workflows/  — CI: check-types + vitest + benchmark + matrix + Layer-2 benchmark (gated)
```

Read order: `README.md` → `STATUS.md` → `ARCHITECTURE.md` → `ROADMAP.md` → `CHANGELOG.md`.

## The architecture, summarized

A TSC error has up to four chances to die before reaching the user:

1. **Prevention (Layer 0)** — the caller's problem. Prompt rules, exported-API injection, package gotchas. We don't ship Layer 0.
2. **Detection** — `runInProcessTsc` returns structured diagnostics. No spawn overhead. Workspace lib-path override (uses your workspace's `node_modules/typescript`).
3. **Deterministic auto-fix (Layer 1)** — `ts.LanguageService.getCodeFixesAtPosition`. TS2304/2305/2551/2552/2724 fix without an LLM call. Two-layer allowlist: error code (`SAFE_FIXABLE_CODES`) and fix name (`SAFE_FIX_NAMES`).
4. **LLM mend (Layer 2)** — `runMendLoop` → `mendSingleFile` → `getTypeContext` (moat) + Vercel AI SDK + Anthropic. Aider-style SEARCH/REPLACE patches. Bounded retry. Opt-in only.

Layer 4 (stub-and-continue escape hatch via `stubAndContinue` / `runMendLoop({stubOnFailure})`) **shipped in v0.5.0**. Layer 3 (multi-file mend via `findReferences()`) is **planned, not shipped**. See `ROADMAP.md` § Phase 3-4.

## Where Layer 2 is special

Every other LLM-driven repair tool (Aider, Cline, Cursor, OpenHands, bolt.diy) uses generic grep or repo-maps to assemble context for the model. `getTypeContext` uses the actual TypeChecker: when tsc says "Property 'foo' doesn't exist on type 'Bar'", it resolves `Bar` to its declaration via `getTypeAtLocation()` + `getDeclarations()`, then slices ±20 lines around the declaration into the prompt. Special case for `PropertyAccessExpression` so TS2339 resolves to the receiver's type, not the non-existent property's. **That's the moat** — closes the gap between generic 30% repair rates and the 70%+ we hit on TS2339/TS7006/TS2741.

## What "done" looks like

For the package overall: never. This is an evolving baseline. The shippable bar is:

1. **Layer 0**: every new error code or fix name gets a fixture before joining the allowlist. Regression-safe.
2. **Layer 2**: per-fixture pass rate ≥ 70% on Haiku 4.5 (the production floor — bigger models go higher). Cost per fixture ≤ $0.005. Iter-1 success rate ≥ 40%.
3. Both layers green in CI on every PR.

We're past those bars at v0.4.0 with substantial margin. Further work goes to (a) Layer 3 + Layer 4, (b) growing the fixture corpus to 100+ generated fixtures across 10+ error codes (the Day 2/3/4 engine work), and (c) real-failure capture once a production spec pipeline produces a TSC error we haven't seen.

## Iteration loop

The fixture-driven loop. Different from a spec-pipeline iteration loop — this one starts from a known broken workspace, not a spec.

1. **Pick** a failure class. Either:
   - A new TS code that escapes Layer 0 (write a Layer-0 fixture under `fixtures/synthetic-*` to prove it abstains, then decide whether to expand the allowlist or escalate to Layer 2)
   - A Layer-2 case the LLM gets wrong (snapshot it as `fixtures/mend-<descriptive>/`)
   - A real workspace that fails (use `npm run capture` — `scripts/capture-fixture.mjs`)
2. **Bench** locally: `npm run benchmark` for Layer 0, `npm run benchmark:llm` for Layer 2 (needs `ANTHROPIC_API_KEY`).
3. **Diagnose**. For Layer 0: inspect the `fix.fixName` from `getCodeFixesAtPosition`. For Layer 2: read the `rawResponse` in the benchmark output — what did the LLM produce? Did the patch fail to apply (fuzzy-match miss)? Did `getTypeContext` return the wrong type?
4. **Fix at the lowest layer that can prevent recurrence**. Same priority ladder as before:
   - Layer 1 allowlist expansion (free, deterministic)
   - Layer 2 prompt tweak in `mendAgent.ts` (cheap, helps every fixture)
   - Add a new code class to the generator (`scripts/lib/mutators/`) so we can stress-test it
   - Last resort: change the contract types or the loop semantics
5. **Re-bench**. Confirm hit rate moved. If a previously-passing fixture started failing, **revert and try again** — the regression isn't worth the new fix.
6. **Test + commit**. Unit tests use mocked LLM (`_callLLM` injection); they're fast.

## Working principles

**Layer 2 stays opt-in.** The CLI default never calls an LLM. A vibe coder running `npx @shipispec/tsfix .` on a fresh machine has zero network surface and zero API key requirement. Any change that breaks this is a non-starter — it's the load-bearing trust property.

**Don't expand the surface.** This package is for TSC-error handling only. Don't add:
- Spec generation, planning, decomposition (belongs upstream of this package)
- Generic LLM routing, prompt-engineering frameworks (use the Vercel AI SDK directly)
- UI, webview, phase gates
- ESLint or Vitest fixers — those have their own infra

**Prefer deterministic over LLM.** Every error class fixable in Layer 0/1 is a permanent win. Every Layer-2 call is a probabilistic recovery. Default to tightening Layer 1; reach for Layer 2 only when LSP genuinely abstains.

**Defense in depth, not replacement.** Adding a Layer-2 prompt rule for "don't hallucinate Zod v4 methods on v3" is fine; removing the matching prevention prompt rule upstream isn't. Both layers stay.

**Test against real failures when possible.** Synthetic fixtures cover known patterns; real failures expose unknown ones. The `scripts/capture-fixture.mjs` tooling is for that. We don't have a real-failure fixture yet — first production TSC failure that escapes Layer 0+2 should produce one.

**Don't break the public API.** Tarball consumers depend on the exports from `src/index.ts`. Adding new exports is fine; renaming or removing existing ones requires a major-version bump (and we just hit v0.4.0).

## What NOT to do

- **Don't refactor for elegance.** This package has been through Phase 0 stabilization, Phase 1 OSS launch, Phase 2 Layer 2 integration. It works. Refactoring without a measurable hit-rate improvement is regression risk.
- **Don't add dependencies without justification.** v0.4.0 deliberately added `@ai-sdk/anthropic` + `ai` + `ts-morph` because they earned their bundle weight. Anything new needs the same bar.
- **Don't write a new mend strategy without measuring the existing one first.** If you don't know what the dominant Layer-2 failure mode is, you're guessing. Run `npm run benchmark:llm`, find the gap, then propose a fix.
- **Don't re-implement what TypeScript already does.** Layer 0/1 uses `getCodeFixesAtPosition` because the compiler already knows. Don't write a homegrown auto-import or did-you-mean. (Layer 2 is the exception — it can do things the compiler can't.)
- **Don't merge a Layer-2 change without running the live benchmark.** Mocked unit tests can't catch prompt regressions. CI runs the live benchmark when `ANTHROPIC_API_KEY` is configured as a secret; locally, run `npm run benchmark:llm` before opening a PR.

## When you're done with a session

Update `STATUS.md` with what changed (new fixtures, fixer behavior shifts, Layer-2 prompt tweaks, gaps closed/opened). Update `ROADMAP.md` if a phase milestone was reached or a deferred decision got resolved. Update `CHANGELOG.md` if you're cutting a release. The roadmap + STATUS + CHANGELOG triple is the institutional memory.

If you change the public API (`src/index.ts` exports), update `README.md` too — the npm page renders the README, and consumers grep it for the function they want.

## References

- npm: `@shipispec/tsfix` ([view on npm](https://www.npmjs.com/package/@shipispec/tsfix))
- Repo: `github.com/owgreen-dev/tsfix`
- README: front door for OSS consumers
- STATUS.md: current snapshot, gaps, planned work
- ARCHITECTURE.md: design rationale (four-layer model, lib-path workaround, TypeChecker walk-up in `getTypeContext`)
- ROADMAP.md: phased plan, decisions (resolved + deferred)
- CHANGELOG.md: release history (Keep-a-Changelog format)
- docs/internal-orientation.md: original SpecToShip-context README, kept for design history
- design-docs/installed-exports.md: design notes for a related but separate module (spectoship2's `installedExports.ts`), kept here for historical reasons

## Things that are *not* here anymore (don't go looking)

- **`@shipispec/tsmend`** — sister package, never published. Folded into this repo at v0.4.0. tsmend repo archived at `github.com/owgreen-dev/tsmend` with `MOVED.md` pointing here.
- **Monorepo workspaces** — this package was once inside the `spectoship-meta` monorepo at `tsc-defense-stack/`. Extracted 2026-05-06. The `spectoship2/src/pipeline/{validatorInProcess,tsLanguageServiceFixer}.ts` re-export shims may still exist in spectoship2 but are not this repo's concern.
- **Plain `node` execution of the CLI source** — v0.2.0+ ships an esbuild bundle at `dist/cli.js`. The old `cli/run-stack.ts` is dev-only; `npm run run-stack` invokes it via `tsx`.
