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
- `src/sharedTsHost.ts` — shared DocumentRegistry / lib-parse cache (new, T-3c-2)
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

### Task: T-3c-2 - Shared Program/host abstraction (one lib-file parse)

**What was implemented:**
- Added `src/sharedTsHost.ts`: one process-global `ts.DocumentRegistry` plus a
  lib-text snapshot cache. The registry is TypeScript's own primitive for
  sharing parsed+bound `SourceFile`s across compilations — it is the unifying
  abstraction that lets a `CompilerHost` (Layer 0) and a `LanguageService`
  (Layer 1) consume a single lib-file parse.
  - `acquireSharedLibSourceFile(fileName, options)` — Layer 0 calls this from
    its `CompilerHost.getSourceFile` for lib `.d.ts` files; it `acquireDocument`s
    from the shared registry with a constant version (`"1"`, libs are immutable).
  - `getSharedDocumentRegistry()` — Layer 1 hands this to
    `createLanguageService` instead of a fresh `ts.createDocumentRegistry()`.
    Same registry + same settings-derived bucket key + same constant lib version
    ⇒ the lib SourceFile Layer 0 already parsed is reused, not re-parsed.
  - `sharedScriptVersion()` — because the shared registry now *persists* across
    passes, Layer 1's **non-lib** files are versioned by content (FNV-1a hash +
    in-pass edit counter). This guarantees the registry can never hand back a
    stale parse of a user file whose content changed between passes, while
    identical content is still reused. Lib files keep the constant version.
- `validatorInProcess.ts`: merged the shared-lib routing into the existing
  (opt-in) perf wrapper around `host.getSourceFile`. Shared routing is always on
  (perf timing still opt-in); `layer0.libLoadMs` now measures the shared call.
- `tsLanguageServiceFixer.ts`: shared registry + content-addressed
  `getScriptVersion`.
- Opt-out: `TSFIX_SHARED_HOST=false` restores the exact pre-refactor behavior
  (independent parses, fresh per-call registry, ordinal versions). The
  regression test runs both ways and asserts equality.

**Files changed:**
- `src/sharedTsHost.ts` (new), `src/sharedTsHost.test.ts` (new)
- `src/validatorInProcess.ts`, `src/tsLanguageServiceFixer.ts`

**Why a shared DocumentRegistry (not a unified Program):** §12 D2 framed this as
"pick one of the two host abstractions." In practice neither host had to be
discarded — `createProgram` and `createLanguageService` already share parses
*via the DocumentRegistry* when given the same registry, key, and version. So
Layer 0 keeps its CompilerHost, Layer 1 keeps its LanguageServiceHost, and they
overlap only on the immutable lib slice. This is the minimal, byte-identical
change and keeps the workspace lib-path bet intact (SIGN-102 — no bundling).

**Scope decision:** only lib `.d.ts` files are shared, not the `node_modules`
dependency `.d.ts` graph. Lib files are the named target ("lib-file double-load")
and are unconditionally immutable, so sharing them is safe with a constant
version. Sharing the dep graph too would be a larger win but needs the same
content-addressing treatment and more divergence risk; left as a follow-up.

**Measured latency** (`npx tsx benchmark/run-benchmark.ts --perf`, same WSL2 box;
treat as *relative*, run-to-run noise is high for createProgram/diag spans):

| Span | T-3c-1 baseline | T-3c-2 | Δ |
|---|---|---|---|
| **Layer 0 cold lib-load** (`host.getSourceFile`, the shared slice) | **393.7 ms** | **38.3 ms** | **−90%** |

The Layer-0 lib-load span is the clean, low-noise signal directly attributable
to the change: lib files now parse once (first fixture pays it) and every
later consumer — Layer 1, the Layer-0 re-validation after a fix, and subsequent
fixtures with matching settings — hits the shared registry (~0 ms). The
`layer1.firstDiagnosticsMs` span is dominated by the dependency `.d.ts` graph
parse + full typecheck (intentionally *not* shared) and swings with machine
load, so it is not a reliable signal for this change.

**Learnings:**
- A persistent shared registry is only safe if non-lib (mutable) files are
  content-versioned. The first instinct — share the registry but keep ordinal
  versions — would let a second pass on the same path read a stale parse. The
  FNV-1a content version closes that hole and is what makes the optimization
  correct as a published-library default, not just a benchmark trick.
- Lib and non-lib versions must agree across layers for sharing to fire: both
  Layer 0 (`acquireDocument` version `"1"`) and Layer 1
  (`getScriptVersion` → `"1"` for libs) must emit the identical version, or the
  registry treats them as different documents and re-parses.
- The shared registry must **not** be cleared by `resetInProcessTscCache()`:
  `runValidationLoop` resets the Program cache before *both* Layer-0 runs, so
  clearing the lib parse there would defeat the whole optimization. Reset lives
  in a separate `resetSharedTsHost()` used only by tests / the opt-out path.

