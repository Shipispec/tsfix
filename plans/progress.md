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

### Task: T-3b-2 - Enhance scripts/capture-fixture.mjs to emit real-failure fixture dirs

**What was implemented:**
- Rewrote `scripts/capture-fixture.mjs` from a top-to-bottom script into an
  importable ESM module: pure helpers (`parseArgs`, `listSourceFiles`,
  `stripPackageJson`, `contentHash`, `formatTimestamp`/`formatDate`,
  `fixtureDirName`, `buildExpected`) + a `captureFixture(opts)` core + a
  `main()` guarded by `process.argv[1] === import.meta.url` so importing it in
  tests has no side effects.
- **Directory naming** now matches REAL.md: `real-<YYYYMMDD-HHMMSS>-<hash8>`,
  where the timestamp is UTC capture time and the hash is an 8-char sha256 over
  the sorted captured source (deterministic per broken workspace). The old
  `<name>` positional is gone — workspace path is the only positional.
- **New artifacts** written per fixture: `diagnostics.json` (the broken
  snapshot's `Diagnostic[]`), and `setup.sh` (`npm ci --ignore-scripts …`,
  chmod 0755) for the strategy-(a) path. `--shared-deps` instead symlinks
  `../_shared/node_modules` and skips `setup.sh`.
- **`expected.json` defaults** changed to the REAL.md lifecycle: `mustPass:false`
  and `errorsAfterMax: errorsBefore` (lenient/report-only at capture; tighten to
  0 when flipping `mustPass:true`). Added `_hint_lspFixesApplied` alongside the
  existing `_hint_remainingBy*` hints.
- **Diagnostics source** switched from "build dist + spawn the CLI + parse its
  `--json` report" to "build dist + `import()` `dist/index.js` +
  `runValidationLoop({dryRun:true})`". The dry-run loop returns the broken
  (before-fix) `Diagnostic[]`, `errorsBefore`, and the would-be Layer-0/1 fix
  count in one in-process call — no CLI schema change needed. This is
  `defaultGatherDiagnostics`, injectable via `captureFixture({gatherDiagnostics})`.

**Files changed:**
- `scripts/capture-fixture.mjs` (rewritten)
- `scripts/capture-fixture.test.ts` (new — smoke/unit test, 7 cases)
- `fixtures/REAL.md` (consistency: added `diagnostics.json` to the layout, fixed
  the capture invocation to drop the `<name>` positional)

