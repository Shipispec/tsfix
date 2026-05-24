# tsfix

[![npm version](https://img.shields.io/npm/v/@shipispec/tsfix.svg)](https://www.npmjs.com/package/@shipispec/tsfix)
[![npm downloads](https://img.shields.io/npm/dm/@shipispec/tsfix.svg)](https://www.npmjs.com/package/@shipispec/tsfix)
[![CI](https://img.shields.io/github/actions/workflow/status/owgreen-dev/tsfix/test.yml?branch=main&label=CI)](https://github.com/owgreen-dev/tsfix/actions/workflows/test.yml)
[![license MIT](https://img.shields.io/npm/l/@shipispec/tsfix.svg)](LICENSE)
[![node >= 20.9](https://img.shields.io/node/v/@shipispec/tsfix.svg)](https://nodejs.org/)

> **TypeScript error recovery for LLM-generated code.** When Cursor / Claude Code / Copilot / your spec-to-code agent leaves you with a wall of `tsc --noEmit` errors, tsfix repairs them — **library-aware** mend on the hard ones, deterministic VS Code Quick Fix on the trivial ones. **98.6% pass on a real-world single-file bench at <$0.005 per fix.** MIT, BYOK.

![tsfix demo: broken vite-plugin-svgr import → tsfix --llm → tsc green](docs/demo/demo.gif)

## Why tsfix exists

tsfix is built for the *output of code generators*, not human-written TypeScript. The thing it does that nothing else does: **it knows what tsc's own quick-fix gets wrong about your installed libraries.**

When `vite-plugin-svgr@4` is in your `package.json` and tsc says *"Module '"./logo.svg"' has no exported member 'ReactComponent'. Did you mean `import Logo from "./logo.svg"`?"*, tsc is right about types and wrong about runtime. The default import resolves to the asset URL string under vite, not a component. **tsc is now green. The dev server is now broken.** An LLM dutifully following tsc's quick-fix produces code that type-checks and crashes the page.

tsfix reads your `package.json` on every Layer 2 invocation, matches installed deps against a built-in registry of known breaking changes (vite-plugin-svgr, Next.js 15 async params, Vercel AI SDK v3, Drizzle ORM), and injects the correct migration hint into the LLM prompt's headline. The model then emits `import Logo from "./logo.svg?react"` — tsc green AND the dev server works.

That's the one-sentence pitch. The rest of the package is a careful, layered, cost-aware way to deliver it across every TS error class.

## The layers, opt-in by layer

- **Layer 1 (default, deterministic)** — Auto-fix typos, missing imports, and did-you-mean errors via the same TypeScript Language Service that powers VS Code's "Quick Fix" lightbulb. Zero network, zero LLM cost, zero config. Catches roughly half of LLM-generated TS errors before you ever pay for an LLM call.
- **Layer 2 (opt-in via `--llm`)** — Single-file LLM mend via the Vercel AI SDK. Multi-provider: **Anthropic / OpenAI / Google** (`--llm-provider`). Library-aware (above). Driven by **type-context injection** — when tsc says *"Property 'foo' doesn't exist on type 'Bar'"*, tsfix resolves `Bar`'s declaration via the TypeChecker and feeds its source to the model. That's the architectural moat: every other LLM-driven repair tool uses generic grep or repo-maps.
- **Layer 4 (library-only, opt-in via `runMendLoop({stubOnFailure: true})`)** — Escape hatch. When Layer 2 can't resolve the last few errors, inserts `// @ts-expect-error - tsfix: ...` directives that self-destruct once the underlying issue is fixed elsewhere. tsfix never leaves the workspace worse than it found it.

The default CLI is **Layer 0/1 only** — no network calls, no surprises. Layer 2 only runs when you opt in with `--llm` and have a provider key in your environment.

## Before / after (Layer 0)

```
$ tsc --noEmit
src/api.ts:5:2  - error TS2552: Cannot find name 'consol'. Did you mean 'console'?
src/api.ts:8:5  - error TS2305: Module '"react"' has no exported member 'ueState'.
src/api.ts:12:14 - error TS2551: Property 'lenght' does not exist on type 'string[]'. Did you mean 'length'?

Found 3 errors in 1 file.

$ npx @shipispec/tsfix --workspace .
[ts-lsp-fixer] applied 3 fixes across 1 file

$ tsc --noEmit
$ # 0 errors
```

## 30-second cold start

```bash
cd your-broken-project
npx @shipispec/tsfix --workspace .
```

No config file. Exit code conventions:

| Code | Meaning |
|---|---|
| 0 | Workspace is clean |
| 1 | Errors remain (printed to stderr) |
| 2 | Bad arguments / harness error |

Preview what *would* change without writing to disk:

```bash
npx @shipispec/tsfix --workspace . --dry-run
```

Machine-readable output for piping into other tools:

```bash
npx @shipispec/tsfix --workspace . --json
```

### All flags

**Core (Layer 0/1):**

| Flag | Meaning |
|---|---|
| `--workspace <path>` | Required. Directory containing your `tsconfig.json`. |
| `--dry-run` | Run the fixer in memory, report counts, write nothing. |
| `--no-lsp` | Validate only — skip auto-fix. |
| `--files <a.ts,b.ts>` | Restrict fixing to a comma-separated list. |
| `--json` | Machine-readable output. |
| `--verbose` | Per-fix logging. |
| `--help` | Print usage. |

**Layer 2 (LLM mend — opt-in, sends source to your chosen provider):**

| Flag | Meaning |
|---|---|
| `--llm` | Escalate errors that survive Layer 0/1 to Layer 2. Requires the provider's API key in the environment. |
| `--llm-provider <name>` | `anthropic` (default) \| `openai` \| `google`. Each provider reads its own env var: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`. |
| `--llm-model <name>` | Model name. Defaults per provider: `claude-haiku-4-5` / `gpt-5-mini` / `gemini-2.5-flash`. |
| `--llm-max-iterations <N>` | Cap on LLM retries (default: `3`). Each iteration sends the still-erroring files plus updated diagnostics. |
| `--llm-budget-usd <amount>` | Soft cost cap; exits with code `3` if exceeded. Cost estimates use a per-provider pricing table (snapshot 2026-05-16) — unknown models log a warning and don't trigger the cap. |
| `--no-library-hints` | Disable auto-detection of library breaking-change hints from `package.json`. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Workspace is clean (or Layer 2 cleared all errors). |
| `1` | Errors remain. |
| `2` | Bad arguments / missing API key / `--llm` + `--dry-run` rejected. |
| `3` | Layer 2 budget cap (`--llm-budget-usd`) exceeded. Partial work is persisted to disk. |

### Using in CI

`npx @shipispec/tsfix` prints `npm warn exec The following package was not found and will be installed: @shipispec/tsfix@<version>` on every cold runner. To avoid the warning and skip the install prompt, either install once at workflow start:

```bash
npm install -g @shipispec/tsfix@latest
tsfix --workspace .
```

…or pass `--yes` to npx:

```bash
npx --yes @shipispec/tsfix --workspace .
```

## What Layer 0 fixes

| TS code | Meaning | What tsfix does |
|---|---|---|
| `TS2304` | Cannot find name | Auto-imports |
| `TS2305` | Module has no exported member | Did-you-mean rename |
| `TS2551` | Property does not exist on T, did you mean Y | Spelling fix |
| `TS2552` | Cannot find name, did you mean Y | Spelling fix |
| `TS2724` | Module member did-you-mean | Import rename |

Against a 14-fixture benchmark spanning typos, did-you-mean cases, multi-file ripples, and 4 API-drift scenarios: **14/14 fixtures pass and 14/25 errors are auto-fixed (56%).** The remaining errors are intentionally outside Layer 0's scope and escape to Layer 2.

## What Layer 0 does *not* fix (Layer 2 picks these up)

By design, Layer 0 only applies fixes that are **deterministic** and **non-structural**. It refuses to:

- Add or remove function declarations
- Insert type annotations or change types
- Modify control flow (`await` insertions, async propagation)
- Rewrite JSX trees
- Add object-literal stub properties

The internal allowlist is two-layered: error codes (`SAFE_FIXABLE_CODES`) and Quick Fix names (`SAFE_FIX_NAMES = ['import', 'fixImport', 'spelling', 'fixSpelling']`). When the language service offers anything outside that allowlist, Layer 0 abstains and surfaces the error so Layer 2 (or a human) can pick it up.

Layer 2 is built for the cases the LSP can't statically resolve:

- `TS2339` — Property doesn't exist on type. The LLM needs to see *the type's declaration* to decide whether the receiver should grow a field, the call site has a typo with no near-match, or the receiver is the wrong type entirely.
- `TS7006` — Implicit `any`. The LLM picks the right annotation from surrounding context.
- `TS2741` — Missing required property. The LLM sees the contextual type and supplies a real value, not a placeholder.

tsfix ships two benchmark suites, and it's worth being precise about what each measures:

- **Synthetic suite** (in-package, `npm run benchmark:llm`) — hand-authored minimal cases plus ts-morph-generated single-error mutations of a few seed files. These are *easy* by construction (one isolated error, no cross-file ripple) and Layer 2 passes effectively all of them. Useful as a regression gate, **not** as a real-world accuracy claim.
- **Realistic suite** (34 fixtures drawn from real LLM-repair failures — see the table below) — this is the number to trust. It's where the headline 98.6% / 81.4% figures come from.

If you only read one number, read the realistic suite.

## Library-aware error recovery (v0.6.0+)

A typical TypeScript LLM-repair failure mode: tsc reports `TS2614: Module '"./logo.svg"' has no exported member 'ReactComponent'. Did you mean to use 'import Logo from "./logo.svg"' instead?` The model dutifully follows tsc's quick-fix and emits `import Logo from "./logo.svg"`. **tsc is now green. The dev server is now broken.** Under `vite-plugin-svgr@4`, importing an SVG as a React component requires the `?react` query suffix — `import Logo from "./logo.svg?react"`. The default export is the asset URL, not a component. Quick-fix accuracy ≠ runtime correctness.

tsfix v0.6.0 reads your `package.json` on every Layer 2 invocation, matches installed deps against a built-in registry of known breaking changes, and injects library-migration hints into the system prompt's headline (not buried — headline framing matters more than buried context). With `vite-plugin-svgr@^4` installed:

```
### library-migrations
- vite-plugin-svgr: v4 requires the `?react` query suffix to import an SVG
  as a React component. `import Logo from "./logo.svg"` returns the asset URL.
  `import Logo from "./logo.svg?react"` returns the component.

### task
Library migration: vite-plugin-svgr
```

Bench result on this exact case before/after: **0/3 → 3/3**.

The built-in registry currently covers four libraries chosen for high LLM-repair confusion ratio:

| Library | Hint |
|---|---|
| `vite-plugin-svgr` v4+ | `?react` query suffix to import as React component |
| `next` v15+ | `params` / `searchParams` are now Promises (must `await`) |
| `ai` v3 / v6 | `generateText` API shape changes |
| `drizzle-orm` | parameterized `sql` template literals, not string concat |

`detectLibraryMigrations(workspaceRoot, registry?)` is also exported as a public API; pass your own registry to extend it. `runMendLoop` auto-invokes detection when you leave `context.libraryMigrations` `undefined`; pass `[]` to opt out, or `--no-library-hints` on the CLI.

### Security-aware system prompt

The same release hardened the system prompt against the LLM-repair failure modes that silence tsc at the cost of runtime semantics:

- **`as keyof T` to silence TS7053** — fix the function signature or guard with `if (key in obj)` instead. Casting away an index-signature error keeps the call type-passing while losing all the runtime safety.
- **Substituting one library for another to dodge a missing import** — e.g. `bcrypt` → `crypto.subtle.digest`. The fix is to restore the missing import, not swap to a different cryptographic primitive that tsc accepts.
- **String concatenation of user input into raw SQL** — use Drizzle's tagged template / Prisma placeholders.
- **`dangerouslySetInnerHTML` to dodge a children-type error** — JSX `{value}` auto-escapes; if you need HTML, sanitize via DOMPurify.

### Realistic bench (34 fixtures, single + multi-file)

Measured against a 34-fixture corpus drawn from real LLM-repair failures in adjacent projects (24 single-file + 10 multi-file), n=3 per cell:

| Surface | v0.5.0 | v0.6.1 | Δ |
|---|---|---|---|
| Single-file pass rate | 95.8% | **98.6%** | +2.8pp |
| Multi-file pass rate | 23.3% | **40.0%** | +16.7pp |
| Aggregate (102 cells) | 74.5% | **81.4%** | +6.9pp |
| Hard crashes | 6 cells | **0** | -6 |
| Cost per full bench | — | **$0.21** | — |
| Cost per case (`claude-haiku-4-5`) | — | **<$0.005** | — |

The mend-quality gains landed in v0.6.0 (library-migrations, crash hardening, anti-patterns); v0.6.1 adds multi-provider + telemetry without changing these numbers. Multi-file scenarios remain the gap — Layer 3 (multi-file mend with `findReferences`-driven blast-radius search) is the deferred answer.

## The four-layer model

```
Layer 0 — Prevention        (prompt rules, exported-API injection — your problem)
Layer 1 — Deterministic     (this package: LSP auto-fix, CLI default)
Layer 2 — Single-file LLM   (this package: opt-in via --llm or runMendLoop)
Layer 4 — Stub-and-continue (this package: opt-in escape hatch, @ts-expect-error)
─────────────────────────────────────────────────────────────────
Layer 3 — Multi-file LLM    (planned: blast-radius search/replace via findReferences)
```

The bet: roughly half of TypeScript errors in LLM output are deterministically fixable. By catching them in Layer 1 you dodge the LLM tax (latency, cost, nondeterminism) on the easy half. Layer 2 takes the other half — but only when you explicitly invoke it. Layer 4 makes sure the workspace is never left worse than it started.

## Library API

### Layer 0/1 — deterministic loop

```typescript
import { runValidationLoop } from '@shipispec/tsfix';

const result = runValidationLoop({
  workspaceRoot: '/path/to/your/project',
  // Optional:
  // targetFiles: ['src/api.ts'],
  // dryRun: true,
  // logger: { info: console.log, warn: console.warn, error: console.error },
});

result.errorsBefore;          // number
result.errorsAfter;           // number
result.lspFixer.fixesApplied; // number
result.lspFixer.filesEdited;  // string[]
result.passed;                // boolean — true if errorsAfter === 0
```

Other Layer 0/1 exports:

- `runInProcessTsc(opts)` — validation only, no fixer. Returns structured diagnostics.
- `runLSPFixerPass(opts)` — Layer 0 fixer alone, no validation loop wrapper.
- `discoverTsFiles(workspaceRoot)` — file-walking helper. Skips `node_modules`, `.next`, `dist`, `build`, `out`, `coverage`, `.git`.

### Layer 2 — LLM mend (opt-in)

```typescript
import { runValidationLoop, runMendLoop } from '@shipispec/tsfix';

// Layer 0/1 first.
const layer1 = runValidationLoop({ workspaceRoot });

if (!layer1.passed) {
  // Layer 2 escalation.
  const layer2 = await runMendLoop({
    context: {
      workspaceRoot,
      diagnostics: layer1.remainingDiagnostics,
      erroredFiles: layer1.lspFixer.filesWithErrors,
      // Optional fields that improve mend quality:
      // taskDescription: 'Build a user CRUD module',
      // featureSpecText: '...the markdown spec...',
      // acceptanceCriteria: '...',
      // installedTypes: '...',  // compact API surface from npm deps
    },
    llm: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    maxIterations: 3,
  });

  console.log(layer2.stopReason);  // 'fixed' | 'noProgress' | 'regressed' | 'maxIterations'
  console.log(layer2.totalCostUsd);
}
```

Other Layer 2 exports:

- `mendSingleFile(opts)` — one LLM call for one file. The building block under `runMendLoop`.
- `getTypeContext(opts)` — resolve a `Diagnostic` to its declaring type via the TS Language Service and return ±N lines around the declaration. The architectural moat — every other LLM-driven repair tool uses generic grep or repo-maps.
- `parseEditBlocks(text)` / `applyEditBlocks(opts)` — Aider-style SEARCH/REPLACE patch parser + 3-tier fuzzy applier.
- Types: `MendContext`, `LayerEvent`, `Diagnostic`, plus the per-function option/result types.

## Trust model

Layer 0/1 loads `typescript` from your workspace's `node_modules` — it does **not** bundle its own. This ensures the fixer behaves identically to the `tsc` your project actually compiles with.

> **Run tsfix only on workspaces you trust.** Loading `typescript` from an attacker-controlled `node_modules` is equivalent to running `node_modules/.bin/tsc` against it.

**Network surface (Layer 0/1):** none. No telemetry, no calls home, no background processes, no config files written outside `--workspace`.

**Network surface (Layer 2):** every `mendSingleFile` call hits Anthropic's API via the Vercel AI SDK. The source files in `MendContext.erroredFiles` and the resolved type-context slices are sent in the prompt. If your code is sensitive, do not call Layer 2 — the CLI never does, and the library exports are explicit.

## Engines

- Node `>=20.9.0`
- TypeScript `>=5.0.0` (peer dep — must be installed in your workspace)

If your workspace has no `node_modules/typescript`, tsfix will fail with a clear error:

```
error: this workspace has no TypeScript installed.
run: npm install --save-dev typescript
```

## Build from source

tsfix is plain TypeScript bundled with esbuild — no special toolchain.

```bash
git clone https://github.com/owgreen-dev/tsfix
cd tsfix
npm install

npm run check-types   # tsc --noEmit — must pass
npm test              # vitest unit suite
npm run build         # bundle to dist/ (index.js, cli.js, *.d.ts)
```

Run a single test file or pattern:

```bash
npx vitest run src/libraryMigrations.test.ts
npx vitest run -t "auto-populates libraryMigrations"
```

Try your local build against a real project without publishing:

```bash
npm run build
node dist/cli.js --workspace /path/to/some/broken-project
```

Requires Node `>=20.9.0`. The package has no `dev` watch script — the loop is edit → `npm run check-types` → `npm test`.

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full guide: dev setup, how to add a Layer-0 fix or a Layer-2 fixture, how to extend the library-migration registry, and the pre-publish gates. PRs that add a library to the migration registry are especially welcome — that's the highest-leverage contribution.

## License

MIT.

## See also

- `CHANGELOG.md` — release notes per version (authoritative for current state).
- `CONTRIBUTING.md` — dev setup, how to add a fix/fixture, how to extend the migration registry.
- `ARCHITECTURE.md` — design rationale (the four-layer model, the workspace lib-path workaround).
- `ROADMAP.md` — phased plan and resolved/deferred decisions.
- `docs/blog-tsc-correctness-is-not-runtime-correctness.md` — the "tsc-correctness ≠ runtime-correctness" writeup (the svgr `?react` case).
