# `@shipispec/tsfix` — Project Roadmap

> Generated: 2026-05-03. Revised after feedback pass.
> North star: ship a focused, trustable OSS package that vibe coders can drop into any project — not a super-app.

---

## Decisions still open

These are load-bearing — answers determine downstream phase shapes. Stub here until decided.

| # | Question | Why it matters | Current lean |
|---|---|---|---|
| D1 | Is v0.1.0 going to npm publicly under `@shipispec/tsfix`? | Phase 0 is "internal cleanup" vs "pre-publish hardening" — different bar | Yes (drives Phase 1 prep) |
| D2 | If workspace lacks `typescript`, hard error or bundled fallback? | Determines Phase 1a complexity | Hard error + `peerDependencies` declaration (preserves lib-path fix; matches typical OSS bin convention) |
| D3 | Mend agents into THIS package, or sister `@shipispec/tsmend`? | Determines whether `MendContext` is internal API or stable public API | Sister package (keeps this one Layer-0/1 focused; mend has different release cadence) |
| D4 | Support Node 20.x, or require Node 23+? | Determines whether the in-process tsc Node-23-startup-pause workaround is still needed | Node 20.x minimum (matches VS Code Extension Host runtime) |
| D5 | Is the OSS audience CLI users or library users? | Determines README emphasis | Both — CLI as the headline, library API as the secondary section |

---

## Guiding constraints

1. **No scope creep into spectoship2 pipeline concerns.** The package knows nothing about specs, tasks, or models.
2. **Every new error code or fix name requires a fixture.** The trust model is only as good as its pins.
3. **Dependency count stays near zero.** `typescript` (peer) only. No bundlers, no AST libs, no LLM SDKs in this package.
4. **Ship the smallest thing that's useful in isolation.** A vibe coder should be able to `npx @shipispec/tsfix ./my-project` and get real value with zero config.

---

## Phase 0 — Stabilize v0.1 (current sprint)
**Goal:** Call what's built "done" — not by adding features, but by closing gaps that make it untrustworthy as an OSS baseline.