**Smoke test design (why it's fast + deterministic):** the test imports
`captureFixture` directly and drives it with (1) an injected `gatherDiagnostics`
returning canned diagnostics — so no dist build / TypeScript load — and (2) a
fixed `now` clock + a temp `fixturesRoot`. It builds a sample broken workspace
in `os.tmpdir()` and asserts the dir name pattern, all required artifacts,
`mustPass:false`, the `Diagnostic[]` snapshot, `setup.sh` contents + exec bit,
strategy-(a) (no committed `node_modules`), the `--shared-deps` symlink branch,
and the no-tsconfig rejection. **Crucially the test writes only to temp dirs,
never under `fixtures/`, so benchmark discovery is unaffected.**

**Key facts pinned for T-3b-3:**
- A captured fixture is `mustPass:false` with `errorsAfterMax:errorsBefore`. The
  current `run-benchmark.ts` still treats `errorsBefore`/`lspFixesApplied*`
  mismatches as hard `failureReasons` regardless of `mustPass` — T-3b-3 is what
  makes `mustPass:false` truly report-only (non-blocking). No real-* fixture was
  committed in this task (that seed fixture is T-3b-3's deliverable), so the gate
  is untouched.
- `scripts/**` is **excluded** from `tsconfig.json` (`include` is src/cli/
  benchmark only), so `check-types` does not typecheck the new `.test.ts` — but
  vitest's own discovery (`**/*.test.ts`) still runs it. That's why the test can
  import a `.mjs` without a declaration file and not break `tsc --noEmit`.

**Verification:** `npm run check-types` clean · `npm run test` 158/158 passed
(15 files; +1 file/+7 tests; same 3 benign WSL2 RPC-timeout "errors") ·
`npm run benchmark` 14/14, default output unchanged.

---

### Task: T-3b-3 - Benchmark treats mustPass:false fixtures as report-only

**What was implemented:**
- `benchmark/run-benchmark.ts`: added a `reportOnly` flag (`= !expected.mustPass`)
  to `FixtureResult`. The exit-code gate now runs through a new exported
  `allGatingPassed(results)` that filters to `mustPass:true` fixtures only — so a
  failing `mustPass:false` fixture is *reported* but never fails the run/CI.
- Report layout: gating (`mustPass:true`) fixtures keep the `✓/✗` list; a
  dedicated **"Report-only (mustPass:false — tracked, non-gating)"** section lists
  the rest (`○` met its lenient contract, `·` still open) with their reasons.
- Aggregate now prints three numbers so the historical headline is preserved
  while the gate is explicit: `gate: N/M mustPass:true passed` (the only number
  that drives the exit code), `report-only: K/L met contract`, and
  `fixtures: X/Y met contract` (overall).
- Made the harness importable: exported `runFixture` / `listFixtures` /
  `FixtureResult` / `allGatingPassed` and guarded the CLI `main()` behind an
  `invokedDirectly` check (`process.argv[1]` ends with `run-benchmark.{ts,js}`),
  so a vitest test can import it without triggering `process.exit`.
- Added seed fixture `fixtures/real-20260610-000000-9157284c/`: a hand-authored
  `real-*` whose `formatTotal(): number` returns a string (TS2322, no safe
  quick-fix → Layer 0/1 abstain → stays red). `expected.json` is `mustPass:false`
  with `errorsAfterMax:0`, so it is genuinely *red* yet non-gating — exercising
  the report-only path end-to-end. Stdlib-only (no deps), so it runs
  deterministically in the free gate with no `setup.sh`. Ships `tsconfig.json`,
  `diagnostics.json`, and a `README.md` per `fixtures/REAL.md`.
- Added `benchmark/run-benchmark.test.ts` (5 tests): `allGatingPassed` ignores
  report-only failures, still fails on a gating failure, passes when all are
  report-only; plus a live `runFixture` on the seed asserting `reportOnly`,
  `mustPass:false`, `errorsAfter>0`, and that it doesn't fail the gate.

**Files changed:** `benchmark/run-benchmark.ts`, `benchmark/run-benchmark.test.ts`
(new), `fixtures/real-20260610-000000-9157284c/*` (new), `fixtures/REAL.md`
(struck the "not yet shipped" note).

**Key correction / learning — the "14/14" was 7 gate + 7 lenient-false:**
The pre-T-3b-3 "14/14 passed" headline conflated two categories. Of the 14
discovered fixtures, only **7 are `mustPass:true`** (clean-baseline,
import-rename, missing-import, multifile-ripple, no-exported-member,
property-typo, typo-ts2552 — all driven to 0 errors). The other **7 are already
`mustPass:false`** (the 4 `api-drift-*` plus `cross-file-typo-ts2305`,
`implicit-any-ts7006`, `missing-prop-ts2741`) with lenient `errorsAfterMax ==
errorsBefore`, i.e. known-open patterns Layer 0/1 can't fix. The old logic
counted them as "passed" because they met that lenient bound. T-3b-3 reclassifies
them into the report-only bucket where they belong. New headline:
`gate 7/7 · report-only 7/8 · fixtures 14/15 met contract`, **exit 0**. No
fixture that previously passed now fails the gate — the "14" is preserved as the
overall contract-met numerator.

**Verification:** `npm run check-types` clean · `npm run benchmark` exit **0**
(gate 7/7; the seed is the lone open report-only failure, non-blocking) ·
`benchmark/run-benchmark.test.ts` 5/5 in isolation · full `npm run test` 161/163
with 2 spurious "failures" (`run-stack` TS2552 + `runFullStack` Layer-4 stub)
that **pass standalone** — the recurring WSL2 vitest `onTaskUpdate` RPC timeout
marks in-flight tests failed under full parallel load (documented benign pattern,
confirmed by running both files alone: 28/28 pass).

---

## 2026-06-11 - Session Notes (Phase 4 — Layer 3 multi-file mend)

### Task: T-4-1 - Deterministic blast-radius computation via findReferences

**What was implemented:**
- Added `src/blastRadius.ts`: `computeBlastRadius({ workspaceRoot, diagnostics })`
  → `{ symbols: SymbolBlastRadius[] }`, where each entry is
  `{ symbol, declarationFile, references: {file,line,col}[] }`. For every
  surviving diagnostic it (1) resolves the user-land symbol behind the error
  via the TypeChecker, then (2) calls `LanguageService.findReferences()` at that
  symbol's **declaration name** to gather every reference site spanning the
  workspace. Pure + deterministic: no LLM, no disk writes, single pass.
- **Symbol resolution reuses `typeContext.ts`'s walk** (not imported — a focused
  copy `resolveSymbolDeclaration`): bounded 4-hop ancestor walk, `getTypeAtLocation`
  → `getSymbol()/aliasSymbol` → first non-lib declaration, with the TS2339 escape
  (probe `.expression` on property/element access) and every checker call guarded
  against TS-internal throws (rename cascades). Anchors `findReferences` on the
  declaration's `.name` identifier, since references resolve against the name span.
- **LanguageService host** mirrors `tsLanguageServiceFixer.ts`'s read-only parts:
  same lib-path workaround (workspace `node_modules/typescript/lib`, no bundling —
  SIGN-102), shared `DocumentRegistry` via `getSharedDocumentRegistry()` with
  content-versioned non-lib files (`sharedScriptVersion`). **Seeds EVERY project
  file** (`parsed.fileNames`), not just the error files, so `findReferences` can
  search the whole workspace.
- **Determinism guarantees:** symbols deduped by declaration site (two errors on
  the same type → one entry); references deduped by `(file,line,col)` and sorted;
  symbols sorted by `(declarationFile, symbol)`. Paths are workspace-relative,
  line/col 1-indexed.

**Files changed:** `src/blastRadius.ts` (new), `src/blastRadius.test.ts` (new).

**Test design (3 cases, driven through `runInProcessTsc` for honest line/cols):**
1. Multi-file symbol: `User` declared in `user.ts`, imported by `a/b/c.ts`; the
   broken `c.ts` omits a required prop (TS2741). Asserts the single error's blast
   radius spans all four files (`user.ts` decl + 3 importers), symbol `User`,
   sorted refs, 1-indexed positions.
2. Dedup: two TS2741s in `c.ts`/`d.ts` both resolve to `User` → exactly one entry.
3. Zero-references: a primitive `number = 'hello'` (TS2322) — every type is a lib
   type, so no user-land symbol → `symbols: []`.

**Learnings:**
- The error position rarely lands *on* the symbol identifier (TS2741 points at the
  object literal, not the type). Resolving via the **declaration name** + the
  4-hop type walk — rather than `findReferences` at the raw error position — is
  what makes the blast radius hit the actual symbol. Anchoring on the declaration
  also gives the same, complete reference set regardless of which usage erred.
- A persistent shared registry is reused safely here because non-lib files are
  content-versioned (SIGN from T-3c-2 carried over); tests `resetSharedTsHost()`
  in before/after so the symlinked-typescript temp workspaces don't cross-talk.

**Next (T-4-2 — the PROVE gate, SIGN-106):** must demonstrate per-file iteration
CANNOT converge on a forcing fixture before T-4-3/T-4-4 build Layer 3; else defer.

**Verification:** `npm run check-types` clean · `npm run test` 166/166 passed
(17 files; +3 new blast-radius tests; same 3 benign WSL2 `onTaskUpdate` RPC-timeout
"errors") · `npm run benchmark` exit 0, gate 7/7, output unchanged (new module is
not yet wired into any runtime path).

---

### Task: T-4-2 - Forcing-function fixture + non-convergence proof (the PROVE gate)

**Outcome: Layer 3 is JUSTIFIED.** Per-file iteration provably cannot converge on
the forcing fixture, so T-4-3/T-4-4 proceed (NOT skipped per SIGN-106).

**What was implemented:**
- `fixtures/forcing-multifile-ripple/` (report-only, `mustPass:false`): a single
  contested type drives a period-2 oscillation.
  - `lib/shared.ts` — `export type Value = string; export declare const value: Value;`
    (`declare const` = no initializer, so flipping `Value`'s type never makes THIS
    file error; the contradiction lives purely in the two consumers).
  - `lib/consumer-num.ts` — `value * 2` → **TS2362** unless `Value = number`.
  - `lib/consumer-str.ts` — `value.toUpperCase()` → **TS2339** unless `Value = string`.
  - `expected.json`: `errorsBefore:1`, `errorsAfterMax:1`, `lspFixesApplied{Min,Max}:0`,
    `mustPass:false`. NO `costUsdMax`/`expectedErrorCode` markers → stays on the
    free deterministic gate (Layers 0/1 have no safe quick-fix → abstain → 1 error
    survives → "○ met contract", non-gating).
  - `README.md` documents the contradiction + the 2-cycle.
- `src/multiFileMend.test.ts` (2 tests): copies the fixture to a temp workspace
  (symlinked workspace typescript, SIGN-102), then drives a **greedy mock
  single-file fixer** (retype `shared.ts` toward whichever consumer errors —
  TS2362→number, TS2339→string) with **whole-workspace re-validation** through
  `runInProcessTsc`. Asserts over 6 iterations: error count never hits 0; exactly
  two alternating signature states; and that this maps onto runMendLoop's stop
  conditions (`fixed`/`noProgress`/`regressed` can never fire → `maxIterations`).

**Why whole-workspace re-validation (the honest subtlety):** `runInProcessTsc`'s
`generatedFiles` *filters* reported diagnostics; the program is always fully
checked. `runMendLoop` computes `filesInScope` ONCE from the initial diagnostics
(here just `consumer-num.ts`), so its scoped re-validation would go BLIND to the
error migrating to `consumer-str.ts` and falsely report `fixed` while the project
is still broken. That blind spot is a *second* independent reason per-file
iteration fails — but to prove genuine non-convergence (not just a false
positive) the test re-validates all files, the semantics tsc reports for the
project. The oscillation is real at the program level.

**Learnings:**
- A forcing function needs a *shared* declaration with mutually-exclusive
  constraints. Single-file typos/renames (synthetic-multifile-ripple) always
  converge because each fix is independent and surfaces the next error
  monotonically. Oscillation requires that the locally-obvious fix for file A
  necessarily re-breaks file B via a symbol they both own.
- `declare const` is the trick that keeps the shared file itself error-free while
  its type is flipped, so the diagnostic set is a clean period-2 cycle with
  exactly one error at a time (no noise from initializer mismatches).
- Verified the real codes/oscillation with a throwaway `tsx` script before
  writing the test: `Value=string`→`{consumer-num:TS2362}`,
  `Value=number`→`{consumer-str:TS2339}`, back to string → TS2362.

**Files changed:** `fixtures/forcing-multifile-ripple/{lib/shared.ts,lib/consumer-num.ts,lib/consumer-str.ts,tsconfig.json,expected.json,README.md}`
(new), `src/multiFileMend.test.ts` (new).

**Verification:** `npm run check-types` clean · `npm run test` 168/168 passed
(18 files; +2 new forcing-proof tests; same 3 benign WSL2 `onTaskUpdate`
RPC-timeout "errors") · `npm run benchmark` exit 0, gate 7/7 (no regression),
forcing-multifile-ripple reported `○ met contract` (1→1, report-only).

---
