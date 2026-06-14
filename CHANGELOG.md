# Changelog

All notable changes to `@shipispec/tsfix` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **GitHub Action** (`action.yml`, composite). Run tsfix as a CI gate: `uses: shipispec/tsfix@<ref>` after your install step. Inputs for `workspace` / `files` / `llm` (+ provider/model/budget) / `version` / `fail-on-error`; outputs `errors-before`/`errors-after`/`fixes-applied`/`passed`; writes a job summary. Wraps the published CLI via `npx`; not part of the npm tarball. Docs: `docs/github-action.md`.

## [0.7.1] - 2026-06-13

**UX patch.** No API or behavior change to the fix logic — improves the CLI's first-run experience so a no-key run doesn't read as a dead end.

### Changed
- **CLI first-run nudge.** When errors survive the deterministic Layer 0/1 pass and `--llm` was not used, the human report now points the user at the LLM mend layer with the exact re-run command and the BYOK setup (`ANTHROPIC_API_KEY` / `--llm-provider`), instead of ending on a bare `✗ FAIL`. Makes a "fixed 2 of 9" result read as "here's how to get the rest" rather than a dead end. Output-only; no API or exit-code change. Suppressed on `--json` and `--dry-run`.

## [0.7.0] - 2026-06-13

**Layer 1 coverage release.** Two new deterministic (no-LLM) fixes plus the first `.tsx` fixtures — all in the free, default Layer 0/1 path; no API surface change, no new dependencies. Head-to-head on a workspace with a typo'd re-export + a typo'd JSX prop + a baseline name typo: v0.6.2 fixed 1/3 (left TS2724 + TS2322), v0.7.0 fixes 3/3. Benchmark gate 7/7 → 10/10. Layer 3 (multi-file mend) remains built-but-dormant/opt-in and unvalidated (see ARCHITECTURE.md §13); this release does not change that.

### Added (Layer 1 — deterministic coverage)
- **Export-from rewriter.** TypeScript's LanguageService offers no applyable code-fix for a typo'd re-export `export { X } from "./mod"` (a close typo surfaces as TS2724 with a "Did you mean?" message, a far wrong-name as TS2305 — neither yields a fix), even though it does for the `import { X }` form. Layer 1 now fills this gap: when the re-exported name is a close typo of a real export of the target module it is renamed deterministically (no LLM). It reproduces only TypeScript's own spelling *threshold* (`distance < floor(len*0.4)+1`) via a bounded Levenshtein — not TS's fix engine — and abstains on ties, out-of-threshold wrong-names, `X as Y` aliases, and unresolved modules, so semantic wrong-names still escalate to the LLM. Pinned by `fixtures/synthetic-export-from-typo-ts2724` (fix) + `synthetic-cross-file-typo-ts2305` (abstain).
- **JSX prop-typo fixes (TS2322).** `2322` is now in `SAFE_FIXABLE_CODES`, admitted *only* for the did-you-mean case: a typo'd JSX prop (e.g. `classNam`→`className`) surfaces as TS2322 with TypeScript's high-confidence `spelling` code-fix. Real type mismatches (`number = string`, return-type errors, etc.) offer no code-fix, so the existing `SAFE_FIX_NAMES` gate makes the fixer abstain on them — it never touches a genuine type error. Pinned by `fixtures/synthetic-jsx-prop-typo-ts2322`.
- **TSX + auto-import coverage fixtures.** First `.tsx` fixtures: `synthetic-tsx-missing-import-ts2304` pins that the deterministic fixer works on JSX files and resolves the `@types/react` fallback; `synthetic-autoimport-ambiguous-ts2304` pins that Layer 1 abstains when an auto-import has two equally-valid candidates.

## [0.6.2] - 2026-05-23

**Cosmetic patch.** No behavior change; no API surface change. Drops the stale prototype-era "TSC Defense Stack" string from CLI output (was the human-report banner header), replaced with "tsfix" to match the published package name. Surfaced while debugging a vhs demo recording — the recording would otherwise have shown stale branding above the fold. 147/147 tests still pass.

### Changed
- **CLI human-report header** now prints `tsfix — <workspace>` instead of `TSC Defense Stack — <workspace>` (`cli/run-stack.ts:287`).
- **Benchmark runner header** now prints `tsfix benchmark — N fixture(s)` instead of `TSC Defense Stack Benchmark — N fixture(s)` (`benchmark/run-benchmark.ts:187`; contributor-facing, not shipped in the npm tarball).

## [0.6.1] - 2026-05-19

**Integration release.** Combines v0.6.0's library-aware error recovery with the multi-provider + telemetry work that landed on `main` between v0.5.0 and v0.6.0. The npm-published v0.6.0 was built from a stale local checkout and shipped without the Tier 2 (multi-provider) and Tier 3 (onLayerEvent + runFullStack) features that were already on `main`. v0.6.1 is the canonical "everything-since-0.5.0" release; users upgrading from v0.5.0 should jump straight to v0.6.1.

### Added (Tier 3 — telemetry + unified entrypoint)
- **`onLayerEvent?: (event: LayerEvent) => void`** callback option on `ValidationLoopOptions`, `RunMendLoopOptions`, and (new) `RunFullStackOptions`. Wires the `LayerEvent` type that's been published since v0.3.0 but never had a callback. Optional — undefined callback costs nothing.
  - **Layer 1** emits one event per fixable-error attempt: `{layer: 1, errorCode, fixed, latencyMs, ts}`. `fixed: true` when a safe LSP fix landed; `fixed: false` when the fixer abstained (no candidate, ambiguous candidates, or zero-fix response).
  - **Layer 2** emits one event per `runMendLoop` iteration: `{layer: 2, errorCode: <dominant code in iteration input>, fixed: <iteration cleared all errors>, latencyMs, ts}`. `costUsd` intentionally omitted from the per-event payload — callers can compute it from `result.layer2.totalInputTokens` + `totalOutputTokens` plus their own pricing.
  - **Layer 4** emits one event per stub applied: `{layer: 4, errorCode: <parsed from "TSNNNN">, fixed: true, latencyMs: 0, ts}`. Multi-error coalesced stubs emit one event per `(stub × errorCode)` pair.
