# TSC Defense Stack — CLAUDE.md

> Standalone subproject. Goal: **make TypeScript not the failure mode** before we ship the larger SpecToShip pipeline.

## Why this folder exists

Across test runs (test20R → test28R) the pipeline failure mode has been almost entirely TSC-related:

- 80%+ of code-gen tasks that fail, fail on `tsc --noEmit` errors
- The remaining 20% (lint, vitest, build) usually cascade from a TSC error upstream
- When TSC is happy, code-gen converges to a working app cleanly

Spec quality, prompt design, model routing, cost optimization — none of those matter if the generated code doesn't compile. **TSC reliability is the bottleneck.** Carving it out lets us iterate on it standalone: faster feedback, no need to run the entire spec pipeline to test a fixer change.

The bet: **if this standalone solver hits ≥95% pass rate on a benchmark of real LLM-generated TS codebases, the larger SpecToShip pipeline becomes a thin wrapper around it.** Without that pass rate, no amount of upstream polish ships a working v1.0.

## What's here

This is the source of truth for Layers 0–1. The shims in `spectoship2/src/pipeline/{validatorInProcess,tsLanguageServiceFixer}.ts` re-export from here.

```
src/             — Layer 0–1 implementation (validatorInProcess, tsLanguageServiceFixer, index)
cli/             — standalone CLI (run-stack.ts)
benchmark/       — fixture harness (run-benchmark.ts)
fixtures/        — 14 hand-authored synthetic workspaces
design-docs/     — installed-exports.md (design for the installedExports.ts module
                   that lives in spectoship2/src/pipeline/ — kept here for historical
                   reasons; will likely move to spectoship2/docs/ in cleanup)
```

Layers 2–4 (`mendAgent`, `mendArchitect`, `multiFileMend`, `repairAgent`), prevention layer (`packageGotchas`, `installedExports`, `priorExports`, `codeGenPrompts`), and routing (`blockerClassifier`, `errorPatterns`) all live in `spectoship2/src/pipeline/`. They will move to a sister package `@shipispec/tsmend` per the roadmap.

Read order: `README.md` → `STATUS.md` → `ARCHITECTURE.md` → `tsc-defense-roadmap.md`.

## The architecture, summarized

A TSC error has four chances to die before reaching the user:

1. **Prevention** — prompt rules, package gotchas, installed exports, prior task signatures injected into the code-gen prompt. Most errors never get generated.
2. **Detection** — in-process tsc + structured diagnostics. Faster, no spawn overhead, no Node 23 startup-pause bug.
3. **Auto-repair** — Layer 0 LSP fixer (`ts.LanguageService.getCodeFixesAtPosition`). TS2304/2305/2552/2724 fix without an LLM call. Free, deterministic.
4. **LLM repair** — Layers 1-4 of mendAgent. Architect+editor split, blast-radius search/replace, stub-and-continue.

If all four fail, the user sees a "task blocked" prompt with Retry / Hint / Skip.

## What "done" looks like

A standalone benchmark that:

1. Takes a directory of LLM-generated `.ts(x)` files (the "input").
2. Runs the full defense stack on it (validate → Layer 0 fix → re-validate → mend → re-validate).
3. Returns: `{ passed: bool, errorsBefore: N, errorsAfter: 0, layerHitRate: { lsp, mend1, mend2, mend3 } }`.

Acceptance: against a fixture set of ≥10 real failed workspaces (the `tests/test{20-28}R` snapshots), ≥9 of them converge to `errorsAfter: 0` with no human intervention.

Once we hit that bar, we can confidently say "TSC is solved" and integrate this solver as the validation step of SpecToShip's per-task pipeline (which is already where it lives).

## Iteration loop

