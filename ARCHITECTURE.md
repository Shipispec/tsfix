# tsfix — Architecture

> Companion to `README.md` (orientation), `docs/internal/STATUS.md` (current state), `.claude/CLAUDE.md` (working principles). Design rationale; last reviewed 2026-05-22 (v0.6.1). The package was originally prototyped as "TSC Defense Stack" before being extracted and published as `@shipispec/tsfix` — some history below still uses that name.

This doc explains *why* the package is shaped the way it is. If you only need to use the API, read `README.md`. If you only need to know what's working/broken, read `docs/internal/STATUS.md`. Read this when you're about to add a layer, change the trust model, or wonder why something seems indirect.

---

## 1. The bet

The premise of the entire package fits in one sentence: **automated code generation fails on TypeScript errors more than on anything else, and most of those errors are mechanical enough to fix without an LLM.**

Empirically (from `spectoship2/tests/test{20-28}R/`), ~80% of failed code-generation tasks fail on `tsc --noEmit`. Of those, the dominant codes are TS2304/TS2305/TS2552/TS2724 (find-name / did-you-mean / import-rename) — exactly the codes the TypeScript LanguageService already knows how to fix when you press Quick Fix in VS Code. So the architecture is built around a single observation: **we can borrow the IDE's fix engine and run it headlessly before a human (or LLM) ever sees the error.**

If that bet is right, large parts of the spec-driven pipeline (mend agents, multi-file repair, retries) become rare-path code instead of the default path. If it's wrong, this package is dead weight and we should fold it back into the LLM mend loop.

---

## 2. The four-layer defense model

A TS error has up to four chances to die before reaching a user. Each layer's failure becomes the next layer's input. **Layers 0–1 live in this package. Layers 2–4 live in `spectoship2/`** (for now — see §11).

```
                generated .ts(x) files on disk
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │ -1. PREVENT  │   │  0. DETECT   │   │  1. AUTO-FIX │   in this package
 │ prompt rules │   │ in-process   │   │  Layer 0 LSP │
 │ + gotchas    │   │ tsc          │   │  fixer       │
 └──────────────┘   └──────────────┘   └──────────────┘
        │                   │                   │
        │                   ▼                   ▼
        │             diagnostics         remaining errors
        │                                       │
        └───────────────────┬───────────────────┘
                            ▼
                ┌─────────────────────────┐
                │ 2-4. LLM mend agents    │   in spectoship2/, not yet
                │   architect+editor      │   exported here (v0.2)
                │   multi-file/blast      │
                │   stub-and-continue     │
                └─────────────────────────┘
```

**Layer -1 (prevention)** — package gotchas, installed-exports injection, prior-task-exports injection, code-gen prompt rules. Lives in `spectoship2/src/pipeline/{packageGotchas,installedExports,priorExports,codeGenPrompts}.ts`. Not in this package. Its job: stop the error from being generated in the first place. Free; no detection cost.

**Layer 0 (detection)** — `runInProcessTsc` in `src/validatorInProcess.ts`. Single-pass `tsc --noEmit` running in-process (no subprocess, no Node 23 startup-pause bug). Returns structured diagnostics. The bottom of every pipeline that wants to know "is this code valid TS?"

**Layer 1 (deterministic auto-fix)** — `runLSPFixerPass` in `src/tsLanguageServiceFixer.ts`. Uses `ts.LanguageService.getCodeFixesAtPosition` — the same engine VS Code Quick Fix uses. Strictly opt-in by error code (`SAFE_FIXABLE_CODES`) and fix name (`SAFE_FIX_NAMES`). Free, deterministic, ~ms per fix. **This is the layer doing the most work in the bet**: every error class we can resolve here costs no LLM tokens and produces no probabilistic regressions.

**Layers 2–4 (LLM mend)** — `mendAgent` (single-file), `mendArchitect` (architect+editor split for harder single-file cases), `multiFileMend` (blast-radius search-and-replace), `repairAgent` (skipped-task recovery). All currently in `spectoship2/src/pipeline/`. Will move into this package as v0.2 once their `ParsedTask` dependency is redesigned as an opaque interface.

---

