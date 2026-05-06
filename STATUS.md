# TSC Defense Stack — Status

> Snapshot: 2026-05-05. Read alongside `README.md` (orientation), `CLAUDE.md` (working principles), `tsc-defense-roadmap.md` (phased plan), `CHANGELOG.md` (release history).

## TL;DR

`@shipispec/tsfix` **shipped v0.1.0 to npm 2026-05-04.** Standalone package that runs deterministic TypeScript error-recovery on a workspace before any LLM is involved. Exports a validation loop that catches and auto-fixes 5 classes of TS error. Against a 14-fixture benchmark spanning typos, did-you-mean cases, multi-file ripples, and 4 API-drift scenarios, **14/14 fixtures pass and 14/25 errors are auto-fixed (56%)**. Remaining errors are intentionally outside Layer 0's scope and waiting on the (not-yet-extracted) mend layer.

**Install:** `npm install @shipispec/tsfix` (peer dep: `typescript >=5.0.0`).
**Bin:** `tsfix --workspace <path>` (works after `npm link` from a clone; `npx` cold-start blocked on Phase 1a esbuild bundle).

---

## What works

### Public API (`src/index.ts`)
- `runValidationLoop(opts)` — full deterministic loop (validate → auto-fix → re-validate). Recommended entry point.
- `runInProcessTsc(opts)` — in-process `tsc --noEmit` returning structured diagnostics. No spawn overhead, no Node 23 startup-pause issue.
- `runLSPFixerPass(opts)` — Layer 0 only. Edits files in place.
- `discoverTsFiles(workspaceRoot)` — file discovery helper (skips `node_modules`, `.next`, `dist`, `build`, `.git`, `out`, `coverage`).

### Layer 0 — TS LanguageService auto-fixer
Uses `ts.LanguageService.getCodeFixesAtPosition` (the same engine VS Code Quick Fix uses).

**Fixable error codes** (`SAFE_FIXABLE_CODES` — `tsLanguageServiceFixer.ts:37`):
| Code | Meaning | Fix |
|---|---|---|
| TS2304 | Cannot find name | auto-import |
| TS2305 | Module has no exported member | did-you-mean rename |
| TS2551 | Property does not exist, did you mean Y | spelling |
| TS2552 | Cannot find name, did you mean Y | spelling |
| TS2724 | Module member did-you-mean | import rename |

**Safe fix names** (`SAFE_FIX_NAMES` — `tsLanguageServiceFixer.ts:54`): `import`, `fixImport`, `spelling`, `fixSpelling`. Other returned fix names (`fixMissingFunctionDeclaration`, etc.) are skipped because they introduce stubs / structural changes.

**Iteration loop**: default 5 passes (`tsLanguageServiceFixer.ts:108`). Stops early via signature-set progress check — if the set of `(file, start, code)` tuples is identical across two iterations, we're stuck. Cascades like `import rename → type-annotation rename → method-call rename` typically converge in 3 iterations.

### CLI (`cli/run-stack.ts` + `bin/tsfix.mjs` wrapper)
Two entry points, same behavior:
- `npm run run-stack -- --workspace <path>` — runs via the local `tsx`
- `tsfix --workspace <path>` — after `npm link`, runs via the `bin/tsfix.mjs` wrapper which spawns `node` against tsx's CLI entry resolved through `require.resolve("tsx/cli")`

Flags: `--json`, `--no-lsp`, `--verbose`, `--files <comma-list>`, `--help`. Exit 0 = clean, 1 = errors remain, 2 = bad args / harness error. Both paths verified end-to-end with exit-code propagation.

**Phase 1a still required for `npx @shipispec/tsfix ./project`.** The wrapper depends on `tsx` being resolvable from this package's own `node_modules` — fine for `npm install` + `npm link`, but `npx` against a published tarball would still need a bundled `.js` CLI.

### Benchmark (`benchmark/run-benchmark.ts`)
- Iterates every `fixtures/<name>/` directory containing `expected.json`
- Snapshots each fixture's source files in memory; restores after the run so the in-place LSP edits don't pollute the next run
- Compares actual outcomes against `expected.json` fields (`errorsBefore`, `errorsAfterMax`, `lspFixesAppliedMin/Max`, `mustPass`, `expectedFixerCodes`)
- `--fixture <name>` to run one in isolation