### 0a — Kill stale dead code ✅ (2026-05-03)
- [x] Delete `tsc-defense-stack/{validation,prompts,metadata,mend,routing}/` snapshot folders — byte-identical duplicates of live code, no current purpose
- [x] Delete `refresh-copies.sh` — encodes a copy direction that no longer matches reality
- [x] Rewrite `README.md` to match current state: source-of-truth direction (canonical = `tsc-defense-stack/src/`; `spectoship2/src/pipeline/{validatorInProcess,tsLanguageServiceFixer}.ts` are re-export shims), current fixture count, current architecture
- [x] Rename `design-docs/ts-repair2.md` → `design-docs/installed-exports.md` (it's a doc for a spectoship2 module, not this package)

**Why first:** Dead code is a trap for contributors. Every hour of cleanup now prevents three hours of confusion when this goes public.

---

### 0b — Unit tests for core invariants ✅ (2026-05-03)
26 tests across 3 files covering everything in the original priority list:

| Unit | Test file | Coverage |
|---|---|---|
| `applyFixToSnapshots` | `src/tsLanguageServiceFixer.test.ts` | single-file edit + version bump; reverse-offset-order multi-edit; multi-file change with per-file version bump; missing-snapshot skipped (won't create new files) |
| Signature-set progress check | `src/tsLanguageServiceFixer.test.ts` | extracted as `computeErrorSignatures` + `signatureSetsEqual`; tests cover identical sets, size mismatch, the load-bearing same-size-different-members case (TS2724→TS2552), empty-set vacuous case |
| Multi-fix equivalence (`fixesAreEquivalent`) | `src/tsLanguageServiceFixer.test.ts` | identical fixes pass; different `newText` fails; different positions fail; empty list false; single fix trivially true |
| `discoverTsFiles` | `src/index.test.ts` | includes .ts/.tsx; excludes .d.ts and non-TS files; skips all 7 of `node_modules/.next/dist/build/out/coverage/.git`; walks nested dirs; empty workspace; non-existent path |
| `runInProcessTsc` lib-path override | `src/validatorInProcess.test.ts` | uses workspace's typescript via symlink; globals (Promise, console, Array, JSON) compile clean; genuinely-unknown name still surfaces TS2304 with the documented diagnostic shape |

To enable testing, three pure utilities in `tsLanguageServiceFixer.ts` were marked `@internal` and exported (not added to `index.ts` public surface): `applyFixToSnapshots`, `fixesAreEquivalent`, `computeErrorSignatures`, `signatureSetsEqual`. The previously-inline signature-set logic in `runLSPFixerPass` was extracted into the two new helpers.

Discovered while writing tests: ARCHITECTURE.md's Diagnostic data-model section had a stale claim that the public diagnostic shape includes `start`/`length`. It doesn't — those live on the raw `ts.Diagnostic` consumed inside `collectFixableErrors`. Fixed in ARCHITECTURE.md § 4.

---

### 0c — Local dev hygiene ✅ (2026-05-03)
- [x] `npm install` from inside `tsc-defense-stack/` must work — install local devDeps (`tsx`, `vitest`, `typescript`, `@types/node`). Required taking the package OUT of the monorepo's `workspaces` array (`Meta/package.json`) and pinning spectoship2's dep as `"file:../tsc-defense-stack"`. Without that, npm builds the full monorepo idealTree and stalls on `@ai-sdk/openai`.
- [x] `npm run benchmark` and `npm run test` must run from the package root. `npm run benchmark` (14/14), `npm run test` (2/2 smoke tests), `npm run check-types` (clean), `npm run setup-fixtures` (lazy-installs react/zod/@types/react into `fixtures/_shared/node_modules`).
- [x] Confirm `package.json#bin` resolution via `npm link` — symlink lands in PATH AND executes correctly via the `bin/tsc-defense.mjs` wrapper (Node ESM script that resolves `tsx` via `require.resolve("tsx/cli")`). Verified exit codes propagate (0/1) on clean and unfixable fixtures. The wrapper depends on `tsx` being resolvable from the package's `node_modules`, which works for `npm install` + `npm link`. True `npx @shipispec/tsfix ./project` cold-start still needs the Phase 1a esbuild bundle.

**Notes from execution:**
- Added a `prebenchmark` (NOT `prebench` — npm requires exact script name) hook so the fixture deps install lazily on first run.
- Added a top-level `tsconfig.json` with `exclude: ["fixtures/**"]` so `tsc --noEmit` doesn't compile intentionally-broken fixture files.
- Added `src/index.test.ts` smoke test so `vitest run` exits cleanly with content (vitest hangs on empty fixture set in some configs).

**Done signal:** Verified — copying `tsc-defense-stack/` to `/tmp/` (no sibling packages), `npm install && npm run benchmark` produces 14/14 pass.

---

## Phase 0.5 — v0.1.0 npm release

Between Phase 0 (internal stabilization) and Phase 1 (full OSS launch prep), publish a minimal v0.1.0 to npm so the package name is reserved and the API contract is locked in writing.

- [ ] Confirm npm namespace `@spectoship` ownership / create org if needed (manual step — needs npm account check)
- [x] `package.json#version` set to `0.1.0`
- [x] Added `repository` (with `directory: "tsc-defense-stack"` for monorepo subpath), `license: MIT`, `author: owgreen-dev <ogreenowow@gmail.com>`, `keywords`, `homepage`, `bugs`, `engines.node: >=20.9.0`
- [x] `LICENSE` (MIT, 2026 owgreen-dev) added at package root
- [x] `npm pack --dry-run` confirms a clean 8-file tarball (15.8 KB packed, 48.9 KB unpacked): `LICENSE`, `README.md`, `package.json`, `bin/tsfix.mjs`, `cli/run-stack.ts`, `src/{index,tsLanguageServiceFixer,validatorInProcess}.ts`. Test files (`*.test.ts`) excluded via `!src/**/*.test.ts` negation in the `files` array. `CLAUDE.md` removed from the tarball — internal doc with internal voice; contributors find it on GitHub.
- [x] **Published 2026-05-04** as `@shipispec/tsfix@0.1.0` (verified via `npm view`). Final scope+name differs from the original plan (`@spectoship/tsc-defense`) because (a) `@spec2ship` was taken on npm AND there's an unrelated GitHub project of similar name (a Claude Code orchestration plugin), (b) the npm username on the publishing account is `shipispec`, (c) `tsfix` is more distinctive than `tsc-defense` (which sounded like a tsconfig option) and pairs cleanly with planned sister `@shipispec/tsmend`. Maintainer auth via granular access token with bypass-2FA — passkey-based 2FA can't use the `--otp` flag.
- [ ] Tag the published commit in git: `git tag v0.1.0-tsfix && git push --tags` ← **manual; this is a monorepo so per-package version tags are needed**

**Why a separate phase:** Publishing forces decisions (license, repo URL, what's in the tarball) that are easier to make once than to revisit. Locking v0.1.0 also gives downstream callers (spectoship2) a real version pin instead of a workspace path.

**Pre-publish discoveries (2026-05-04):**
- The tarball was initially shipping `*.test.ts` files (~12.4 KB of dead weight) — fixed by adding `!src/**/*.test.ts` negation to the `files` array.
- The tarball was shipping `CLAUDE.md` — internal working-principles doc with internal voice. Removed from `files`. Contributors who clone the repo will see it; npm install users won't.
- `package.json#main` and `types` still point at `src/index.ts` (TypeScript source). Fine for tsx-based consumers; plain Node consumers will need the Phase 1a esbuild bundle (`dist/index.js`).

---

## Phase 1 — Public OSS Launch Prep
**Goal:** Make the package usable by someone who has never seen spectoship2. The `npx` story must work cold.

### 1a — Standalone bin (esbuild bundle) ✅ (2026-05-04)

Shipped in v0.2.0. Bundle drops the `tsx` runtime dependency entirely; both library `import` and bin `npx` work in plain Node.

- [x] `esbuild` added as devDep (`^0.28`)
- [x] `scripts/build.mjs` produces three artifacts:
  - `dist/index.js` — library bundle (ESM, ~17.7 KB)
  - `dist/cli.js` — CLI bundle (ESM, shebang, exec, ~22.2 KB)
  - `dist/index.d.ts` — public type declarations via `tsc --emitDeclarationOnly`
  - `dist/types/` — per-file declarations for future subpath imports
- [x] `package.json` rewired: `main`/`types`/`exports`/`bin` all point at `dist/`. `files` ships `dist/` only. `prepublishOnly` runs the build automatically.
- [x] Old `bin/tsfix.mjs` Phase 0c wrapper deleted.
- [x] Cold test verified in `/tmp` via tarball install: `node use-as-library.mjs` works without tsx (fixes audit H-E1); `./node_modules/.bin/tsfix --workspace .` works cold (fixes audit M-E2).
- [x] Final tarball: 10 files, 16.8 KB packed. `dist/` is gitignored; published via npm only.

**Externals:** `typescript` stays external (peer dep — must be loaded from the consumer's node_modules so the lib-path workaround keeps working). Node built-ins are auto-external.

**Skipped:** the friendly "no typescript installed" runtime error mentioned in the original D2 plan. Modern npm/yarn/pnpm auto-install peer deps; Node's `ERR_MODULE_NOT_FOUND` already names the missing package; the friendly message would require either resurrecting the wrapper layer or refactoring static imports to dynamic. README troubleshooting section covers it instead.

**Critical constraint:** `typescript` must NOT be bundled. The whole point of the lib-path fix is to use the *workspace's* TypeScript. If we bundle our own, we reintroduce the bug.

**Failure mode to handle:** Workspace has no `node_modules/typescript` (fresh project, hasn't run `npm install`). Per D2: hard error with install hint. Implementation:

1. `package.json#peerDependencies.typescript` declares the requirement so npm/pnpm/yarn surface the dep at install time
2. CLI startup probes for `node_modules/typescript`; if missing, emit:
   ```
   error: this workspace has no TypeScript installed.
   run: npm install --save-dev typescript
   ```
   and exit with code 2 (bad config), not 1 (errors found).
3. Library callers get a thrown `Error("workspace lacks typescript at <path>")` from `runValidationLoop` — no silent fallback.

No bundled fallback. The lib-path bug is the reason the bet works; bundling our own ts re-opens it.

---

### 1b — CI (GitHub Actions)
Two workflows:

**`test.yml`** — runs on every PR:
```
- npm ci
- npm run test         (vitest)
- npm run benchmark    (14-fixture harness)
```
Fail if any fixture regresses. This makes the fixture set the real CI gate.

**`publish.yml`** — runs on tag push `v*`:
```
- npm run build:cli
- npm publish --access public
```

**Why this matters for OSS:** Without CI, contributors have no feedback loop. With it, adding a new fixture = adding a CI test automatically (the benchmark auto-discovers fixtures).

---

### 1c — Public README rewrite
The current README is an internal orientation doc — it presupposes context (the SpecToShip pipeline, empirical 80% number). The OSS audience doesn't have that context. The rewrite is a marketing concern, not a docs concern.

Structure (top to bottom):
1. **Tagline** — one sentence, no jargon. e.g. "Headless TypeScript error recovery: borrow VS Code's Quick Fix engine to auto-resolve TS2304/2305/2551/2552/2724 before they reach a human."
2. **Before/after diff** — concrete example of broken code → fixed code, with the actual command that did it
3. **30-second cold start** — `npx @shipispec/tsfix ./my-project`, what they'll see, what exit code means what
4. **What it fixes / does NOT fix** — 5-codes table from STATUS.md + the explicit non-goals (no LLM, no style fixes, no structural rewrites)
5. **The four-layer model** — simplified diagram showing "this package handles Layer 0–1; Layers 2–4 are your problem (or @shipispec/tsmend's)"
6. **Library API** — for callers wiring this into their own pipeline
7. **Contributing** — the "probe → fixture → allowlist change" protocol from ARCHITECTURE.md §8
8. **Trust model** — "this loads `typescript` from your workspace's `node_modules`. Only run on workspaces you trust." (See M2.)

The current README content moves into `INTERNAL.md` or stays as `docs/internal-orientation.md` — useful for the project but not the front door.

---

### 1d — Coverage gap: fixture expansion
Before public launch, close the highest-risk gaps in the fixture set:

| Fixture | Why it matters | Cost |
|---|---|---|
| TSX file with **TS2322 prop typo** (e.g. `<MyComp clasName="x" />`) — probes whether `fixUnknownProperty` is in `SAFE_FIX_NAMES`-eligible territory | Most vibe coders write React — if TSX breaks, this is useless. TS2322 is the JSX equivalent of TS2551 and may be addable to `SAFE_FIXABLE_CODES`. | small |
| Auto-import ambiguity (2+ candidate packages exporting same symbol) | Confirm we abstain correctly, not pick the wrong one. Note: needs per-fixture stub `node_modules` with two real packages OR two ambient `declare module` `.d.ts` stubs (cheaper, but bypasses real module-resolution). Pick `declare module` for the first version. | medium |
| 10+ errors same class (stress test) | Unknown perf behavior of `getCodeFixesAtPosition` at scale | small |
| Multi-file ripple crossing 3+ files | Current ripple is 2 files / 3 iterations — need deeper cascade | small |
| `@types/X` fallback (symbol in `@types/react` not bundled) | React is the most common case; this needs a pin | small |

---

## Phase 2 — v0.2: Extract LLM Mend Layers (sister package)
**Goal:** Bring Layers 2–4 into a sister package `@shipispec/tsmend` (per D3) so the deterministic stack and the LLM stack ship independently.

Why a sister package, not this one:
- Different release cadence (Layer 0–1 is stable; mend prompts churn)
- Different dep tree (mend pulls in Vercel AI SDK + Zod; we don't want that here)
- `@shipispec/tsfix` stays Layer 0–1 only — the bet's purest form

This phase plans the extraction; v0.2 of THIS package only changes its result type to expose enough info for `@shipispec/tsmend` to consume.

### 2a — Design `MendContext` interface
The blocker for extraction is that `mendAgent` reads `ParsedTask` AND `ParsedFeatureSpec` — both spectoship2-internal types with spec text, prior tasks, and acceptance criteria baked in.

Verified against current code:
- `mendAgent.ts:17` — `import type { ParsedTask, ParsedFeatureSpec }`
- `mendArchitect.ts:30` — same imports
- `multiFileMend.ts:36` — same imports
- `mendAgent.ts:599` — `readExistingTestFiles(workspaceRoot, task)` — agents read existing tests to avoid breaking them

Sketch v2 of the interface — must cover everything the agents actually read today:

```ts
// Defined in @shipispec/tsfix (this package), so both detection
// and mend can speak the same shape. Mend lives in @shipispec/tsmend.
export interface MendContext {
  // Workspace fundamentals (mend writes files, runs tests)
  workspaceRoot: string;

  // Task scope
  taskDescription: string;
  erroredFiles: string[];                 // absolute paths
  diagnostics: Diagnostic[];              // structured tsc output

  // Feature scope (mend agents currently read this)
  featureSpecText?: string;               // the spec markdown as written
  acceptanceCriteria?: string;            // testable AC from the spec
  siblingTasks?: Array<{                  // other tasks in the same feature
    description: string;
    files: string[];
    status: "pending" | "completed" | "failed";
  }>;

  // Prior context (current `priorTaskExports.ts` injects this)
  priorTaskExports?: string;              // public API surface from earlier tasks
  installedTypes?: string;                // public API surface from npm deps
}
```

Adapter ownership: `spectoship2` provides `ParsedTask + ParsedFeatureSpec → MendContext`. Neither this package nor `@shipispec/tsmend` imports `ParsedTask`.

**Open: back-pressure (M4).** When mend writes new files, should `runValidationLoop` automatically re-trigger Layer 0 on the result? Two options:
- (a) Mend caller re-invokes the loop (current implicit behavior)
- (b) Loop accepts a `mendCallback?: (ctx: MendContext) => Promise<void>` and re-validates inside

Lean (a) — keeps responsibilities clean. Mend's output IS code; the next loop iteration is the caller's choice.

---

### 2b — Extract mend agents into `@shipispec/tsmend`

Move in **call-graph leaves first** order (verified against current imports):

1. **`multiFileMend`** — no internal mend deps; depends on `MendContext` (extracted first because `mendAgent` calls into it)
2. **`mendArchitect`** — no internal mend deps; depends on `MendContext`
3. **`mendAgent`** — depends on `multiFileMend` (mendAgent.ts:23). Must come after #1.
4. **`repairAgent`** — separate concern (skipped-task recovery); depends on `siblingTasks` field of `MendContext`

Each extraction needs:
- New fixture class in `@shipispec/tsmend/fixtures/`: "Layer 0 cannot fix, Layer 2 should fix"
- Integration test confirming the layer doesn't regress Layer 0's fixable set (run THIS package's benchmark from sister-package CI as a smoke test)
- Cost annotation: each mend call returns `{tokensIn, tokensOut, model, latencyMs, costUsd}` — surfaced via the per-layer event callback (see 3a)

---

### 2c — Unified result type
After v0.2, `runValidationLoop` should return a richer result:
```ts
{
  errorsBeforeLayer0: number;
  errorsAfterLayer0: number;
  lspFixesApplied: number;
  filesEdited: string[];
  remainingDiagnostics: Diagnostic[];
  // v0.2-added fields below — present on every result, even if mend didn't run
  errorsAfterAllLayers: number;     // === errorsAfterLayer0 if no mend ran
  mendFixesApplied: number;         // 0 if no mend ran
  totalCostUsd: number;             // 0 if no mend ran
}
```

The result shape is **purely additive** — old code keeps compiling unchanged because TS structural typing ignores extra fields. v0.1 callers receive the new fields whether they want them or not; they just won't reference them. v0.2 callers can consume them.

---

## Phase 3 — Telemetry + Real-Failure Pipeline
**Goal:** Replace synthetic fixtures with real-world failure data so the package improves from actual use.

### 3a — Structured per-layer events (callback, not accumulated array)
Emit via optional callback so the package never accumulates unbounded state:

```ts
export interface LayerEvent {
  layer: 0 | 1 | 2 | 3 | 4;
  errorCode: number;
  fixed: boolean;
  latencyMs: number;
  costUsd?: number;    // undefined for deterministic layers
  ts: number;          // Date.now() at emission
}

// On the existing options object
opts.onLayerEvent?: (event: LayerEvent) => void;
```

Why callback, not array-in-result: a workspace with 200 errors across 5 iterations emits ~1000 events. Returning an array forces accumulation in memory; a callback lets callers stream to file / OTel / a closure-pushed array as they prefer. Costs nothing if not provided.

This data answers: which error codes does Layer 0 fix most? Which ones always escape to Layer 2? Which cost the most? That's the hit-rate analysis that tells you where to invest in the allowlist next.

---

### 3b — Real-failure fixture pipeline
Synthetic fixtures cover known patterns; the unknown patterns come from production runs.

Pipeline:
1. When the spec pipeline encounters a TSC error that Layer 0-1 does NOT fix, snapshot the broken `.ts(x)` files + the `Diagnostic[]` array
2. Save as `fixtures/real-<timestamp>-<hash>/` with an auto-generated `expected.json` (errors before known, errors after = TBD)
3. Human labels `mustPass: false` initially (it's a new failure mode)
4. Once a fix is shipped, flip `mustPass: true` and update `errorsAfterMax`

This creates a self-growing test suite from production failures, which is the only way to close unknown gaps.

**`node_modules` strategy** — real failures are version-specific, so the synthetic-fixture symlink to `_shared/` doesn't apply. Pick one of:
- (a) Commit broken `.ts(x)` files + `package-lock.json` + `setup.sh` that runs `npm install` on demand. Smallest commit footprint; slowest CI (one install per fixture).
- (b) Content-addressable cache shared across real fixtures (pnpm-style). Smaller disk usage at scale, but needs custom tooling.
- (c) Snapshot only the `.d.ts` files for the specific deps the failure touches. Smallest disk + fastest CI; loses fidelity if a fix needs to look at a runtime export not in the snapshot.

Recommend (a) for the first 5–10 real fixtures, switch to (b) if/when CI install time becomes the bottleneck. Document the disk-space tradeoff in `fixtures/REAL.md`.

---

### 3c — Performance: shared Program instance
ARCHITECTURE.md §9 documents the issue: in-process tsc and the LSP fixer each load lib files independently (~600ms + ~200ms overhead per fixture). Unifying them behind a single `Program` requires picking one host abstraction.

Recommendation: keep separate instances for v0.1–v0.2 (correctness > performance), profile on a real 50-task spec run to quantify actual cost, then decide. If a full run costs $0.50 in LLM tokens and the extra lib-load costs 800ms, it's noise. If it's 30 seconds of wall time on a cold run, it's worth fixing.

---

## Open architecture decisions (deferred)

These are documented in ARCHITECTURE.md §12. Deferring until there's real data:

| Question | Defer until |
|---|---|
| Should detection and fixing share a single Program? | Phase 3 perf profiling |
| Custom rewriter for `export { X } from "./mod"` LSP gap? | Real-failure fixture data shows frequency |
| Config-driven safe set? | v0.2 — only if mend extraction reveals need |
| Transactional persist-to-disk? | Only if package is used outside LLM iteration context |
| Telemetry delivery shape | Resolved in 3a: callback, not result/EventEmitter/log |
| Sandboxing the workspace `typescript` load? | When/if a real-world incident proves a hostile workspace can exploit it. Until then: README warning is sufficient (M2). |

---

## Deprecation policy

Once Phase 2 ships `@shipispec/tsmend` (per D3), the existing `spectoship2/src/pipeline/{mendAgent,mendArchitect,multiFileMend,repairAgent}.ts` become candidates for removal:

- **`spectoship2 vN`** (mend extraction lands): pipeline imports from `@shipispec/tsmend`. The local files become re-export shims (same pattern as today's `validatorInProcess.ts` shim).
- **`spectoship2 vN+1`** (one minor version later): mark shims `@deprecated`; emit warning at import time.
- **`spectoship2 vN+2`**: remove shims entirely.

Same pattern for the existing `validatorInProcess` / `tsLanguageServiceFixer` shims — they're already in the "shim" stage; mark them `@deprecated` once `spectoship2` is updated to import from `@shipispec/tsfix` directly.

---

## Summary timeline

Phases are ordered, not time-bound. Effort estimates omitted because the cadence is unknown.

| Phase | Milestone | Done signal (concrete) |
|---|---|---|
| **0a–0c** | v0.1 stabilized | A fresh clone of just `tsc-defense-stack/` (no sibling packages) can `npm install && npm run benchmark` and see all 14 fixtures pass. Zero stale files. |
| **0.5** | v0.1.0 on npm | `npm view @shipispec/tsfix version` returns `0.1.0`; `npx @shipispec/tsfix --help` works |
| **1a–1d** | OSS launch-ready | `npx @shipispec/tsfix ./my-project` works cold on a fresh machine; CI green on all fixtures (14+ by then); README is the front door, not internal orientation |
| **2a–2c** | v0.2 shipped | `@shipispec/tsmend` published; `MendContext` interface stable; this package's result type expanded with v0.2 fields; Layer 2 fixtures pass in sister-package CI |
| **3a–3c** | v0.3 shipped | `onLayerEvent` callback supported; first 5 real-failure fixtures captured and passing; deprecation timeline started for spectoship2 shims |

**The anti-pattern to avoid:** Don't start Phase 2 (mend extraction) before Phase 1 (public bin + CI) is done. The extraction will be messy. You want the benchmark as a CI safety net before you move the mend agents, not after.
