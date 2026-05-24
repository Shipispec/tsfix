# Contributing to tsfix

Thanks for helping. tsfix is MIT-licensed and BYOK — no proprietary core, no paid tier. The most valuable contributions are (1) new entries in the library-migration registry and (2) real-world fixtures that expose where Layer 2 picks the wrong fix.

## Dev setup

tsfix is plain TypeScript bundled with esbuild. No special toolchain.

```bash
git clone https://github.com/shipispec/tsfix
cd tsfix
npm install
```

The dev loop is edit → check-types → test (there is no `dev` watch script):

```bash
npm run check-types   # tsc --noEmit — must pass before commit
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
node dist/cli.js --workspace /path/to/some/broken-project --llm   # --llm needs ANTHROPIC_API_KEY
```

Requirements: Node `>=20.9.0`, and the workspace you point tsfix at must have `node_modules/typescript` (tsfix loads the workspace's own `tsc`, never bundles one).

## Adding a library to the migration registry (highest-leverage)

The registry lives in `src/libraryMigrations.ts` as `BUILT_IN_LIBRARY_MIGRATIONS`. Each entry fires when a matching dep is found in the target workspace's `package.json`, injecting a hint into the Layer 2 prompt so the LLM doesn't blindly follow tsc's misleading quick-fix.

**Bar for inclusion:** an entry must correspond to a real migration where tsc's own quick-fix is *wrong at runtime* (type-checks but breaks). General TypeScript advice does not belong here — that's the system prompt's job, and Layer 0/1's job for deterministic fixes.

1. **Find the failure.** Reproduce a case where, with the library installed at the breaking version, an LLM follows tsc's quick-fix and produces code that type-checks but breaks at runtime. The `vite-plugin-svgr@4` `?react` case is the canonical example.
2. **Add a fixture** (see below) that reproduces it, and confirm Layer 2 fails it *without* a hint.
3. **Add the registry entry:**

   ```ts
   {
     match: { name: "your-lib", minMajor: 2 },   // maxMajor optional
     hint:
       "your-lib v2+ changed X. The PREVIOUS form `...` no longer works. " +
       "Correct fix: `...`. DO NOT use tsc's quick-fix `...` — it type-checks " +
       "but <breaks at runtime how>.",
   },
   ```

   `minMajor` / `maxMajor` are optional version bounds (parsed from the dep's version spec — `^4.0.0`, `~4`, `4.0.0` all resolve to major `4`). Omit both to match any version.
4. **Confirm the hint flips the fixture** to passing, and add a unit test in `src/libraryMigrations.test.ts` covering the new match rule.

Keep hints concrete and short — name the wrong form, the right form, and *why* tsc's suggestion breaks. Vague hints don't move the model.

## Adding a Layer-0 fix

Layer 0 only applies fixes that are deterministic and non-structural. Each new code/fix-name pair gets its own fixture; we trust the language service only under specific, pinned conditions.

1. **Probe** — write a tiny test workspace with the exact error you want fixable under `fixtures/<descriptive-name>/` with an `expected.json` declaring `errorsBefore`, `errorsAfterMax`, `lspFixesAppliedMin/Max`, and `mustPass`.
2. **Verify** — run `npm run benchmark -- --fixture <name>` and inspect what the language service offers (the `fix.fixName` field).
3. **Allowlist change** — if `fixName` is unsafe (`fixMissingFunctionDeclaration`, `addMissingPropertyAndOptional`, etc.), document why we don't trust it. Otherwise add the error code to `SAFE_FIXABLE_CODES` and the fix name to `SAFE_FIX_NAMES` in `src/tsLanguageServiceFixer.ts`.
4. **Lock it in** — confirm all existing fixtures still pass (`npm run benchmark`). Open a PR.

## Adding a Layer-2 fixture

Layer-2 fixtures live under `fixtures/` alongside Layer-0 ones, identified by `expectedErrorCode` (singular) or `costUsdMax` in their `expected.json`. The Layer-0 benchmark skips them; `npm run benchmark:llm` runs them against Anthropic.

- Hand-author one under `fixtures/mend-<descriptive-name>/` for a new error class.
- Or generate one: `npm run generate-fixtures -- --code=TS2339 --seed=apiRouter.ts --count=10 --rng-seed=42`. The generator validates every mutation through Layer 0 first to confirm Layer 0 abstains (otherwise it's not Layer 2 territory).

## Pre-publish gates

Run before tagging a release:

- `npm run check-types` && `npm test` — must pass.
- `npm run benchmark` — Layer 0 deterministic suite, no network.
- `npm run benchmark:llm` — Layer 2 suite, requires `ANTHROPIC_API_KEY`. Costs a few cents per run.
- `npm run matrix` — runs the local tarball against 6 distinct project shapes (Next.js, Vite + React, plain `nodenext`, plain `bundler`, plain CommonJS, monorepo with project references). Adds ~3 min; run manually before tagging.

## Code style

- TypeScript strict, no `any` — use `unknown` + type guards.
- Named exports only.
- ES module syntax in source (esbuild emits the runtime bundle).
- Never swallow errors silently.
- Commits: conventional style (`feat(...)`, `fix(...)`, `docs(...)`, `chore(...)`).

## License

By contributing, you agree your contributions are licensed under the MIT License.