### Fixture catalog (14 total)

**Positive — Layer 0 should resolve to zero:**
| Fixture | Tests | Status |
|---|---|---|
| `clean-baseline` | regression: zero-error workspace stays zero | ✓ |
| `synthetic-missing-import-ts2304` | TS2304 → auto-import | ✓ 1 fix |
| `synthetic-no-exported-member-ts2305` | TS2305 `import { ueState }` → `useState` | ✓ 2 fixes (import + call site) |
| `synthetic-import-rename-ts2724` | TS2724 `paseDate` → `parseDate` | ✓ 2 fixes (import + call site) |
| `synthetic-property-typo-ts2551` | TS2551 `.lenght` / `.toUperCase` | ✓ 2 fixes |
| `synthetic-typo-ts2552` | TS2552 `consol` / `JSon` / `Promse` | ✓ 4 fixes |
| `synthetic-multifile-ripple` | 3-iteration cascade across import → type → method | ✓ 3 fixes |

**Negative — Layer 0 must NOT touch (escapes to mend layer):**
| Fixture | Documents |
|---|---|
| `synthetic-implicit-any-ts7006` | TS7006: param type-inference picks wrong type |
| `synthetic-missing-prop-ts2741` | TS2741: object-literal stub picks placeholder |
| `synthetic-cross-file-typo-ts2305` | LSP returns zero fixes for `export { X } from "./mod"` |

**API-drift — modeled on real LLM mistakes:**
| Fixture | Error class | Fixable? |
|---|---|---|
| `api-drift-zod4-against-v3` | TS2339 `z.email()` (v4 surface vs installed zod@3) | No — semantic mismatch |
| `api-drift-react19-against-v18` | TS2305 `useActionState` (react@18 has no candidate) | No — LSP returns zero fixes |
| `api-drift-next16-sync-cookies` | TS2339 `cookies().get(...)` (Next 16 returns Promise) | No — needs `await` insertion + async propagation |
| `api-drift-drizzle-wrong-subpath` | TS2305 `pgTable` from `drizzle-orm` instead of `drizzle-orm/pg-core` | No — auto-import doesn't suggest the right subpath |

### Project-shape matrix (`scripts/run-matrix.mjs`, `npm run matrix`)

Pre-publish gate distinct from the synthetic benchmark: builds the local tarball, then for each `test-matrix/<sample>/` copies it to `/tmp/tsfix-matrix/<sample>/`, runs `npm install` + `npm install <tarball> typescript`, executes `tsfix --workspace . --json`, and compares against `expected.json`. Catches setups where the *published* package fails — distinct from the benchmark, which exercises in-tree source.

| Sample | Project shape | errorsBefore → after | fixes | Notes |
|---|---|---|---|---|
| `monorepo-refs` | TS project references (`files: []` + `references`) | 0 → 0 | 0 | **Pinned as documented limitation.** Root tsconfig parses to zero `fileNames`; in-process tsc never sees leaf packages. Workaround: point `--workspace` at a leaf. Real fix needs `tsc --build` semantics. |
| `next-app` | Next.js App Router, `paths` alias, `jsx: preserve` | 4 → 3 | 1 | TS2552 fixed; 3 JSX-namespace errors (TS2503 + 2× TS7026) correctly left alone — those need `jsxImportSource: react` or the Next compiler plugin. `mustPass: false`. |
| `plain-ts-bundler` | esnext + bundler resolution | 1 → 0 | 1 | Baseline. |
| `plain-ts-commonjs` | CJS, ES2015 target, node10 resolution | 1 → 0 | 1 | Legacy long-lived-codebase setup. |
| `plain-ts-nodenext` | nodenext resolution + `@types/node` | 1 → 0 | 1 | Nodenext semantics through in-process tsc. |
| `react-vite` | TSX, `jsx: react-jsx`, `isolatedModules: true` | 2 → 0 | 2 | Two typos in one TSX file. |