1. **Pick** a real failed workspace from `spectoship2/tests/test{N}R/` (these have working node_modules + broken generated code).
2. **Run** the stack standalone (need to build the standalone CLI — see "What's missing" below).
3. **Log** per-layer hit rate: how many errors did Layer 0 fix? How many Layer 2? How many escalated to LLM mend? How many remained?
4. **Find** the dominant failure class. Is it always TS2741 (missing property)? Always Zod-version-drift? Always Next.js async-cookie?
5. **Fix at the lowest layer that can prevent recurrence.** Prefer in priority order:
   - Add a `staleApiDetector` regex (free, deterministic)
   - Add a `packageGotcha` entry (free, prompt-only)
   - Add a code in the LSP fixer's `SAFE_FIXABLE_CODES` set (low risk, catches a class of errors)
   - Update the `codeGenPrompts.ts` rule (changes future generations, won't help past ones)
   - Last resort: tune mend layer prompts
6. **Re-run** the benchmark. Confirm hit rate moved.
7. **Commit** the fix. Move on.

## What's missing (your work)

- **Standalone CLI.** A `bin/tsfix` (or just a Node script) that takes `--workspace <path>` and runs the full stack on whatever files exist. Currently the stack only runs inside `validator.ts → runValidation()` in the SpecToShip pipeline.
- **Fixture set.** Snapshots of `tests/test20R/.../FEAT-001/` through `test28R/...` after they failed. Each fixture is a `node_modules` + `tsconfig.json` + the broken `.ts(x)` files. The CLI runs the stack on each.
- **Per-layer telemetry.** Currently logs are scattered across `[ts-lsp-fixer]`, `[in-process-tsc]`, etc. Wrap each layer to emit a structured event: `{ layer, errorCode, fixed: bool, latencyMs, cost }`. Aggregate at end of run.
- **Regression suite.** When a layer fix lands, the benchmark should fail if a previously-passing fixture starts failing (catch the case where loosening one fixer breaks another).

## Working principles

**Don't expand the surface.** This folder is for TSC-error handling only. Don't add:
- Spec generation, planning, decomposition (lives in `spectoship2/`)
- LLM routing, model selection, cost optimization
- UI, webview, phase gates
- ESLint or Vitest fixers (those have their own infra; this is about TSC specifically)

**Prefer deterministic over LLM.** Every error class fixable in Layer 0 is a permanent win. Every LLM mend call is a probabilistic recovery. When designing a fix, the order of preference is:
1. Prevention (prompt rule, gotcha, exported-API injection)
2. Layer 0 LSP fixer (`getCodeFixesAtPosition`)
3. LLM mend (single-file architect+editor)
4. Multi-file mend (blast radius)
5. Stub-and-continue (escape hatch)

Adding a new layer is more expensive than tightening an existing one. Default to tightening.

**Defense in depth, not replacement.** When you add a new prevention rule, don't remove the matching repair rule. The prompt rule won't catch every case (LLM nondeterminism), so the repair has to stay as backup.

**Test against real failures, not synthetic ones.** The fixture set is `tests/test{20-28}R` because those are real failures from real prompts. Adversarial unit tests are cheaper to write but don't expose the failures users actually hit. Add unit tests AFTER the fixture-set proves a fix works.

**Don't break public APIs.** Functions exported from these files are called from `spectoship2/`. Changing signatures requires coordinated edits there. Prefer adding new exports over changing existing ones.

## What NOT to do

- **Don't refactor for elegance.** These files have been through 3 sprints (G, I, J) and 28 test runs. They work. Refactoring without a measurable hit-rate improvement is regression risk.
- **Don't add dependencies.** `typescript` (peer) is the only runtime dep. Anything else means more bundle size, more `node_modules`, more "does it work in the VS Code Extension Host" risk.
- **Don't write a new mend strategy without measuring the existing ones first.** If you don't know which layer is missing the dominant failure class, you're guessing. Run the benchmark, find the gap, then propose a fix.
- **Don't re-implement what TypeScript already does.** Layer 0 uses `ts.LanguageService.getCodeFixesAtPosition` because the compiler already knows how to fix TS2304. Don't write a homegrown auto-import.

## When you're done with a session

Update `STATUS.md` with what changed (new fixtures, fixer behavior shifts, gaps closed/opened). Update `tsc-defense-roadmap.md` if a phase milestone was reached or a deferred decision got resolved. The roadmap + STATUS pair is the institutional memory for this package.

## References

- Source of truth: `src/` (this package)
- Re-export shims: `spectoship2/src/pipeline/{validatorInProcess,tsLanguageServiceFixer}.ts`
- Roadmap: `tsc-defense-roadmap.md`
- Architecture rationale: `ARCHITECTURE.md`
- Status snapshot: `STATUS.md`
- Original sprint plan: `Meta/SPRINT-PLAN.md` § Sprint G ("TS Language Service auto-fix layer")
- Test fixtures (synthetic): `fixtures/`
- Test workspaces (real, currently all clean post-lib-path-fix): `spectoship2/tests/test{20-28}R/`
- VS Code Extension Host runtime constraints: Node 20.x bundled, esbuild bundles all node_modules into `dist/extension.js` except `vscode`. This is why `ts.getDefaultLibFilePath()` resolves to a bogus path and we override it with the workspace's typescript install (`validatorInProcess.ts:165`, `tsLanguageServiceFixer.ts:160`).