- **`runFullStack(opts)`** — new top-level entrypoint that composes Layer 0/1 → Layer 2 (opt-in via `llm`) → Layer 4 (opt-in via `stubOnFailure`) and returns a unified `RunFullStackResult`. Callers who want "run the whole stack" no longer need to compose `runValidationLoop` + `runMendLoop` + (post-`runInProcessTsc` re-check) by hand. Library equivalent of the CLI's existing all-layers flow.
- **`RunFullStackResult`** flat shape: `passed`, `errorsBefore`, `errorsAfterLayer1`, `errorsAfterAllLayers`, `layer1` (LSPFixer sub-result), `layer2` (RunMendLoopResult | null), `layer4` (`{stubsApplied: AppliedStub[]} | null`), `totalCostUsd`, `totalLatencyMs`, `remainingByCode`, `remainingByFile`. Matches the v0.3.0 roadmap sketch for the "unified result" type with cost + telemetry rolled in.
- **10 new unit tests** in `src/runFullStack.test.ts` covering: clean workspace, Layer-1-only fix, unfixable-no-LLM, mocked-Layer-2 + cost math, unknown-model fallback, Layer-4 stubOnFailure path, per-error Layer-1 events, per-iteration Layer-2 events, per-stub Layer-4 events, undefined-callback smoke.

### Added (multi-provider — Tier 2)
- **OpenAI and Google providers** for Layer 2. `runMendLoop` and `mendSingleFile` now accept `llm.provider: "anthropic" | "openai" | "google"` (was: `"anthropic"` only). Each provider uses its corresponding `@ai-sdk/X` package via a small `buildLanguageModel` factory in `mendAgent.ts`. The factory's `switch` is exhaustive — TypeScript flags missing cases if a new provider is added to the `LLMProvider` union.
- **`LLMProvider` type** exported from `src/index.ts`. Re-exportable for callers building their own CLI / pipeline integrations.
- **CLI `--llm-provider <name>`** flag — `anthropic` (default, back-compat), `openai`, or `google`. Invalid values exit 2 with a clear message.
- **Per-provider default models** when `--llm-model` is omitted: `claude-haiku-4-5` for anthropic, `gpt-5-mini` for openai, `gemini-2.5-flash` for google.
- **Per-provider env var routing** in the CLI: `--llm-provider anthropic` → `ANTHROPIC_API_KEY`, `openai` → `OPENAI_API_KEY`, `google` → `GOOGLE_GENERATIVE_AI_API_KEY`. The error message names the exact missing var.
- **Pricing table refreshed against current provider pricing pages (snapshot 2026-05-16):**
  - **OpenAI:** `gpt-5-nano`, `gpt-5-mini`, `gpt-5`, `gpt-5.1`, `gpt-5.2`, `o3-mini`, `o4-mini`, `o3`. Default `--llm-model` for openai is `gpt-5-mini`.
  - **Google:** `gemini-2.5-flash-lite`, `gemini-2.5-flash`, `gemini-2.5-pro`. Default for google is `gemini-2.5-flash`.
  - **Anthropic (corrects v0.5.0 bugs):** `claude-haiku-4-5` was listed at `$0.80 / $4.00` — actual is **`$1.00 / $5.00`** (v0.5.0 carried the older Haiku 3.5 numbers). `claude-opus-4-7` was listed at `$15.00 / $75.00` — actual is **`$5.00 / $25.00`** (the 4.5 release dropped Opus pricing 3×; v0.5.0 carried the Opus 4.1 numbers). Now also lists `-sonnet-4-6`, `-opus-4-5`, `-opus-4-6`, `-opus-4-1` so callers pinning any 4.x model get accurate cost estimates.
  - **Cost impact for v0.5.0 users:** `--llm-budget-usd` enforcement on `claude-haiku-4-5` was ~20% under-estimating actual spend; on `claude-opus-4-7` was ~3× over-estimating (your budget triggered earlier than it should have). Both fixed.
  - Newer / unlisted models still fall back to cost=0 with a logger warning — `--llm-budget-usd` won't trigger for unpriced models.
- **CLI JSON report** `layer2.provider` field added.
- **CLI human report** Layer-2 line now shows `<provider>/<model>` instead of just `<model>`.
- **2 new cache tests** in `benchmark/cache.test.ts` covering provider-discrimination in the cache key + back-compat default to `anthropic` when provider is omitted (preserves v0.5.0 cache entries on upgrade).
- **5 new CLI tests** in `cli/run-stack.test.ts` covering `--help` listing all three providers + env-var names, invalid `--llm-provider` rejection, per-provider env-var routing, and the default-provider-is-anthropic back-compat case.

### Changed
- **`tsLanguageServiceFixer.ts`** internal loop now emits a `LayerEvent` per fixable error attempt when `onLayerEvent` is provided to `LSPFixerOptions`. Loop control unchanged; if the callback is undefined the only cost is one optional-chaining check per fix.
- **`runMendLoop.ts`** emits per-iteration Layer-2 events and per-stub Layer-4 events when `onLayerEvent` is provided. New internal helpers `parseTsCode("TS2304") → 2304` and `dominantErrorCode(diags) → 2304` for event payload assembly.
- **`LLMCall` type** input gains optional `provider?: LLMProvider`. Optional so v0.5.0 callers' `LLMCall` injections still type-check (their callbacks just ignore the new field).
- **Cache key** at `benchmark/cache.ts` now includes provider: `sha256(systemBlock + " " + userBlock + " " + provider + " " + model)`. Provider defaults to `"anthropic"` when not passed → v0.5.0 cache entries remain valid for unchanged anthropic prompts.
- **`scripts/build.mjs`** externalizes `@ai-sdk/openai` and `@ai-sdk/google` (in addition to `@ai-sdk/anthropic` and `ai`). Consumers who never invoke Layer 2 still don't load any AI SDK; consumers who do get whichever provider package they hit.
- **Runtime dependencies added:** `@ai-sdk/openai@^3.0.64`, `@ai-sdk/google@^3.0.75`. Both are loaded lazily — the AI SDK package only loads when its corresponding provider is actually called.