**6/6 passing as of 2026-05-05.** Not wired into `prepublishOnly` (adds ~3 min to publish) — run manually before tagging.

### Recent changes (Phase 0 + 0.5, completed 2026-05-03 → 2026-05-04)

**Code / behavior changes:**
1. **Signature-set progress check** (`tsLanguageServiceFixer.ts:194-216`) — replaced count-based "no progress" detection. A TS2724 fix that produces a TS2552 at a different position keeps the count constant but is genuine progress. Extracted as `computeErrorSignatures` + `signatureSetsEqual` (Phase 0b refactor).
2. **`maxIterations` 2 → 5** (`tsLanguageServiceFixer.ts:108`) — multi-step cascades (import → annotation → method) need 3-4 hops; signature check still terminates early when truly stuck.
3. **TS2551 added to `SAFE_FIXABLE_CODES`** — single `spelling` fix per error, fix name already trusted, no ambiguity. Probed before adding.
4. **`bin/tsfix.mjs` Node ESM wrapper** added (Phase 0c) so `npm link` users can run `tsfix --workspace ...` directly. Resolves `tsx/cli` via `require.resolve`, spawns `node` against it, propagates exit code/signal.

**Infrastructure changes:**
5. **Standalone install** (Phase 0c) — package removed from monorepo `workspaces`; `npm install` from inside `tsc-defense-stack/` now works. `prebenchmark` hook lazy-installs `fixtures/_shared/` deps (react/zod/@types/react). Validated: copying the package to `/tmp/` and running `npm install && npm run benchmark` cold produces 14/14 passes.
6. **26 unit tests** (Phase 0b) across 3 files, codifying the bugs we caught earlier. `applyFixToSnapshots`, `fixesAreEquivalent`, `computeErrorSignatures`, `signatureSetsEqual` exposed as `@internal` exports for testability.
7. **`tsconfig.json`** added at package root so `npm run check-types` works without compiling intentionally-broken fixture files.

**Release:**
8. **Published `@shipispec/tsfix@0.1.0` to npm** (2026-05-04). 8-file tarball, 15.8 KB packed. Tagged `v0.1.0-tsfix` in git, pushed to `origin/main`. Final scope+name differs from the original `@spectoship/tsc-defense` plan because of the Spec2Ship/spec2ship namespace collision (different unrelated project).

