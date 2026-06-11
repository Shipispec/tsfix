# `@shipispec/tsfix` — Project Roadmap

> Generated: 2026-05-03. Last updated 2026-06-10 (v0.6.2 live on npm — cosmetic CLI string fix over v0.6.1's library-migrations + multi-provider + onLayerEvent). Historical entries below may reference the package's prototype name "tsc-defense-stack" — that's accurate provenance, not a stale link.
> North star: ship a focused, trustable OSS package that vibe coders can drop into any project — not a super-app.

---

## Decisions (resolved)

| # | Question | Resolution |
|---|---|---|
| D1 | Is v0.1.0 going to npm publicly under `@shipispec/tsfix`? | **Yes.** Published 2026-05-04. v0.6.2 currently live on npm. |
| D2 | If workspace lacks `typescript`, hard error or bundled fallback? | **Hard error + `peerDependencies` declaration.** Preserves lib-path fix; matches typical OSS bin convention. |
| D3 | Mend agents into THIS package, or sister `@shipispec/tsmend`? | **In-package.** Originally decided as "sister package" (2026-05-03). **Reversed 2026-05-14** after the sister package proved to be pre-publish (`private: true`) and the two had effectively zero independent consumers — folding the work in eliminated a release-coordination tax that wasn't paying for itself. Layer 2 ships in `@shipispec/tsfix` v0.4.0; tsmend repo archived with a MOVED pointer. |
| D4 | Support Node 20.x, or require Node 23+? | **Node 20.x minimum.** Matches VS Code Extension Host runtime. |
| D5 | Is the OSS audience CLI users or library users? | **Both.** CLI as the headline (Layer 0/1 default), library API as the secondary section. Layer 2 is library-API-only. |

---

## Guiding constraints

1. **No scope creep into spectoship2 pipeline concerns.** The package knows nothing about specs, tasks, or models — only the `MendContext` shape, which is structural and consumer-agnostic.
2. **Every new error code or fix name requires a fixture.** The trust model is only as good as its pins.
3. **Dependency count stays small and justified.** Originally "near zero" (Layer 0/1 only). Since v0.4.0 the runtime deps are: `@ai-sdk/anthropic`, `ai`. Dev deps: `ts-morph`, `esbuild`, `tsx`, `vitest`, `typescript`. Layer 2 is opt-in — the CLI default path still only uses `typescript`, so a caller who never invokes `runMendLoop` pays no LLM cost.
4. **Ship the smallest thing that's useful in isolation.** A vibe coder should be able to `npx @shipispec/tsfix ./my-project` and get real value with zero config and no API key.

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

### 1c — Public README rewrite ✅ (2026-05-07 for v0.3.0; rewritten again 2026-05-14 for v0.4.0)

First public README landed alongside v0.3.0. Rewritten again at v0.4.0 to cover Layer 2 (in-package, opt-in) — see `README.md`. Internal-orientation README preserved at `docs/internal-orientation.md`.

Structure of the current public README (top to bottom):
1. **Tagline** — covers both Layer 0/1 (deterministic) and Layer 2 (LLM mend, opt-in).
2. **Before/after diff** — concrete Layer 0 example.
3. **30-second cold start** — `npx @shipispec/tsfix ./my-project`. The CLI is Layer 0/1 only; Layer 2 is library-API.
4. **What it fixes / does NOT fix** — 5-codes table for Layer 0, then a Layer 2 section for what escapes (TS2339, TS7006, TS2741, etc.).
5. **The four-layer model** — Layer 0/1/2 in this package; Layer 3/4 planned.
6. **Library API** — split into Layer 0/1 and Layer 2 sections with usage examples.
7. **Trust model** — Layer 0/1 has zero network surface; Layer 2 calls Anthropic — explicit warning.
8. **Contributing** — probe → fixture → allowlist for Layer 0; hand-author or generate for Layer 2.

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

## Phase 2 — Layer 2 LLM mend (in-package) ✅ (2026-05-14, v0.4.0)

**Outcome:** Layer 2 single-file LLM mend ships in `@shipispec/tsfix` v0.4.0. The originally-planned sister package `@shipispec/tsmend` was folded into tsfix instead — see D3 above for the reversal rationale.

### 2a — `MendContext` interface ✅ (2026-05-07, shipped in tsfix v0.3.0)

Public types `MendContext`, `LayerEvent`, `Diagnostic` shipped as additive exports in tsfix v0.3.0 — before any Layer 2 code landed, so the contract was reviewable independently of the implementation.

The interface stayed structural and consumer-agnostic (no `ParsedTask` / `ParsedFeatureSpec` leak from spectoship2). Adapter ownership: any caller (including spectoship2) constructs a `MendContext` from its own domain types.

```ts
export interface MendContext {
  workspaceRoot: string;
  diagnostics: Diagnostic[];
  erroredFiles: string[];
  taskDescription?: string;
  featureSpecText?: string;
  acceptanceCriteria?: string;
  siblingTasks?: Array<{
    description: string;
    files: string[];
    status: "pending" | "completed" | "failed";
  }>;
  priorTaskExports?: string;
  installedTypes?: string;
}
```

**Back-pressure decision (M4):** Mend caller re-invokes the loop (option a). Layer 2's output is code; the next Layer 0 pass is the caller's choice. Not auto-chained.

### 2b — Layer 2 implementation ✅ (2026-05-14)

Originally planned as porting `mendAgent + mendArchitect + multiFileMend + repairAgent` from spectoship2. Implementation took a different path: a fresh Layer 2 surface designed against the `MendContext` contract from scratch, rather than porting the spectoship2 agents. Result:

| Original plan (port) | Shipped instead |
|---|---|
| Port 4 spectoship2 files (~1,967 LOC) | 4 fresh src files (~1,200 LOC): `typeContext`, `mendAgent`, `applyEditBlock`, `runMendLoop` |
| Architect + editor split per `mendArchitect` | Single-call `mendSingleFile` with type-context injection — empirically converges in 1 iteration on 97% of fixtures |
| Custom prompt scaffolding | Vercel AI SDK + `@ai-sdk/anthropic`, top-level `system:` parameter (v6 pattern) |
| ad-hoc patch format | Aider-style SEARCH/REPLACE with 3-tier fuzzy applier (`applyEditBlock`) |
| Custom retry logic | `runMendLoop` — bounded retry with error-signature-set no-progress / regression detection |

The architectural moat is **`getTypeContext`**: resolves an error site to its declaring type via `getTypeAtLocation()` + `getDeclarations()`, slices ±3 lines around the error site and ±20 lines around the declaration. Special case for `PropertyAccessExpression` so TS2339 resolves to the *receiver's* type. No other OSS tool calls the TypeChecker like this; Aider/Cline/Cursor use generic grep or repo-maps.

**The spectoship2 mend agents** (`mendAgent`, `mendArchitect`, `multiFileMend`, `repairAgent`) remain in `spectoship2/src/pipeline/` for now — unaffected by this work. The Phase 2 deprecation plan (have spectoship2 import Layer 2 from `@shipispec/tsfix` instead) is now optional rather than load-bearing — see Deprecation policy below.

### 2c — Layer 2 fixtures + benchmark ✅ (2026-05-14)

- 35 Layer-2 fixtures total: 3 hand-authored minimal + 2 realistic + 30 ts-morph-generated via `npm run generate-fixtures`.
- `npm run benchmark:llm` runs them against Anthropic. Skips silently when `ANTHROPIC_API_KEY` is unset.
- CI gains a Layer-2 step gated on the secret.
- 35/35 pass on `claude-haiku-4-5` at $0.036 total ($0.001/fixture avg), iter-1 success 97%, P95 latency ~1.5s.

### 2d — Unified result type ✅ (2026-05-19, v0.6.1)

Originally planned: extend `runValidationLoop` result with `errorsAfterAllLayers`, `mendFixesApplied`, `totalCostUsd`. Deferred at v0.4.0 because Layer 0/1 and Layer 2 stayed separate entry points (`runValidationLoop` vs `runMendLoop`) with no natural home for a unified result. **Shipped in v0.6.1** alongside the `onLayerEvent` callback (Phase 3a): the new `runFullStack(opts)` entrypoint composes Layer 0/1 → 2 → 4 and returns `RunFullStackResult` — a flat shape with `errorsAfterLayer1`, `errorsAfterAllLayers`, `totalCostUsd`, `totalLatencyMs`, `remainingByCode`, `remainingByFile`, plus per-layer sub-results. Matches this section's original sketch with cost + telemetry rolled in.

---

## Phase 3 — Telemetry + Real-Failure Pipeline
**Goal:** Replace synthetic fixtures with real-world failure data so the package improves from actual use.

### 3a — Structured per-layer events (callback, not accumulated array) ✅ (2026-05-19, v0.6.1)

**Shipped in v0.6.1.** `onLayerEvent?: (event: LayerEvent) => void` is now an option on `ValidationLoopOptions`, `RunMendLoopOptions`, and `RunFullStackOptions`. Layer 1 emits one event per fixable-error attempt, Layer 2 one per `runMendLoop` iteration, Layer 4 one per stub applied (coalesced stubs emit one event per `stub × errorCode` pair). `costUsd` is intentionally omitted from the per-event payload — callers compute it from `result.layer2.totalInputTokens`/`totalOutputTokens` plus their own pricing. Undefined callback costs nothing. The unified result type (Phase 2d) landed in the same release via `runFullStack` / `RunFullStackResult`. Covered by 10 new tests in `src/runFullStack.test.ts`.

Original design (as shipped):
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

### 3c — Performance: shared lib-file parse ✅ (2026-06-10)

ARCHITECTURE.md §9 documented the issue: in-process tsc (Layer 0) and the LSP fixer (Layer 1) each loaded lib files independently (~600ms + ~200ms overhead per fixture). The original framing assumed the fix was "unify behind a single `Program`, which requires picking one host abstraction."

**Shipped a smaller, byte-identical change instead — a shared `ts.DocumentRegistry`, not a unified `Program`.** Both hosts stay (Layer 0 keeps its `CompilerHost`, Layer 1 keeps its `LanguageServiceHost`); they overlap only on the immutable lib `.d.ts` slice by sharing one process-global registry + lib-text cache (`src/sharedTsHost.ts`). The lib parse is paid once; every later consumer hits the shared registry. See ARCHITECTURE.md §9 and §12 D2.

- **T-3c-1** — opt-in perf instrumentation (`src/perfInstrument.ts`, `--perf` benchmark flag) to quantify the double-load before touching it.
- **T-3c-2** — the shared registry. Correctness guard: non-lib files are content-versioned (FNV-1a) so a persistent registry can't hand back a stale parse; `TSFIX_SHARED_HOST=false` restores pre-refactor behavior and a regression test asserts byte-identical diagnostics both ways.
- **T-3c-3** — this docs pass.

**Measured latency delta** (the clean, low-noise span directly attributable to the change — Layer 0 cold lib-load via `host.getSourceFile`, averaged over 14 fixtures on the same WSL2 box):

| Span | T-3c-1 baseline | T-3c-2 | Δ |
|---|---|---|---|
| Layer 0 cold lib-load (shared slice) | 393.7 ms | 38.3 ms | **−90%** |

Scope note: only lib `.d.ts` files are shared, not the `node_modules` dependency `.d.ts` graph (which dominates `layer1.firstDiagnosticsMs`). Sharing the dep graph too is a larger win but needs the same content-addressing with more divergence risk — left as a follow-up. No regression: `npm run benchmark` stays 14/14, diagnostics byte-identical. Full methodology in `plans/progress.md` (T-3c-1 / T-3c-2).

---

## Phase 4 — Layer 3 (multi-file mend), prove-then-build

**Goal:** Close the last layer gap — multi-file LLM mend via `findReferences()` blast-radius — **but only if it's proven necessary.** Layers 0/1/2/4 already ship; Layer 3 is the one piece mentioned-but-not-built. See ARCHITECTURE.md §13 for the full design.

The discipline (from `docs/internal/STATUS.md`'s blocker — *"synthetic ripple fixtures so far converge via iteration; we don't have a forcing function yet"*): Layer 2's per-file iteration already collapses most multi-file ripples, so build Layer 3 only after a fixture proves iteration can't converge. The unattended loop builds the **deterministic half** (blast-radius, prompt builder, multi-file apply, wiring) with the LLM **mocked**; real paid validation is a manual step (SIGN-104).

Tasks (`plans/prd.json`):
- **T-4-1** — `src/blastRadius.ts`: deterministic `findReferences()` blast-radius computation. No LLM. Independently useful.
- **T-4-2** *(the gate)* — `fixtures/forcing-multifile-ripple/` + a deterministic test proving per-file iteration cannot converge. If it converges, Layer 3 is **deferred** and T-4-3/T-4-4 are skipped (SIGN-106).
- **T-4-3** — multi-file mend prompt builder (folds the blast radius into one prompt; LLM mocked).
- **T-4-4** — `multiFileMend()` + wiring as opt-in Layer 3 (off by default; benchmark stays 14/14; disabled path byte-identical).
- **T-4-5** — extract `PRICING` to `src/pricing.ts` (single source; resolves the `index.ts:451` TODO).
- **T-4-6** — docs refresh (this file + ARCHITECTURE.md §2/§13).
- **T-4-7** *(manual, skipped)* — paid end-to-end LLM validation of Layer 3 against the forcing fixture.

---

## Open architecture decisions (deferred)

These are documented in ARCHITECTURE.md §12. Deferring until there's real data:

| Question | Defer until |
|---|---|
| ~~Should detection and fixing share a single Program?~~ | ✅ Resolved Phase 3c — shared `DocumentRegistry` (not a unified Program); see ARCHITECTURE.md §12 D2 |
| Custom rewriter for `export { X } from "./mod"` LSP gap? | Real-failure fixture data shows frequency |
| Config-driven safe set? | v0.2 — only if mend extraction reveals need |
| Transactional persist-to-disk? | Only if package is used outside LLM iteration context |
| Telemetry delivery shape | Resolved in 3a: callback, not result/EventEmitter/log |
| Sandboxing the workspace `typescript` load? | When/if a real-world incident proves a hostile workspace can exploit it. Until then: README warning is sufficient (M2). |

---

## Deprecation policy

**spectoship2 mend agents** (`mendAgent`, `mendArchitect`, `multiFileMend`, `repairAgent`) are unaffected by the v0.4.0 merge — they continue to live in `spectoship2/src/pipeline/` and serve spectoship2's pipeline. They are *not* equivalent to tsfix v0.4.0's Layer 2 (different prompt strategy, different patch format, depend on `ParsedTask`/`ParsedFeatureSpec`).

Optional future path: have spectoship2 migrate to `@shipispec/tsfix`'s Layer 2 surface by writing a `ParsedTask → MendContext` adapter. Decision deferred — not load-bearing until spectoship2 has a reason to consolidate.

**validatorInProcess / tsLanguageServiceFixer shims** in spectoship2 (the v0.1.0-era re-export shims) — same status as before. Mark them `@deprecated` once spectoship2 is updated to import from `@shipispec/tsfix` directly.

---

## Summary timeline

Phases are ordered, not time-bound. Effort estimates omitted because the cadence is unknown.

| Phase | Milestone | Status |
|---|---|---|
| **0a–0c** | v0.1 stabilized | ✅ 2026-05-03 — fresh clone runs `npm install && npm run benchmark`, all 14 fixtures pass |
| **0.5** | v0.1.0 on npm | ✅ 2026-05-04 — `npm view @shipispec/tsfix version` returns `0.4.0` (live: `0.3.0`) |
| **1a–1d** | OSS launch-ready | ✅ 2026-05-07 (v0.3.0) — `npx @shipispec/tsfix ./my-project` works cold; CI green; public README |
| **2a–2d** | Layer 2 in-package | ✅ 2026-05-14 (v0.4.0 merged) — `runMendLoop` + `mendSingleFile` shipped, 35/35 Layer-2 fixtures pass on Haiku 4.5, opt-in via library API |
| **3a** | Telemetry + unified result | ✅ 2026-05-19 (v0.6.1) — `onLayerEvent` callback + `runFullStack`/`RunFullStackResult` shipped |
| **3c** | Shared lib-file parse (perf) | ✅ 2026-06-10 — shared `DocumentRegistry`; Layer-0 cold lib-load 393.7 ms → 38.3 ms (−90%), benchmark still 14/14 |
| **3b** | Real-failure fixture pipeline | ✅ tooling 2026-06-10 (T-3b-1/2/3 — `fixtures/REAL.md`, `capture-fixture.mjs` real-dir capture, report-only benchmark gating); corpus of 5–10 real fixtures accrues from production runs |
| **4** | Layer 3 (multi-file mend) | in progress — prove-then-build via `findReferences()` blast-radius (Layer 4 stub-and-continue already shipped v0.5.0); see Phase 4 section |

**Lessons from the path:** "Don't start Phase 2 (mend extraction) before Phase 1 (public bin + CI) is done" held — by the time Layer 2 work landed, the benchmark and matrix gates were already there as CI safety nets. The bigger lesson was D3: building tsmend as a sister package first, then folding it back in, was the right call. The sister-package phase forced clean contract design (MendContext shipped in v0.3.0 *before* any mend code), and the merge happened only once the API surface had stabilized through real implementation work. The two-step "split, design contract, merge" was slower than "in-package from day one" would have been, but produced a cleaner public API.