### Note on v0.6.0 npm tarball
The `0.6.0` tarball on the npm registry was published from a stale local checkout that was based on `8921356 (chore: release v0.5.0)` and never fetched the `feat/multi-provider` and `feat/tier-3-onlayerevent` PRs that had already merged to `main`. As a result, npm `0.6.0` contains library-aware error recovery (see [0.6.0] below) but **not** multi-provider or onLayerEvent. v0.6.1 is the first release that combines all three feature sets. We did not unpublish `0.6.0` to avoid leaving an unpublish tombstone in the registry; please upgrade directly to `0.6.1` or later.

## [0.6.0] - 2026-05-19

**Library-aware error recovery.** Layer 2 now auto-detects breaking-change hints for known libraries from your `package.json` and steers the LLM away from tsc's misleading quick-fixes when a library migration is the real cause. Plus a hardened type-context walk (no more crashes on rename cascades or branded types) and a meaningful set of security anti-patterns in the system prompt.

### Added (library-migration hints)
- **`detectLibraryMigrations(workspaceRoot, registry?)`** — reads `package.json`, matches installed deps against a built-in registry of known breaking changes, returns matching hints. Auto-invoked by `runMendLoop` when `context.libraryMigrations` is left `undefined`. Pass `[]` explicitly to opt out.
- **`BUILT_IN_LIBRARY_MIGRATIONS` registry** — initial entries cover `vite-plugin-svgr` (v4 — `?react` query suffix), `next` (15 — `params`/`searchParams` are Promises), `ai` (v3 / v6), `drizzle-orm` (parameterized template literals).
- **`formatLibraryMigrationsBlock(hints)`** + **`formatLibraryMigrationsTaskDescription(hints)`** — public formatters. The latter produces the `taskDescription` headline (`Library migration: <names>`) that overrides any caller-supplied description when migrations apply — empirically, models follow tsc's quick-fix when the migration is mentioned only in a buried section.
- **CLI `--no-library-hints`** — opt-out flag. Default behavior auto-detects and injects hints. When a migration matches AND `--llm` is set, the CLI also skips Layer 0/1 (tsc's quick-fix is the misleading path for these cases).
- **`MendContext.libraryMigrations?: Array<{ name: string; hint: string }>`** — new optional field. `undefined` = auto-detect; `[]` = opt out; populated array = override (skip detection).

### Added (system-prompt security anti-patterns)
- **Type-assertion escape-hatches** — explicitly forbids `as keyof T` for runtime-string TS7053 silencing, `x as any` / `x as unknown as T` to dodge a real mismatch, `!` non-null assertions to dodge TS18047/TS2532. The prompt directs the model to narrow at the function signature, widen with an index signature, or guard with `if (key in obj)` instead.
- **Dependency removal/substitution** — restoring a missing import is preferred to substituting a different library (e.g. `bcrypt` → `crypto.subtle.digest` is flagged as a security regression even when tsc accepts it).
- **SQL / NoSQL / shell injection** — forbids string concatenation of user-controlled values into raw query strings; directs the model to Drizzle's tagged template, Prisma / mysql2 placeholders, etc.
- **React XSS** — forbids `dangerouslySetInnerHTML` as a way to dodge a children-type error; recommends auto-escaping JSX or DOMPurify.

### Added (union-cleanup positive guidance)
- When a type variant or interface property has been removed/renamed, the prompt now directs the model to do a FULL sweep in the same patch instead of partial cleanup. Specific TS2322 / TS2353 / TS2367 guidance: drop the excess property, drop now-orphaned function parameters with their use sites, replace the no-longer-valid comparison or delete it with its branch. Aimed at the "I changed one reference and left three more" failure mode that produces fresh errors on iteration 2.

### Added (tests)
- 14 unit tests in `libraryMigrations.test.ts` covering empty / matching / minMajor / maxMajor / multi-dep / malformed-package.json / custom-registry / formatter shapes / headline generation.
- 4 tests in `mendAgent.test.ts` for `buildSystemBlock`'s library-migration integration (block present, taskDescription override, empty array, custom description preserved without migrations).
- 2 tests in `runMendLoop.test.ts` for auto-detect (populates from package.json when omitted; opts out on explicit `[]`).
- 1 regression test in `typeContext.test.ts` — "does not throw on multi-file rename-cascade (TS2305: unresolvable named import)" with 4 importers.
- Total: **130/130 tests pass.**

### Fixed
- **`getTypeContext` no longer crashes on multi-file rename cascades or branded types.** `typeContext.ts:tryResolve` now wraps `checker.getTypeAtLocation(n)` and the subsequent `getSymbol()` / `aliasSymbol` / `getDeclarations()` chain in try/catch — TypeScript's internals throw `Cannot read properties of undefined (reading 'kind' / 'flags')` from `isDeclarationNameOrImportPropertyName` on these shapes; tsfix treats those as "no resolvable type" and continues. Belt-and-suspenders try/catch added in `mendAgent.ts` around the per-diagnostic context build — if one diagnostic's context fails for any reason, that diagnostic is skipped instead of killing the whole mend (one bad diag should not lose the LLM's chance to fix the other errors in the file).

### Bench results
Re-measured against the 34-fixture corpus (24 single-file + 10 multi-file) at n=3 per cell:

| Surface | v0.5.0 | v0.6.0 | Δ |
|---|---|---|---|
| Single-file pass rate | 95.8% | **98.6%** | +2.8pp |
| Multi-file pass rate | 23.3% | **40.0%** | +16.7pp |
| Aggregate (102 cells) | 74.5% | **81.4%** | +6.9pp |
| Hard crashes | 6 cells | **0** | -6 |
| Cost per full bench | — | **$0.21** | — |
| Cost per case (haiku-4-5) | — | **<$0.005** | — |

Per-fixture flips notable enough to call out:

- **`case-ts2614-vite-svgr` (0/3 → 3/3)** — vite-plugin-svgr v4's `?react` query suffix migration. Before: model followed tsc's quick-fix and emitted `import Logo from "./logo.svg"` (type-checks under the `*.svg` ambient, breaks at runtime under vite). After: with the registry hint, the model emits `import Logo from "./logo.svg?react"` and the resulting code works in both tsc and the dev server.
- **`case-m7-index-signature-removed` (0/3 → 3/3)** — anti-pattern prompts ended the `as keyof T` escape-hatch loop.
- **`case-m3-union-variant-removed` (2/3 → 3/3)** + **`case-m6-hook-tuple-arity` (2/3 → 3/3)** — union-cleanup guidance fixed the partial-sweep failure mode.
- **`case-m1` + `case-m10`** — previously errored with the `typeContext` crash; now produce measurable results.

Caveats: n=3 per cell is noisy at the per-case level (a single-cell flip from 2→3 may revert); aggregate column totals at 24+ cases are the trustworthy signal. Multi-file scenarios remain the gap — Layer 3 (multi-file mend) is the deferred answer.

### Changed
- **`runMendLoop`** auto-populates `context.libraryMigrations` from `rawContext.workspaceRoot`'s `package.json` when the caller leaves it `undefined`. Existing callers that omit the field get the new behavior automatically; existing callers that pass a non-empty array see no change.
- **`buildSystemBlock`** leads the prompt body with the library-migrations section when any apply, and uses the migration headline as the `taskDescription` (overrides any caller-supplied description). The library section lives between `SYSTEM_INSTRUCTIONS` and the errored-file content — earliest position where the model still sees it before reaching the file.
- **CLI** — when a library migration matches AND `--llm` is set, Layer 0/1 is skipped (tsc's quick-fix is the misleading path for these cases). Existing zero-LLM CLI behavior unchanged.

### Engines
- Node `>=20.9.0` (unchanged)
- TypeScript `>=5.0.0` peer (unchanged)

## [0.5.0] - 2026-05-16

**Layer 4 (stub-and-continue), Day 2/3 fixture mutators, parallel + cached Layer-2 benchmark, and CLI exposure of Layer 2.** This closes the "tsfix never leaves the workspace worse than it found it" property: when Layer 2 can't resolve the last few errors, the workspace can opt-in to `@ts-expect-error` directives that self-destruct once the underlying issue is fixed elsewhere. The CLI now exposes `--llm` end-to-end (was library-API only).

### Added (Layer 4 — stub-and-continue escape hatch)
- **`stubAndContinue(opts)`** — new public API. Inserts `// @ts-expect-error - tsfix: <codes> — <message>` immediately above each unresolved error site so `tsc --noEmit` exits 0. Closes the "tsfix never leaves the workspace worse than it found it" property. Uses `@ts-expect-error` (not `@ts-ignore`) so directives self-destruct once the underlying issue is fixed by other means.
- **`runMendLoop` opt-in flag** — new `stubOnFailure?: boolean` option (default `false`). When the LLM loop terminates with leftover errors and the flag is set, Layer 4 runs automatically. New `"stubbed"` stop reason; new `stubs?: AppliedStub[]` result field with what was applied.
- **Idempotency** — re-running `stubAndContinue` on an already-stubbed workspace is a no-op. Detects existing `@ts-expect-error` / `@ts-ignore` directives on the line above and skips.
- **Safe skips** — `node_modules/`, `.d.ts` files, missing files, and lines beyond file length are recorded as `skipped` (with reason) rather than crashing.
- **Multi-error coalescing** — multiple diagnostics on the same line collapse into one stub comment listing all TS codes and joined messages.
- **Indent + CRLF preservation** — comment matches the indentation of the line it's stubbing; CRLF line endings on Windows-authored files survive the rewrite.
- **`dryRun`** support — same semantics as Layer 2: reports `stubsApplied` without writing.

### Added (fixture engine — Day 2/3 mutators)
- **5 new ts-morph mutators** covering codes the original 3-mutator set didn't reach:
  - `ts2322-incompatible-return.mjs` — replaces a return expression with a wrong-typed primitive literal in a function with a primitive return type
  - `ts2304-cannot-find-name.mjs` — renames a value-position identifier (variable, call, parameter usage) to a no-near-match string; Layer 0's auto-import abstains because there's no candidate
  - `ts2345-arg-type-mismatch.mjs` — replaces a function-call argument with a wrong-typed primitive when the parameter's declared type is `string` / `number` / `boolean`
  - `ts2554-arg-count-mismatch.mjs` — drops the trailing argument from a call that currently satisfies its signature
  - `ts2365-operator-mismatch.mjs` — replaces one operand of a numeric binary expression (`<`, `>`, `<=`, `>=`, `-`, `*`, `/`, `%`) with a string literal
- **50 new generated fixtures** (10 per new code × 8 codes total). Total Layer-2 fixture corpus: **85** (was 35) — 3 minimal + 2 realistic + 80 generated across 8 codes. Total fixture count across all layers: **99** (14 Layer-0 + 85 Layer-2).

### Added (tests)
- **19 new Layer-4 unit tests** — 16 in `stubAndContinue.test.ts` + 3 in `runMendLoop.test.ts` covering single error, multi-error-same-line, multi-code, indent preservation, descending-order processing, idempotency, node_modules skip, .d.ts skip, missing-file skip, dry-run, message truncation, CRLF preservation, first-line edge case, no-eligible case, warning/suggestion filtering, and the runMendLoop integration (stopReason flip, default-off behavior, dryRun interaction).

### Changed
- **Public surface** at `src/index.ts` extended with `stubAndContinue`, `StubAndContinueOptions`, `StubAndContinueResult`, `AppliedStub`, `SkippedStub`. Layer 0/1/2 surface unchanged.
- **`RunMendLoopOptions`** gains `stubOnFailure?: boolean`. **`RunMendLoopResult`** gains optional `stubs?: AppliedStub[]`. **`StopReason`** union gains `"stubbed"`. All additive — old callers unaffected.
- **`scripts/generate-fixtures.mjs`** now runs via `tsx` and imports from `src/index.ts` directly instead of `dist/index.js`. Reason: the v0.4.0 dist bundle inlines `@vercel/oidc` (transitive of `ai`), which uses dynamic `require()` patterns that fail under esbuild's ESM output at module-init time. The generator only needs Layer 0/1 entry points, so importing from source bypasses the AI SDK entirely. Side benefit: no `npm run build` prerequisite — `npm run generate-fixtures` works from a fresh clone.
- Removed `pregenerate-fixtures: npm run build` hook from `package.json`.

### Fixed
- **`stubAndContinue` resolves relative paths** against `workspaceRoot`. Diagnostics from `runInProcessTsc` use relative paths; consumers may pass absolute. Both work.

### Added (Layer-2 benchmark — Day 4)
- **Parallelism** — `npm run benchmark:llm` now runs fixtures concurrently via an inline `pLimit(N)` semaphore (no new dep). Default concurrency is 8; configurable via `--concurrency=N`. 100 fixtures at ~1.5s/each: sequential ~2 min → parallel ~20s. Per-fixture workspaces are isolated (snapshot/restore is local) so parallelism is safe; tsfix's program cache thrashes harmlessly between fixtures.
- **File-based response cache** — every LLM call is keyed by `sha256(systemBlock + userBlock + model)` and stored under `.benchmark-cache/<hash>.json`. Re-runs against unchanged fixtures replay cached responses for free. Any change to the system prompt template, fixture content, or model invalidates automatically (it's all in the hash). `--no-cache` bypasses; `--clear-cache` wipes and exits. `.benchmark-cache/` added to `.gitignore`.
- **Cache module** — extracted to `benchmark/cache.ts` so the logic is unit-testable independent of the full benchmark. 16 new unit tests covering: deterministic keying, key sensitivity per input, hex format, separator-confusion resistance, round-trip read/write, corrupted-entry handling, miss → store → hit cycle, parameter discrimination, bypass behavior, apiKey NOT in the cache key (rotating keys doesn't invalidate), error propagation without poisoning the cache.
- **Failure reporting** — when fixtures fail, the per-iteration LLM raw response dump is collected and printed in a single block at the end of the run (instead of inline during the loop, which would interleave under concurrency).
- **Layer-2 fixture filter (LLM benchmark)** — the LLM benchmark now filters fixtures by `expected.json` shape (`costUsdMax` or `expectedErrorCode`), mirroring the Layer-0 benchmark's filter. Prevents accidentally running Layer-0 fixtures through the LLM.
- **`benchmark/run-llm-benchmark.ts` rewritten** around the parallel + cached worker model. Per-fixture output gets a `[n/m]` progress prefix and prints in completion order; final summary sorted by name for deterministic output. Total wall time, total cost (cache misses only — hits are free), and cache hit rate are reported at the end.

### Added (CLI — Layer 2 exposure)
- **`--llm` flag** — opt-in escalation to Layer 2 (single-file LLM mend) for errors that survive Layer 0/1. Off by default; CLI default path remains zero-network.
- **`--llm-model <name>`** — Anthropic model (default `claude-haiku-4-5`). Known-priced models hardcoded for cost estimation: `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-opus-4-7`. Unknown models warn and report cost as 0.
- **`--llm-max-iterations <N>`** — cap on LLM retries (default 3).
- **`--llm-budget-usd <amount>`** — soft cost cap. If exceeded, exits with code 3 (Layer 2 still ran; partial work persisted to disk).
- **Exit code 3** added — Layer 2 budget exceeded.
- **Validation:** `--llm` without `ANTHROPIC_API_KEY` → exit 2 with helpful error. `--llm + --dry-run` is rejected as mutually exclusive (Layer 2 writes patches to disk).
- **JSON report extension** — `layer2: { ran, stopReason, errorsBefore, errorsAfter, iterations, totalInputTokens, totalOutputTokens, totalCostUsd, budgetExceeded, model } | null`. Layer 0/1 surface unchanged.
- **Human report extension** — new "Layer 2 (LLM)" line in the per-run summary when `--llm` was used. Shows error count delta, iteration count, tokens, cost, and stopReason.
- **13 new CLI integration tests** in `cli/run-stack.test.ts` covering argument validation, exit codes, no-key errors, mutual-exclusion checks, JSON report shape, and the no-Layer-2-when-Layer-0-clean path. Tests spawn the actual `tsx cli/run-stack.ts` process — catches integration issues that pure unit tests of `parseArgs` would miss.

### Fixed (latent v0.4.0 bundle bug)
- **Externalized `ai` and `@ai-sdk/anthropic`** from the esbuild bundle in `scripts/build.mjs`. v0.4.0 inlined them, which (1) bloated `dist/index.js` from ~25 KB to 1.3 MB, and (2) crashed under plain `node` execution at module-init time because `@vercel/oidc` (transitive) uses dynamic `require()` patterns that fail in ESM bundles. Both packages are declared in `dependencies` so npm install pulls them in automatically for consumers using Layer 2. **Bundle sizes after fix:** `dist/index.js` 1.3 MB → 36 KB; `dist/cli.js` ~22 KB → 45 KB. Library import via plain `node` now works (verified with `node -e 'import("./dist/index.js")'`).

### Deferred (fixture engine)
- **TS2532** (Object is possibly undefined) — seeds don't currently contain optional chains or `Map.get()`-style calls that would produce TS2532 deterministically. Mutator deferred until seeds expand or a real-failure capture provides better candidates.
- **TS2551-negative** (LSP returns multiple equally-close fix candidates → abstains) — engineering a deterministic TS2551 case where Layer 0's `fixesAreEquivalent` check abstains is contrived. Defer until we see a real-world example.

### Also changed (CLI)
- **CLI public surface** at `cli/run-stack.ts` extended with the Layer 2 flags listed above. The bin entry (`dist/cli.js`) now imports `runMendLoop`, `runInProcessTsc` and the contract types from `src/index.ts` in addition to the previous `runValidationLoop` + `discoverTsFiles`. Tree-shaking keeps Layer 2 out of the bundle's code path unless `--llm` is set.

## [0.4.0] - 2026-05-14

**Layer 2 LLM mend is now in-package.** The previously-planned sister package `@shipispec/tsmend` has been folded into `tsfix` so the deterministic Layer 0/1 stack and the LLM-driven Layer 2 stack ship as one. This reverses the v0.3.0 sister-package decision (D3) — see roadmap update.

### Added (Layer 2 — single-file LLM mend)
- **`getTypeContext(opts)`** — TS Language Service helper. Resolves an error site to its declaring type via `getTypeAtLocation()` + `getDeclarations()`, slices ±3 lines around the error site and ±20 lines around the declaration. Bounded walk-up (4 hops) plus a special case for `PropertyAccessExpression` so TS2339 errors resolve to the *receiver's* type, not the non-existent property's. The architectural moat — no other OSS tool does this for TypeScript specifically.
- **`mendSingleFile(opts)`** — single-LLM repair via Vercel AI SDK + `@ai-sdk/anthropic`. Uses top-level `system:` parameter (v6 pattern), markdown-headered file delimiters in the prompt (XML wrappers caused Claude to mirror them in output and break the parser). Returns `rawResponse`, parsed `blocks`, `apply` result, token counts, latency.
- **`applySingleBlock(content, search, replace)`** + **`applyEditBlocks(opts)`** + **`parseEditBlocks(text)`** — Aider-style `editblock` parser and 3-tier fuzzy applier (exact → rstrip → strip). Defensive parser handles `<file path="…">` wrappers Claude emits when the system prompt uses XML markers. Abstains on ambiguous matches (multiple hits) rather than guess.
- **`runMendLoop(opts)`** — bounded retry (default 3 iterations) with no-progress / regression detection via error-signature-set comparison. Streams per-iteration data: `patchesApplied`, `patchesFailed`, `inputTokens`, `outputTokens`, `latencyMs`, `rawResponse`. Stop reasons: `noErrors`, `fixed`, `noProgress`, `regressed`, `maxIterations`.

### Added (fixtures + harness)
- **3 hand-authored minimal Layer-2 fixtures** — `mend-ts2339-property-typo`, `mend-ts7006-implicit-any`, `mend-ts2741-missing-prop`.
- **2 realistic Layer-2 fixtures** — `realistic-multi-error-user-helpers` (3 errors, 1 file, `taskDescription` populated), `realistic-rename-ripple` (2 errors, 2 files).
- **30 auto-generated fixtures** via `scripts/generate-fixtures.mjs` (ts-morph AST mutators × 3 codes × 3 seeds × 10 each). Total Layer-2 fixture corpus: **35**.
- **`benchmark/run-llm-benchmark.ts`** (`npm run benchmark:llm`) — Layer 2 live LLM benchmark against Anthropic. Skips silently with exit 0 when `ANTHROPIC_API_KEY` is unset.
- **`scripts/generate-fixtures.mjs`** (`npm run generate-fixtures`) — ts-morph AST mutators that introduce one targeted error per fixture into a valid seed file. Validation gate: every mutation runs through `runInProcessTsc` to confirm the expected error code, then through `runValidationLoop` to confirm Layer 0 abstains. Memory-bounded shared `Project` + tempDir + cache resets to prevent OOMs.

### Added (tests)
- **33 unit tests** across `typeContext`, `applyEditBlock`, `mendAgent`, `runMendLoop`. Mocked LLM call via injectable `_callLLM` — tests never hit the real API.

### Added (CI)
- Workflow gains a Layer-2 benchmark step gated on `ANTHROPIC_API_KEY` (skips cleanly when unset). Existing Layer-0 benchmark + matrix steps unchanged.
- Bumped `actions/checkout` + `actions/setup-node` v4 → v5.

### Changed
- **Dependencies added (runtime):** `@ai-sdk/anthropic@^3.0.44`, `ai@^6.0.86`. Previous "near-zero deps" north star (Layer 0/1 only) is superseded — package now spans Layer 0/1/2.
- **Dependencies added (dev):** `ts-morph@^28.0.0` (fixture generation).
- **Public-API surface** at `src/index.ts` extended with the Layer-2 exports listed above. Layer 0/1 surface unchanged — `runValidationLoop`, `runInProcessTsc`, `runLSPFixerPass`, `discoverTsFiles`, and the contract types stay byte-identical.
- **Roadmap decision D3 reversed** — previous decision was "mend in sister package"; current decision is "mend in-package." Updated in `tsc-defense-roadmap.md`.

### Engines
- Node `>=20.9.0` (unchanged)
- TypeScript `>=5.0.0` peer (unchanged)

### Performance signals (Layer 2, 35-fixture run, claude-haiku-4-5)

| Metric | Target | Observed |
|---|---|---|
| Pass rate | ≥70% (Haiku floor) | **100%** (35/35) |
| Iter-1 success | ≥40% | **97%** (34/35) |
| Cost / fixture | ≤$0.005 | **$0.001 avg** |
| Latency / fixture | P95 ≤25s | ~1.5s |

Caveat: 30 of 35 fixtures are single-error mutations of 3 seeds. Real-world diversity will dent these numbers.

## [0.3.0] - 2026-05-07

Phase 2 contract release. **Establishes the public types `MendContext`, `LayerEvent`, and `Diagnostic` so a downstream LLM-mend package (e.g. `@shipispec/tsmend`) can consume tsfix's output without redefining the shape.** No behavior changes; purely additive types. Also collapses several dev-only improvements that landed since v0.2.0 into a single release.

### Added
- **`MendContext` interface** — public type defining the input contract for a Layer 2–4 LLM-mend agent. Required fields: `workspaceRoot`, `diagnostics`, `erroredFiles`. Optional fields: `taskDescription`, `featureSpecText`, `acceptanceCriteria`, `siblingTasks`, `priorTaskExports`, `installedTypes`.
- **`LayerEvent` interface** — per-layer event shape for streaming telemetry. Designed for an `onLayerEvent` callback in a future minor release; the type is published now so downstream callers can construct events themselves.
- **`Diagnostic` type alias** — public re-export of `InProcessTscResult["diagnostics"][number]`. Convenience for consumers building `MendContext`.
- **Project-shape matrix** (`scripts/run-matrix.mjs`, `npm run matrix`) — pre-publish gate that builds the local tarball and exercises it cold against 6 distinct project shapes: `monorepo-refs` (project references — pinned as a documented limitation), `next-app` (App Router, `paths` alias, `jsx: preserve`), `plain-ts-bundler` (esnext + bundler), `plain-ts-commonjs` (legacy CJS + ES2015 + node10), `plain-ts-nodenext` (nodenext resolution), `react-vite` (TSX + `jsx: react-jsx`). 6/6 pass. Dev-only — not shipped in the tarball.
- **Capture script** (`scripts/capture-fixture.mjs`, `npm run capture`) — Phase 3b tooling for snapshotting real broken workspaces into `fixtures/real-<name>/`. Awaits first real failure to produce fixtures.
- **GitHub Actions CI** (`.github/workflows/test.yml`) — runs check-types, vitest, benchmark, and the matrix on every PR + main push.

### Changed
- **Repository moved.** `tsc-defense-stack/` was extracted from the `spectoship-meta` monorepo into its own repository at <https://github.com/shipispec/tsfix>. All `repository.url`, `homepage`, `bugs.url` fields point at the new repo. Internal git history pre-2026-05-06 lives in the original monorepo; the CHANGELOG narrates v0.1.0–v0.2.0 in detail.
- **Public README rewritten** for an OSS audience — tagline, before/after, 30-second cold start, four-layer model, library API, trust model, contributing protocol. Previous internal-orientation README preserved at `docs/internal-orientation.md`.

### Engines
- Node `>=20.9.0` (unchanged)
- TypeScript `>=5.0.0` peer (unchanged)

## [0.2.0] - 2026-05-04

Phase 1a complete. **Plain Node consumers can now `import` the package without a TypeScript loader, and `npx @shipispec/tsfix` works cold.** Folds in everything that was queued for v0.1.1 (which was never published — its commit is now part of v0.2.0).

### Added
- **esbuild bundle** in `dist/`. Three artifacts: `dist/index.js` (library, ESM bundle), `dist/cli.js` (CLI, ESM with shebang, executable), `dist/index.d.ts` (public type declarations from `tsc --emitDeclarationOnly`). Per-file `.d.ts` files in `dist/types/` for callers wanting subpath types.
- `npm run build` → `node scripts/build.mjs`. Also runs as `prepublishOnly` so `npm publish` always ships fresh `dist/`.
- **`--dry-run` flag** on the CLI and `dryRun` option on `runValidationLoop` and `runLSPFixerPass`. Runs the full LSP fix loop in memory; reports what *would* be edited; no disk writes. Resolves the documented footgun where pointing tsfix at a fixture irreversibly mutated it. (Audit M-E4.)
- **Trust model section** in README: `tsfix` loads `typescript` from your workspace's `node_modules`. Only run on workspaces you trust. (Audit M-S1.)
- **Troubleshooting section** in README covering the most likely user errors (`ERR_MODULE_NOT_FOUND` for typescript; missing `tsconfig.json`).
- **Dev-vs-consumer guidance** in README. (Audit M-E3.)
- **3 dryRun unit tests** in `src/dryRun.test.ts`.

### Changed
- **Package shape**: `main`/`types`/`exports` now point at `dist/`, not `src/`. `bin.tsfix` points at `dist/cli.js` directly. `files` array ships `dist/` only (no more `src/`, `cli/`, `bin/` in tarball). Tarball: 10 files, 16.8 KB packed.
- **Removed `bin/tsfix.mjs` wrapper** — replaced by the bundled `dist/cli.js`. The wrapper was a Phase 0c bridge that depended on local `tsx`; the bundle drops that dependency.
- **Dropped `./validation` and `./lsp-fixer` subpath exports** — unused; the only consumer (spectoship2 shims) imports from the main entry. Easy to re-add if needed.
- README CLI section rewritten to reflect Phase 0c standalone install (no longer references the old `cd spectoship2 && tsx ../tsc-defense-stack/...` flow).

### Fixed
- **Plain Node `import { runValidationLoop } from "@shipispec/tsfix"` now works.** Was previously blocked by Node 22+ refusing to type-strip `.ts` files in `node_modules` (audit H-E1). Verified end-to-end via `npm install` from tarball + `node use-as-library.mjs`.
- **`npx @shipispec/tsfix --workspace ./project` now works cold.** Was previously blocked by the bin wrapper requiring `tsx` from the package's own `node_modules` (audit M-E2).
- `bin/tsfix.mjs` error message no longer references the old `tsc-defense` name (n/a in 0.2.0 — wrapper deleted entirely; audit M-E1).
- `cli/run-stack.ts` no longer ships with executable permission bits (the bundled `dist/cli.js` does, which is correct since it's the actual entry; audit L-S2).

### Engines
- Node `>=20.9.0` (unchanged)
- TypeScript `>=5.0.0` peer (unchanged; npm 7+ auto-installs)

### Outstanding from audit (deferred)
- L-S1 (npm `--provenance` for supply-chain attestation) — Phase 1b CI publish.

## [0.1.1] - 2026-05-04

Patch release addressing the medium-severity findings from the post-publish audit (`docs/audit-2026-05-04.md`). No API breaks; consumers can upgrade with `npm install @shipispec/tsfix@latest`.

### Added
- **`--dry-run` flag** on the CLI and a corresponding `dryRun` option on `runValidationLoop` and `runLSPFixerPass`. Runs the full LSP fix loop in memory and reports what *would* be edited, but does not write to disk. Resolves the documented footgun where running `tsfix` against a fixture directory irreversibly mutated the broken code. (Audit M-E4.)
- **Trust model section** in README: explicit disclosure that `tsfix` loads `typescript` from the workspace's `node_modules`, with the standard "only run on workspaces you trust" warning. (Audit M-S1.)
- **Dev-vs-consumer guidance** in README: clarifies that `npm scripts` shipped in the published `package.json` (benchmark/test/setup-fixtures) are for contributors only — consumer-side `node_modules/@shipispec/tsfix/` doesn't have `tsx`/`vitest`/`fixtures/`. (Audit M-E3.)

### Fixed
- `bin/tsfix.mjs` error message no longer references the old `tsc-defense` name; now describes the correct `tsfix` flow when `tsx` cannot be resolved. (Audit M-E1.)
- `cli/run-stack.ts` no longer ships with executable permission bits (was `-rwxr-xr-x`, now `-rw-r--r--`). The file is loaded by `tsx`, never run directly. (Audit L-S2.)

### Changed
- README CLI section rewritten to reflect Phase 0c standalone install (no longer references the old monorepo `cd spectoship2 && tsx ../tsc-defense-stack/...` flow).

## [0.1.0] - 2026-05-04

Initial public release. **Layers 0–1 only** (deterministic detection + auto-fix). LLM-driven mend layers stay in `spectoship2/` until v0.2.

### Added
- **`runValidationLoop(opts)`** — full deterministic loop (validate → auto-fix → re-validate). Recommended entry point.
- **`runInProcessTsc(opts)`** — in-process `tsc --noEmit` returning structured diagnostics. No subprocess spawn, no Node 23 startup-pause issue. Workspace lib-path override (uses the workspace's `node_modules/typescript` so globals resolve under esbuild bundling).
- **`runLSPFixerPass(opts)`** — Layer 0 deterministic auto-fixer using `ts.LanguageService.getCodeFixesAtPosition`. Strictly opt-in by error code and fix name:
  - `SAFE_FIXABLE_CODES`: `TS2304`, `TS2305`, `TS2551`, `TS2552`, `TS2724`
  - `SAFE_FIX_NAMES`: `import`, `fixImport`, `spelling`, `fixSpelling`
  - 5-iteration cap with signature-set progress check (stops when the `(file, start, code)` set repeats)
  - Multi-fix equivalence check abstains when candidate fixes produce different edits
- **`discoverTsFiles(workspaceRoot)`** — file-discovery helper. Includes `.ts`/`.tsx`; excludes `.d.ts` and `node_modules`/`.next`/`dist`/`build`/`out`/`coverage`/`.git`.
- **CLI** (`tsfix --workspace <path>`, after `npm link`). Flags: `--json`, `--no-lsp`, `--verbose`, `--files <comma-list>`, `--help`. Exit 0 = clean, 1 = errors remain, 2 = bad args.
- **MIT license**, no runtime deps except peer `typescript >=5.0.0`.

### Known limitations
- **`npx @shipispec/tsfix ./project`** does not work for cold-start. The bin wrapper requires `tsx` to be resolvable from the package's own `node_modules`. Use `npm install @shipispec/tsfix && npm link` for now. Phase 1a (esbuild bundle) addresses this.
- **`export { X } from "./mod"`** — TS LanguageService returns zero code-fixes for typos in this syntactic position. Documented in `fixtures/synthetic-cross-file-typo-ts2305/`.
- **Footgun:** the CLI mutates files in place with no snapshot/restore. Don't point it at the package's own `fixtures/` directories during dev — use `npm run benchmark` instead, which snapshots and restores.

### Engines
- Node `>=20.9.0` (matches VS Code Extension Host runtime)
- TypeScript `>=5.0.0` (peer dep, must be installed in the consuming workspace)

[Unreleased]: https://github.com/shipispec/tsfix/compare/v0.6.2...HEAD
[0.6.2]: https://github.com/shipispec/tsfix/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/shipispec/tsfix/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/shipispec/tsfix/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/shipispec/tsfix/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/shipispec/tsfix/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/shipispec/tsfix/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/shipispec/tsfix/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/shipispec/tsfix/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shipispec/tsfix/releases/tag/v0.1.0
