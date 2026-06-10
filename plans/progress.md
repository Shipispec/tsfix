# Ralph Progress Log

Started: 2026-06-10
Task track: Phase 3c (shared-Program perf) + Phase 3b (real-failure fixtures)

## Codebase Patterns

- Two TS entry points each cold-load lib files independently:
  - **Layer 0** `src/validatorInProcess.ts` — `ts.createProgram` + `CompilerHost`
    (`getOrCreateProgram`). Caches a `Program` per `workspaceRoot`, but
    `runValidationLoop` calls `resetInProcessTscCache()` before *both* the
    before- and after-fix tsc runs, so each is a cold load.
  - **Layer 1** `src/tsLanguageServiceFixer.ts` — `ts.createLanguageService` +
    `LanguageServiceHost`. Fresh service per call (no cache).
- Both override `getDefaultLibFileName`/`getDefaultLibLocation` to point at the
  **workspace's** `node_modules/typescript/lib` (the lib-path bet, SIGN-102).
- Benchmark (`benchmark/run-benchmark.ts`) snapshots fixture sources, runs the
  full loop, restores sources. Layer-2 fixtures are skipped via `costUsdMax`/
  `expectedErrorCode` markers.

## Key Files

- `src/validatorInProcess.ts` — Layer 0 in-process tsc
- `src/tsLanguageServiceFixer.ts` — Layer 1 LSP auto-fixer
- `src/perfInstrument.ts` — opt-in perf spans (new, T-3c-1)
- `benchmark/run-benchmark.ts` — harness; `--perf` flag prints lib-load breakdown
- `ARCHITECTURE.md` §9 (perf model), §12 D2 (shared-Program open question)

---

## 2026-06-10 - Session Notes

### Task: T-3c-1 - Baseline perf instrumentation for lib-file double-load

**What was implemented:**
- Added `src/perfInstrument.ts`: opt-in (off by default, zero hot-path overhead)
  process-global span accumulator. Enabled via `enablePerf()` or `TSFIX_PERF=1`.
- Instrumented Layer 0 (`validatorInProcess.ts`) cold path: wraps
  `host.getSourceFile` to time read+parse of `lib.*.d.ts` (`layer0.libLoadMs`),
  times `ts.createProgram` (`layer0.createProgramMs`), counts cold loads
  (`layer0.coldCount`).
- Instrumented Layer 1 (`tsLanguageServiceFixer.ts`): times lib read in
  `getScriptSnapshot` (`layer1.libReadMs`), `createLanguageService`
  (`layer1.createServiceMs`), and the first `getSemanticDiagnostics` pass which
  forces the cold lib parse (`layer1.firstDiagnosticsMs`).
- Added `--perf` flag to `benchmark/run-benchmark.ts`: resets/snapshots spans
  per fixture and prints a timing table + averages. Default output unchanged.

**Files changed:**
- `src/perfInstrument.ts` (new)
- `src/validatorInProcess.ts`
- `src/tsLanguageServiceFixer.ts`
- `benchmark/run-benchmark.ts`

**Baseline numbers** (`npx tsx benchmark/run-benchmark.ts --perf`, this machine —
WSL2, tsx/unoptimized; treat as *relative* baseline for T-3c-2, not native tsc):

Averages over 14 fixtures:

| Span | Avg per fixture |
|---|---|
| Layer 0 cold lib-load (`host.getSourceFile`, read+parse of `lib.*.d.ts`) | **393.7 ms** |
| Layer 0 `createProgram` total | 2718.8 ms |
| Layer 0 cold `createProgram` invocations / fixture | 1.43 (2× on fixtures that get fixed: before + after) |
| Layer 1 cold lib read (`getScriptSnapshot`) | 189.8 ms |
| Layer 1 first diagnostics pass (cold lib parse + full check) | **5029.5 ms** |
| **Redundant lib-load per fixture (L0 libLoad + L1 firstDiagnostics)** | **5423.2 ms** |

Per-fixture detail (L0 lib / L0 prog / L0× / L1 read / L1 diag / total ms):

```
api-drift-drizzle-wrong-subpath       399  2257 1  269  6664   9110
api-drift-next16-sync-cookies         263  1772 1  174  5275   7177
api-drift-react19-against-v18         219  1611 1  145  4624   6385
api-drift-zod4-against-v3             288  1677 1  189  4624   6419
clean-baseline                        245  1592 1    0     0   1671
synthetic-cross-file-typo-ts2305      279  4382 1  183  4189   8679
synthetic-implicit-any-ts7006         226  1473 1  182  4238   5810
synthetic-import-rename-ts2724        522  3238 2  171  4465   8145
synthetic-missing-import-ts2304       507  3110 2  228  5656  10241
synthetic-missing-prop-ts2741         258  1687 1  236  8518  10318
synthetic-multifile-ripple            586  3642 2  191  5400   9745
synthetic-no-exported-member-ts2305   588  4303 2  252  6000  11073
synthetic-property-typo-ts2551        530  3526 2  213  5360  12272
synthetic-typo-ts2552                 602  3793 2  224  5400  10333
```

**Learnings:**
- `clean-baseline` (0 errors) shows L1 = 0: Layer 1 only runs when
  `errorsBefore > 0`, so the lib double-load only happens on *failing* fixtures
  — which is the common case in production. Its L0 `createProgram` (1592 ms)
  with only 245 ms in lib `getSourceFile` confirms most cold-program time is
  module resolution / dep `.d.ts` graph parsing, not just the core libs.
- `layer1.firstDiagnosticsMs` is *not* pure lib parse — it's the first full
  semantic check (lib parse + the workspace's dependency `.d.ts` graph +
  type-checking). It's reported as the Layer-1 cold-load proxy because the lib
  parse is the unavoidable redundant slice T-3c-2 can share with Layer 0.
- Fixtures that the LSP fixer touches run `validatorInProcess` **twice** (before
  + after), visible as `L0× = 2` — a second full cold program load. A shared
  `Program` would also cut this re-validation cost, not just the L0↔L1 overlap.
- Instrumentation must stay opt-in: the `isPerfEnabled()` guard keeps the
  default `npm run benchmark` path allocation-free and behavior-identical
  (still 14/14, byte-identical report).

**Verification:** `npm run check-types` clean · `npm run test` 147/147 passed
(13 files; the 3 "errors" are vitest-worker `onTaskUpdate` RPC timeouts under
WSL2, not test failures) · `npm run benchmark` 14/14, default output unchanged.

---