## 3. System boundaries

### What's inside the package

```
@shipispec/tsfix
├─ src/
│  ├─ index.ts                       — public API, runValidationLoop
│  ├─ validatorInProcess.ts          — Layer 0: in-process tsc
│  └─ tsLanguageServiceFixer.ts      — Layer 1: LSP auto-fix
├─ cli/run-stack.ts                  — CLI wrapper around runValidationLoop
├─ benchmark/run-benchmark.ts        — fixture harness
└─ fixtures/                          — synthetic broken workspaces
```

The package depends only on `typescript` (peer + runtime) and `tsx` (dev only). No bundlers, no AST libraries, no LLM SDKs. **This is a deliberate constraint.** The defense stack runs inside the VS Code Extension Host, where every transitive dep is bundle weight and every native module is a "does it work in the runtime" risk. The whole package is < 1000 LOC of TypeScript today.

### What's outside

- LLM mend (lives in `spectoship2/`, see §11)
- Spec parsing, planning, decomposition (spec pipeline)
- Cost / token budgeting, model routing, BYOK provider management
- ESLint, Vitest, Playwright, build-step validation (those have their own infra)
- Webview, VS Code commands, status UI

### What depends on us

- `spectoship2/src/pipeline/validatorInProcess.ts` and `…/tsLanguageServiceFixer.ts` are now thin re-export shims pointing at `@shipispec/tsfix`. The validator pipeline calls those re-exports.
- The CLI and benchmark in this package — both load the public API directly.

---

## 4. Data model

### Diagnostic
What the validator returns to callers (the public `InProcessTscResult.diagnostics` shape):

```ts
{
  file: string;        // absolute path
  line: number;        // 1-based
  column: number;      // 1-based
  code: string;        // formatted as "TS<n>" (e.g. "TS2304")
  category: "error" | "warning" | "suggestion" | "message";
  message: string;     // flattened message text
}
```

`code` is stringified up-front to match `tsc`'s on-screen format and to keep the JSON output stable across TS versions. The LSP fixer doesn't read this serialized shape — it reaches into the raw `ts.Diagnostic` (which has numeric `.code`, `.start`, `.length`) inside `collectFixableErrors`. So the two layers see the same errors through different lenses: callers get a stable structured form, the fixer gets the raw character offsets it needs for `getCodeFixesAtPosition`.