**Verification:** `npm run check-types` clean · `npm run test` 151/151 passed
(14 files; +4 new shared-host tests; same 3 benign WSL2 RPC-timeout "errors") ·
`npm run benchmark` 14/14, default output byte-identical.

---

### Task: T-3c-3 - Document shared-Program decision (docs-only)

**What was implemented:** (no code — docs only; depended on T-3c-2 landing)
- `ARCHITECTURE.md §9` (perf model): rewrote the "loading lib files twice"
  paragraph. Now states Phase 3c closed the double-load via a shared
  `ts.DocumentRegistry` + lib-text cache (`src/sharedTsHost.ts`) rather than a
  unified `Program`, with the routing for both layers, the −90% (393.7→38.3 ms)
  Layer-0 cold lib-load delta, the content-versioning correctness guard
  (FNV-1a, `TSFIX_SHARED_HOST=false` opt-out + byte-identical regression test),
  and the lib-only scope (dep `.d.ts` graph deferred).
- `ARCHITECTURE.md §12 D2` (open question #2): struck through and marked
  **Resolved (Phase 3c)**. Explains the framing shift — neither host had to be
  discarded; both share the immutable lib slice via the registry.
- `ROADMAP.md Phase 3c`: retitled "shared lib-file parse", marked ✅ 2026-06-10,
  added the T-3c-1/2/3 breakdown and the measured-latency table.
- `ROADMAP.md` summary timeline + deferred-decisions table: 3c row split out as
  ✅ (3b still pending); "share a single Program?" decision marked resolved.

**Files changed:** `ARCHITECTURE.md`, `ROADMAP.md` (+ `plans/prd.json`,
`plans/progress.md`).

**Learnings:**
- The §9 prose and §12 D2 both pre-supposed a "unified Program / pick one host"
  fix. The shipped change contradicted that framing, so the docs needed the
  *reasoning* corrected (shared registry, both hosts kept), not just a status
  flip — otherwise a future reader re-opens the discarded design.
- Kept every figure consistent with T-3c-2's progress entry (393.7→38.3 ms,
  −90%, lib-only scope) so the three docs agree; the low-noise Layer-0 lib-load
  span is the only number quoted as the headline (the L1 firstDiagnostics span
  is machine-load-dominated and not attributable to the change).

**Verification:** `npm run check-types` clean · `npm run test` 151/151 passed
(14 files; same 2 benign WSL2 RPC-timeout "errors") · `npm run benchmark` 14/14,
output byte-identical (docs-only change touches no runtime path).

---

### Task: T-3b-1 - fixtures/REAL.md (real-failure fixture format spec)

**What was implemented:** (no code — docs only; first Phase 3b task)
- Added `fixtures/REAL.md`: the format spec for `fixtures/real-<timestamp>-<hash>/`
  fixtures. Covers (1) the directory layout, (2) the `expected.json` schema
  (cross-referenced to `interface Expected` in `benchmark/run-benchmark.ts` +
  the provenance/`_hint_*` fields that `scripts/capture-fixture.mjs` emits),
  (3) the `mustPass` lifecycle (`false` on capture → flip to `true` once a fix
  ships), and (4) the **node_modules strategy (a)** chosen by ROADMAP 3b:
  commit broken `.ts(x)` + `package-lock.json` + a `setup.sh` (`npm ci
  --ignore-scripts`) that materialises a gitignored `node_modules` on demand.
  Documents the (b)/(c) alternatives and the disk-vs-CI-time tradeoff, plus the
  capture-script invocation (`--no-shared-deps --commit-locked`).

**Files changed:** `fixtures/REAL.md` (new) (+ `plans/prd.json`, `plans/progress.md`).

**Key facts pinned for downstream 3b tasks (T-3b-2/3):**
- Benchmark fixture discovery: any dir with both `expected.json` + `tsconfig.json`,
  excluding `_`-prefixed names; **`costUsdMax`/`expectedErrorCode` markers route a
  fixture to the paid Layer-2 LLM benchmark** — real fixtures must use neither so
  they stay on the free `npm run benchmark` gate.
- Synthetic fixtures symlink `node_modules → ../_shared/node_modules` (one pinned
  version set for the whole suite); real failures are version-specific so they
  can't use `_shared` — hence strategy (a)'s per-fixture lockfile.
- The report-only path for `mustPass:false` fixtures is T-3b-3 (not yet shipped);
  REAL.md documents the intended lifecycle, flagging that dependency.

**Verification:** `npm run check-types` clean · `npm run test` 151/151 passed
(14 files; same 2 benign WSL2 RPC-timeout "errors") · `npm run benchmark` 14/14,
output unchanged (docs-only change touches no runtime path).

---