**Cleanup (Phase 0a):**
9. Deleted ~268 KB of stale snapshot folders (`validation/`, `prompts/`, `metadata/`, `mend/`, `routing/`) and `refresh-copies.sh` (encoded an obsolete copy direction). README rewritten with correct source-of-truth direction. `design-docs/ts-repair2.md` renamed to `installed-exports.md` (it's a doc for a spectoship2 module, not this package).

---

## What's planned

### v0.2 target — extract LLM mend layers
Per `src/index.ts:34-39`, the mend agents (`mendAgent`, `mendArchitect`, `multiFileMend`, `repairAgent`) currently live in `spectoship2/src/pipeline/` and are **not** exported from `@shipispec/tsfix`. They depend on internal types (`ParsedTask`) that need to be redesigned as opaque interfaces before they can be moved into this package.

Until then, downstream callers must import the mend layers from `spectoship2` directly — the tsc-defense package is Layer 0 only.

### Telemetry
Per `CLAUDE.md` "What's missing": no per-layer event stream today. Logs are scattered across `[ts-lsp-fixer]`, `[in-process-tsc]`. Goal: each layer emits `{layer, errorCode, fixed: bool, latencyMs, cost}` so we can slice hit rates by error class once we have real failure data.

### Standalone bin
`package.json#bin` declares `tsfix → ./cli/run-stack.ts`, but the CLI requires `tsx` at runtime. To ship a real `npx @shipispec/tsfix` story we need either an esbuild bundle or a transpiled `dist/`.

### Real-failure fixture pipeline
Synthetic fixtures cover known patterns; we still need a way to capture *unknown* patterns from real spec-pipeline failures. Currently nothing on disk under `spectoship2/tests/test{20-28}R/` has TSC errors (post-lib-path fix), so we can't backfill from history. The next time the spec pipeline fails on a TSC error in the wild, snapshot the broken `.ts(x)` files into `fixtures/<name>/` with an `expected.json`.

---

## Current gaps

### Documentation drift
**Resolved 2026-05-03 (Phase 0a):** README rewritten with correct source-of-truth direction; fixture count corrected to 14; `design-docs/ts-repair2.md` renamed to `design-docs/installed-exports.md` to reflect what it actually documents; CLAUDE.md updated.

### Stale snapshot folders
**Resolved 2026-05-03 (Phase 0a):** `tsc-defense-stack/{validation, prompts, metadata, mend, routing}/` deleted (15 files, ~268 KB). `refresh-copies.sh` deleted. Verified zero imports referenced these paths before deletion; benchmark still passes 14/14 after.

### LSP-fixer limitations not yet addressed
- `export { X } from "./mod"` — TS LanguageService returns zero code-fixes even though it does for the `import { X }` form. A custom rewriter would be straightforward (look up source module's exports, find closest match by Levenshtein) but the project principle is "don't re-implement what TypeScript already does." Open question whether this pattern is common enough in real LLM output to warrant breaking that rule.
- `useActionState`-style errors where the typo-mistake-vs-real-API distance is too large for the LSP to suggest anything. By definition Layer 0 can't help here; this is mend territory.

### Footgun: CLI mutates fixtures in place
Discovered 2026-05-03 during bin verification: running `tsfix --workspace fixtures/<name>` on a fixture writes the LSP fixer's edits directly to `lib/*.ts` and there is no snapshot/restore (only the benchmark snapshots). Running the CLI on a synthetic fixture irreversibly fixes the broken code, breaking the next benchmark run. Mitigation today: don't point the CLI at fixtures during dev — use the benchmark instead. Real fix: add a `--dry-run` flag, or have the CLI refuse to run inside `fixtures/` paths unless explicitly opted in.

### Test infrastructure gaps
- **Unit tests** ✅ resolved 2026-05-03 (Phase 0b): 26 tests across 3 files (`src/index.test.ts`, `src/tsLanguageServiceFixer.test.ts`, `src/validatorInProcess.test.ts`) covering `applyFixToSnapshots`, signature-set progress (extracted as `computeErrorSignatures` + `signatureSetsEqual`), `fixesAreEquivalent`, `discoverTsFiles`, and the `runInProcessTsc` lib-path override. The three real bugs caught earlier this session (count-based progress check, iteration cap, lib path) are now codified as tests.
- **No CI for the benchmark.** A regression in the LSP fixer that breaks one of the 14 fixtures would only be caught if someone runs `npm run benchmark` manually. Phase 1b adds GitHub Actions for this.
- **`tsc-defense-stack/` standalone install** ✅ resolved 2026-05-03 (Phase 0c): package now has its own `node_modules` after `npm install`; `npm run benchmark` works from the package root with no sibling-package dependency. Removed from the monorepo `workspaces` array; spectoship2 now references via `"file:../tsc-defense-stack"`.

### Coverage gaps in the fixture set
What's NOT yet exercised that probably should be:
- Multi-file ripple where the error chain crosses 3+ files (current ripple fixture is 2 files, 3 iterations)
- Auto-import where multiple package candidates exist (ambiguity rejection)
- Auto-import where the symbol is in `@types/X` and the bundled types are empty (React's `@types/react` fallback case)
- TS2741 `missing property` where a `addMissingPropertyAndOptional` fix exists but should be suppressed
- Files that produce 10+ errors of the same class (stress test for the iteration loop)
- TSX files (current set is all `.ts`; JSX-specific fixes like `fixUnknownProperty` aren't probed)
- Workspaces using Yarn PnP, pnpm, or npm — currently all fixtures use a flat `node_modules` symlink to `_shared/`

### Unknown — needs a probe
- Whether the LSP returns auto-import candidates from local files when those files use `export type` vs `export interface` vs `export class` (the `synthetic-missing-import-ts2304` fixture only tests `export function`)
- Whether `getCodeFixesAtPosition` is performance-sensitive at high error counts. Current largest fixture has 5 errors; we don't know what a 100-error file does.