### Fix
What `ts.LanguageService.getCodeFixesAtPosition` returns. Shape (subset of TS's `CodeFixAction`):

```ts
{
  fixName: string;                   // e.g. "import", "spelling"
  description: string;               // human-readable
  changes: Array<{
    fileName: string;                // absolute path
    textChanges: Array<{
      span: { start: number; length: number };
      newText: string;
    }>;
  }>;
}
```

A single fix can edit multiple files (e.g. an auto-import touches both the importer and, theoretically, the source — though in practice it's just the importer). A single error position can return multiple alternative fixes.

### Snapshot
The fixer's in-memory mirror of disk. `Map<absolutePath, { content: string; version: number }>`. Two reasons it exists:
1. We need to apply edits *between* iterations without writing intermediate states to disk (cheaper, atomic, no half-fixed file visible to other tools)
2. The TS LanguageService caches by `getScriptVersion()`. Bumping the version after each edit is what tells the LSP to re-parse / re-check.

The snapshot is the **source of truth for the duration of a fixer pass.** Disk is read once at the start (when seeding), written once at the end (persist loop). The host's `readFile` is overridden to serve from snapshots.

### Signature
A `(file, start, code)` tuple, used by the iteration loop to detect "stuck" cycles. Not externally visible; lives in `tsLanguageServiceFixer.ts`.

---

## 5. Control flow — the validation loop

`runValidationLoop` is the recommended entry point. Its body is intentionally short:

```
1. resetInProcessTscCache()
2. before = runInProcessTsc(...)
3. if before has errors AND !skipLSPFixer:
       lsp = runLSPFixerPass(...)   ← in-place edits
       if lsp.fixesApplied > 0:
           resetInProcessTscCache()
           after = runInProcessTsc(...)
4. return aggregated result
```

The cache reset between passes matters: in-process tsc memoizes the `Program` by `(workspaceRoot, generatedFiles-hash, mtime)`. Without the reset, the second `runInProcessTsc` call would return stale diagnostics from before the LSP fixer's edits.

### Inside `runLSPFixerPass`

The hot loop (`tsLanguageServiceFixer.ts:194-258`):

```
seed snapshots from disk
create LanguageService once
let lastErrorSignatures = ∅
for iter in 1..maxIterations:
    fixableErrors = collectFixableErrors()      ← getSemanticDiagnostics ∩ SAFE_FIXABLE_CODES
    if fixableErrors == ∅: break
    if signatures(fixableErrors) == lastErrorSignatures:
        break  ← stuck, same set as last time
    lastErrorSignatures = signatures(fixableErrors)
    for err in fixableErrors:
        fixes = getCodeFixesAtPosition(err)
        safeFixes = fixes ∩ SAFE_FIX_NAMES
        if safeFixes == ∅: continue
        if |safeFixes| > 1 AND not equivalent: continue   ← ambiguous
        applyFixToSnapshots(safeFixes[0])         ← bumps snapshot version
    if no fixes applied this iter: break
persist edited snapshots to disk
return result
```

Two non-obvious invariants:

**Why iterate?** A single edit can unmask new errors that were previously hidden. The canonical case: `import { Greater }` is undefined → `g: Greater` makes `g` typed as `any` → `g.greetNam(...)` is invisible because `any.greetNam` is fine. Fix the import → `g` becomes `Greeter` → the method-name typo finally surfaces. The fixture `synthetic-multifile-ripple` is exactly this. Without iteration, Layer 0 only catches the leaf errors; with it, Layer 0 walks the cascade.

**Why a *signature-set* progress check, not a count?** A fix can convert a TS2724 at position A into a TS2552 at position B (different code, different position, same count). If we used count, we'd bail thinking we're stuck. Signature set says "the *set of unfixed errors* changed, so something happened." A genuine stuck loop has the *same* errors at the *same* positions across iterations — that's what we cap on.

The iteration cap of 5 is a safety net against runaway loops in unforeseen failure modes; the signature check almost always terminates first.

---

## 6. The host abstraction

`runLSPFixerPass` builds a custom `ts.LanguageServiceHost` rather than letting TS read directly from disk. Two pieces matter:

```ts
getScriptVersion: (fileName) => String(snapshots.get(fileName)?.version ?? 0)
getScriptSnapshot: (fileName) => {
    const cached = snapshots.get(fileName);
    if (cached) return ts.ScriptSnapshot.fromString(cached.content);
    // fall through to disk for files we haven't snapshotted (libs, deps)
}
```

TypeScript's LanguageService keys its caches on `(fileName, version)`. Bumping the version after every edit is what tells the LSP "re-parse this." Forget the bump and the LSP will keep returning diagnostics against the old content — the symptom is "applied a fix, error still appears."

The host also overrides `getDefaultLibFilePath` to use the workspace's installed `typescript`, not the bundled one. The reason is non-obvious: when esbuild bundles this package into `dist/extension.js` for the VS Code Extension Host, `ts.getDefaultLibFilePath()` resolves to a path inside the bundle that doesn't actually contain `lib.*.d.ts` files. We override with the workspace's `node_modules/typescript/lib/` so the LSP can find globals like `console`, `Promise`, `Array`. (This bug is the entire reason the recent `tests/test{20-28}R/` runs went from "always failing" to "always clean.")

---

## 7. Trust boundaries

The package's safety story rests on a small allowlist:

| Allowlist | What we trust |
|---|---|
| `SAFE_FIXABLE_CODES` | These error codes have unambiguous fixes that don't change semantic intent |
| `SAFE_FIX_NAMES` | These fix names operate on existing code rather than introducing stubs / inferred types |
| Multi-fix equivalence check | If TS returns multiple safe fixes for one error, they must produce identical text. Otherwise it's genuine ambiguity (e.g. import from package A vs package B) and we abstain. |

**What we do NOT trust:**
- `fixMissingFunctionDeclaration` — declares a function stub, changing structure
- `inferAny` — guesses param types, frequently wrong (synthetic-implicit-any-ts7006 documents this)
- `addMissingPropertyAndOptional` — picks a placeholder value for a missing required prop
- Any fix for codes outside the safe set, even if the fix name is in `SAFE_FIX_NAMES`

The trust boundary is **deliberately narrow**. Adding to either set is a one-line change but requires:
1. A probe (mini script using `ts.createLanguageService` to dump candidate fixes for the error class)
2. A new fixture that pins down the boundary
3. Confirmation that the existing fixtures still pass

This is the loop that found and fixed two real bugs in the LSP fixer (signature-set check, iteration cap) — small allowlist + pinned-down fixtures = changes that are obvious to test.

---

## 8. Extension points

Where to add things, in order of frequency:

**Add a synthetic fixture.** Create `fixtures/<name>/` with `tsconfig.json`, `expected.json`, a `node_modules` symlink to `../_shared/node_modules`, and `lib/*.ts(x)` files. The benchmark auto-discovers it. Use the `expected.json` schema:
```ts
{
  description: string;
  errorsBefore?: number;
  errorsAfterMax?: number;
  lspFixesAppliedMin?: number;
  lspFixesAppliedMax?: number;
  mustPass: boolean;
  expectedFixerCodes?: string[];   // informational
}
```

**Add a TS code to `SAFE_FIXABLE_CODES`.** Probe candidate fixes first; confirm the returned `fixName` is already in `SAFE_FIX_NAMES`; add a fixture documenting the behavior; flip an existing negative-test fixture to positive if the new code makes it auto-fixable. (TS2551 was added this way in 2026-05-03.)

**Add a fix name to `SAFE_FIX_NAMES`.** Higher risk than adding a code. The fix name is what the TS team uses internally; new TS versions occasionally rename them (`spelling` vs `fixSpelling` is the example we already handle). Adding here means we trust that fix name's edit semantics across the entire `SAFE_FIXABLE_CODES` set, which is a stronger claim. Justify with at least 2 fixtures across different error codes.

**Add a new layer between detection and LSP fix.** Insert in `runValidationLoop` between `runInProcessTsc` and `runLSPFixerPass`. New layer's contract: input is `InProcessTscResult["diagnostics"]`, output is `{ filesEdited: string[], fixesApplied: number }`, mutates files on disk in place. The layer is responsible for invalidating the in-process tsc cache (via `resetInProcessTscCache()`) before downstream layers re-validate.

**Add support for a new file type.** Today the discovery walker matches `.ts` / `.tsx` (excluding `.d.ts`). Adding `.cts` / `.mts` is a one-line change in `discoverTsFiles` (`src/index.ts:107-128`). Note that `.d.ts` files are intentionally excluded from edits because the LSP can return fixes against them and we don't want to mutate generated declaration files.

---

## 9. Performance model

The benchmark's 14 fixtures run end-to-end in ~10 seconds. Where the time goes (measured locally):

| Step | Per-fixture cost | Notes |
|---|---|---|
| `runInProcessTsc` initial | ~600-800ms | Dominated by TS parsing the lib files (`lib.dom.d.ts` etc.). One-time per `Program`. |
| `runLSPFixerPass` setup | ~200ms | Creates a separate LanguageService; loads lib files again |
| `getSemanticDiagnostics` per iter | ~50-200ms | Cached by `(file, version)`; recomputed when snapshot version bumps |
| `getCodeFixesAtPosition` | ~5-50ms per error | Cheap; the LSP already has the program loaded |
| Persist to disk | <5ms total | One `writeFileSync` per edited file |

**The expensive part is loading lib files twice** — once in `runInProcessTsc`, once in `runLSPFixerPass`. They're separate `Program` / `LanguageService` instances that don't share the parsed lib cache. A v0.2 optimization would unify them behind a single `Program` reused across detection and fixing, but that requires refactoring the LSP fixer's host abstraction (it relies on `LanguageServiceHost`, not `CompilerHost`).

**`skipLibCheck: true` is load-bearing.** The fixer's compiler options force it on regardless of the workspace's `tsconfig`. Without it, lib `.d.ts` errors (which exist in many TypeScript versions) would dominate the diagnostic output and burn time on irrelevant checks.

---

## 10. Configuration surface

Two env vars, no config files:

| Env var | Default | Effect |
|---|---|---|
| `SPECTOSHIP_IN_PROCESS_TSC` | `true` | Set to `"false"` to opt out of in-process tsc (fall back to spawning) |
| `SPECTOSHIP_TS_LSP_FIXER` | `true` | Set to `"false"` to opt out of Layer 0 entirely |

Both checked via `is{InProcessTsc,LSPFixer}Enabled()`. Callers (the spec pipeline) consult these before invoking the layer; the layers themselves don't self-skip. This means the package functions ignore the env vars at call sites — they always run when called. Kill switches live one level up.

The CLI's `--no-lsp` flag is a separate path that sets `skipLSPFixer: true` on the loop options. Independent of the env var because CLI users want override-by-flag, not override-by-env.

---

## 11. Integration with the larger SpecToShip pipeline

Today (2026-05-03):

```
spec → tasks → implement (LLM call N)
                    │
                    ▼
        spectoship2/src/pipeline/validator.ts
                    │
                    ├──► validatorInProcess.ts (re-export shim) ──┐
                    │                                              │
                    └──► tsLanguageServiceFixer.ts (re-export) ───┤
                                                                   ▼
                                                   @shipispec/tsfix
                                                   (this package, Layers 0-1)
                    │
                    ▼
            (if errors remain)
                    │
                    ▼
        spectoship2/src/pipeline/{mendAgent, mendArchitect,
                                   multiFileMend, repairAgent}.ts
                    │
                    ▼            (Layers 2-4, NOT in this package yet)
            (if still failing)
                    │
                    ▼
            blockerClassifier.ts → user prompt (Retry / Hint / Skip)
```

The shims exist so `spectoship2/` keeps its old import paths working unchanged. `validator.ts` doesn't know or care that the implementation moved.

**The v0.2 boundary** — when the mend agents move into this package, the shape of their dependency on `ParsedTask` (the spec-pipeline's task representation) needs to be redesigned. Right now `mendAgent` reaches into the spec to read the task's spec text, prior tasks, and acceptance criteria; an extracted version would take an opaque `MendContext` interface that `spectoship2/` populates from `ParsedTask`. The package shouldn't know what a spec is.

---

## 12. Open architecture questions

Things we haven't decided, in rough order of how much they'd change the package:

1. **Should the package own the `ParsedTask` → `MendContext` adapter, or should `spectoship2` provide it?** Tied to the v0.2 mend-layer extraction. Current lean: spectoship2 provides; this package only defines the interface.

2. **Should detection and fixing share a single `Program` instance?** Current architecture creates two (one in-process tsc `Program`, one fixer `LanguageService`) with their own lib-file parses. Unifying would cut ~30% of pass latency but requires picking one of the two host abstractions.

3. **Should the safe set be config-driven instead of code-constant?** The five fixable codes are hard-coded today. A `tscDefenseConfig` field in `package.json` could let downstream projects opt into wider sets (e.g. "yes, fix TS7006 too — I'm doing greenfield"). Current lean: no, because the safety claim depends on testing each code, and config files invite untested combinations.

4. **Should we ship a custom rewriter for `export { X } from "./mod"` (the documented LSP gap)?** Violates "don't re-implement what TypeScript already does," but might be cheap enough that the principle isn't worth holding. Need data on how often LLMs emit broken export-from declarations.

5. **Should the persist-to-disk step be transactional?** Today we write each edited file independently with `writeFileSync`. A power loss mid-pass could leave half-edited workspaces. Probably fine for our threat model (LLM-iteration scratchpads, not production code) but worth flagging if the package is ever used in higher-stakes contexts.

6. **Should the package emit structured per-layer events?** Per `docs/internal/STATUS.md`'s telemetry gap. The shape would be `{layer, errorCode, fixed, latencyMs}`; the open question is delivery — return as part of the result, emit as a Node `EventEmitter`, write to a log file, or all three. Lean toward "return as part of result" for consistency with the current API style.
