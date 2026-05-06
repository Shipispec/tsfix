# Engineering plan for installedExports.ts

This is a concrete, implementable build plan for `installedExports.ts` — a ts-morph-based extractor that pulls the public API surface from installed npm packages and injects compact, accurate type signatures into LLM code-gen prompts. It mirrors the existing `priorExports.ts` pattern but points at `node_modules`.

The single most important architectural decision: **trust TypeScript's resolution algorithm verbatim**, do all I/O through `ts.resolveModuleName`/ts-morph against the actual installed `node_modules`, never use lockfiles or heuristics for the resolution step. Everything else (formatting, caching, budgeting) is downstream of getting the right `.d.ts` file.

## The shape of the module

`installedExports.ts` exposes one primary function:

```ts
export async function buildInstalledTypesBlock(
  taskSpec: string,
  projectRoot: string,
  budgetTokens = 1500,        // ~5KB
): Promise<{ promptBlock: string; usedPackages: string[]; tokens: number }>;
```

Internally it runs a five-stage pipeline: **detect → resolve → extract → format → pack**. Stages 2–4 are cached per `package@version`; stage 5 (packing into the budget) runs every call because it depends on the task. Lazy on first request, with `node_modules/.cache/installed-exports/` as the cache directory.

## Stage 1 — Detect which packages a task imports

Run static analysis on the task spec markdown. The detection is multi-pronged because specs combine code blocks with prose:

```ts
function detectPackagesUsed(spec: string, projectDeps: Set<string>): Set<string> {
  const found = new Set<string>();
  // (a) Parse fenced ```ts/tsx/js/jsx code blocks with ts-morph; collect ImportDeclaration
  //     module specifiers and dynamic import()/require() call args.
  // (b) Regex fallback over the whole spec: /(?:from|import\(|require\()\s*['"]([^'"]+)['"]/g
  // (c) Bareword scan for any name in projectDeps with word boundaries.
  // (d) Implicit deps from file-path patterns: app/**/page.tsx → seed {next, react}.
  // Map every specifier through specifierToPackage(): @scope/name/sub → @scope/name; name/sub → name.
  return found;
}
```

Read `projectDeps` from `package.json` (`dependencies` ∪ `devDependencies` ∪ `peerDependencies`). Filtering by deps gives near-100% precision on barewords; recall gaps come from prose-only specs without code blocks, where a single Haiku-class fallback call ("list npm packages this task implies, restricted to: [list]") is cheap insurance — but ship without it initially.

## Stage 2 — Resolve the .d.ts entry point

Implement TypeScript 5.x's resolution algorithm exactly. The algorithm is deterministic and authoritative:

1. **Enter `node_modules/<pkg>/`**, read `package.json`.
2. **If `exports` is present and `moduleResolution` is `bundler`/`node16`/`nodenext`**: walk the `exports` object in JSON insertion order, matching condition keys against `["types", "import"|"require", "default"]` (omit `"node"` under `bundler`). The `"types"` condition must match first if present. The handbook's verbatim rule: *"the presence of `\"exports\"` prevents any subpaths not explicitly listed or matched by a pattern in `\"exports\"` from being resolved."*
3. **Else, if subpath is `.`**: try `pkg.types` → `pkg.typings` → extension-substitute `pkg.main` → `index.d.ts`.
4. **Else (subpath, no `exports`)**: package-relative path with extension substitution (`/foo` → `/foo.d.ts`, `/foo.d.mts`, `/foo.d.cts`, then `/foo.ts/.tsx/.js/.jsx`).
5. **Honor `typesVersions`** only when `exports` was NOT consulted.
6. **Fall back to `node_modules/@types/<pkg>/`** with the same algorithm if no `.d.ts` resolved. **Bundled types win over `@types/*`** (TS#19283, working as intended).

Use **`moduleResolution: "bundler"`** as the default for the extractor. It honors `exports`, doesn't require knowing whether the importer is ESM or CJS, and matches the conditions that modern bundlers/runtimes use. If the user's project pins `node16`/`nodenext` and is server-only, replicate it (read their `tsconfig.json` once at startup) so we see the same `"node"`-conditional types they will at runtime.

Don't use ts-morph for resolution — there's no public `project.resolve()` (ts-morph#927). Call **`ts.resolveModuleName(name, importer, compilerOptions, host)`** from the TypeScript compiler API directly with `host = ts.createCompilerHost(opts)`. The result has `resolvedFileName`, `isExternalLibraryImport`, and `packageId.{name,version,subModuleName}`. This is exactly what `tsserver` uses.

For each package, also enumerate every subpath listed in its `package.json` `exports` object. For Next.js (which has no `exports` field) enumerate the well-known sibling files: `next/server`, `next/navigation`, `next/headers`, `next/cache`, `next/link`, `next/image`, `next/font/{google,local}`, `next/og`. For Drizzle (~50 subpaths) only resolve the dialects matching deps the project actually imports.

## Stage 3 — Load with ts-morph

Initialize one shared `Project` per extraction run so lib files load once:

```ts
const project = new Project({
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: false,    // we WANT transitive resolution
  compilerOptions: {
    target: ScriptTarget.ES2022,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.Bundler,
    noEmit: true, skipLibCheck: true, allowJs: false,
    esModuleInterop: true, allowSyntheticDefaultImports: true,
    types: [], lib: ["lib.esnext.full.d.ts"],
  },
});
const sf = project.addSourceFileAtPath(typesEntry);
project.resolveSourceFileDependencies();
```

`skipLibCheck: true` is **critical for performance and error tolerance**; many `.d.ts` files have errors that don't matter for extraction. `types: []` prevents auto-pulling all of `node_modules/@types/*`. Adding `react/index.d.ts` will transitively load `@types/react`, `@types/scheduler`, `csstype`, plus libs (~30–50 SourceFiles for React alone).

**Yarn PnP is incompatible** with ts-morph's default file system host (#1168). Detect `.pnp.cjs` and emit a warning advising `nodeLinker: node-modules`.

## Stage 4 — Extract exports

The principal API is `SourceFile.getExportedDeclarations()`, which returns `Map<string, Declaration[]>`, automatically follows re-exports (`export * from`, `export { x } from`), and preserves declaration merging (multiple declarations under one key). It works on `.d.ts` like any other source file.

Two performance traps to know about:
- `getExportedDeclarations()` is **expensive** because it invokes the type checker (#644). Call it once per file and cache. For React with hundreds of barrel re-exports, expect noticeable latency.
- It returns the same declaration under aliases — dedupe by `declaration.compilerNode === other.compilerNode`.

**Filter by source file path** to keep the extractor scoped to the package's own files:

```ts
for (const [name, decls] of sf.getExportedDeclarations()) {
  for (const decl of decls) {
    const declPath = decl.getSourceFile().getFilePath();
    if (!declPath.startsWith(pkgDirAbs) &&
        !declPath.includes(`/@types/${packageName}/`)) continue;
    // emit
  }
}
```

This skips lib files and transitively-pulled deps unless they ARE the package's types (e.g., `@types/react` for `react`).

**Handle ambient modules separately** — Stripe's pattern is `declare module 'stripe' { class Stripe {...}; namespace Stripe {...} }` and `getExportedDeclarations()` returns nothing at top level:

```ts
for (const m of sf.getDescendantsOfKind(SyntaxKind.ModuleDeclaration)) {
  if (!m.hasDeclareKeyword()) continue;
  const nameNode = m.getNameNode();
  if (!Node.isStringLiteral(nameNode)) continue;
  const block = m.getBody();                          // ModuleBlock
  for (const stmt of block?.getStatements() ?? []) {
    // FunctionDeclaration, ClassDeclaration, InterfaceDeclaration,
    // TypeAliasDeclaration, ExportAssignment (export =), namespace decls
  }
}
```

Module augmentations (next-auth extending Session, express extending Request) are **out of scope** — they live in user code, not in the package's own `.d.ts`. Document this limitation; the LLM will see only the package's declared API.

## Stage 5 — Compact format for LLM consumption

**Output stripped TypeScript-shaped declarations in fenced ```ts blocks**, one block per package, headered `// ── pkg@version ──`. TS-shaped output is what models trained on `.d.ts` expect, tokenizes efficiently in cl100k_base/o200k_base (~3.5–4 chars/token), and avoids markdown table padding overhead. Aider's elided-tree format is the strongest reference for prior art (`⋮...` markers, scope-aware preservation).

Per-declaration rules:

| Concern | Rule |
|---|---|
| Function/method | Use `node.getText()` directly — `.d.ts` already has no body. For overloaded functions, collect `[fn, ...fn.getOverloads()]` and either join all signatures (≤3 overloads) or keep the most general + `// (+N overloads)`. |
| Class | Strip private/protected members; emit constructor + public method signatures. |
| Interface/TypeAlias | Cap at 12 properties; suffix `// +N more`. |
| Variable export with inferred type | `${name}: ${type.getText(decl, TypeFormatFlags.NoTruncation)}` — **always pass `decl` as enclosing node** to avoid `import("/abs/path").Foo` artifacts (#687). |
| Generics | Preserve `<T extends Foo>`; drop only default args (`= unknown`). |
| Long unions (>6 members) | Replace with the alias name or `string`. Detect via `Type.isUnion()` and `getUnionTypes().length`. |
| JSDoc | Drop `@example`, `@see`, prose multilines. **Keep `@deprecated` markers** (no body) — high-signal for hallucination prevention. |
| Re-export barrels | Collapse to `// re-exports from './sub' (NN symbols)`. |
| Internal | Drop names starting with `_`, `__`, `Internal`, `@internal` JSDoc, paths under `/dist/internal/`. |

Cache the rendered string output per package — the rendering is what's expensive, not loading.

## Stage 6 — Caching

**Location:** `node_modules/.cache/installed-exports/` via `find-cache-dir({ name: 'installed-exports', create: true })`. This is the convention used by jest, eslint, babel-loader, stylelint; it auto-gitignores, invalidates with `node_modules`, and keeps `.next/cache/` clean. Honor `INSTALLED_EXPORTS_CACHE_DIR` env override.

**Key:** `<pkg-encoded>@<version>__<dtsHash8>__<toolVersion>.json`. Read version from `node_modules/<pkg>/package.json` (the only source guaranteed to match the `.d.ts` on disk; lockfiles can drift). Hash an 8-char SHA256 over the concatenated `.d.ts` byte stream — catches `patch-package` patches and republishes. Tool version segment auto-invalidates on extractor logic changes.

**Format:** one JSON file per package, atomic rename-on-write:

```json
{
  "schema": 1,
  "name": "react", "version": "19.2.5",
  "dtsHash": "a3f9...", "toolVersion": "0.4.2",
  "extractedAt": 1730123456,
  "subpaths": {
    ".":           { "promptText": "...", "tokens": 612, "exportCount": 38 },
    "jsx-runtime": { "promptText": "...", "tokens":  84, "exportCount":  3 }
  }
}
```

Store **pre-rendered prompt-ready strings + token counts**, not AST. The rendering work is what you cache.

**Warming:** lazy-with-manifest hybrid. Don't use `postinstall` (npm/pnpm/yarn-berry users disable it; CI hates it). Provide `installed-exports warm` CLI for users who want to wire it into a `prepare` script. Keep a `_manifest.json` at the cache root listing `{name, version, dtsHash}` for installed packages, regenerated on first use, enabling parallelized worker-thread warm-up.

## Stage 7 — Token budget enforcement

Aider-style two-level greedy fill. Allocate budget across packages by relevance, then within each package binary-search the largest export prefix that fits its slot.

```ts
const FLOOR = 60, CAP = 600;       // per-package token bounds
// 1. Score each package: mention_count * (cited_in_import ? 3 : 1) * framework_boost
// 2. slots[i] = clamp(budget * score[i] / totalScore, FLOOR, CAP)
// 3. For each pkg, sort exports by per-export priority, greedily pack into slot.
//    On overflow, append "// (… N more exports omitted)\n".
```

Per-export priority order (highest first): exports named in spec → top-level functions/classes/components → arg/return types of those → const value exports → re-export barrels → internal types. Add a "recently-changed-API risk boost" using `@since` JSDoc — fresh APIs deserve more context budget because they're hallucination magnets.

Truncation cascade applied progressively until under budget: drop JSDoc → drop overload variants → collapse big unions → simplify generic constraints → drop sub-namespaces → drop internal types → bare skeletons. **Call signatures survive longest** because they're the highest-signal element for code-gen.

Recommended split for a typical 6–10 package Next.js task at 1500 tokens: framework (next+react) ~600, domain libs (zod/drizzle/clerk) ~500, utility libs ~250, headers/markers ~150.

## Stage 8 — Pipeline integration

Place `installedExports` and `priorExports` between the `tasks` and `implement` phases of the spec-driven pipeline. The prompt structure, with installed types **above** instructions per Anthropic long-context guidance:

```
<installed_types>
// ── react@19.2.5 ──
...

// ── next@16.2.4 (next/headers) ──
export function cookies(): Promise<ReadonlyRequestCookies>;
export function headers(): Promise<ReadonlyHeaders>;
...
</installed_types>

<prior_task_types>
// ── from tasks/auth/session.ts ──
...
</prior_task_types>

<api_drift>
- prior task used clerkClient.users.getUser(id) (clerk@4.x)
- installed shows clerkClient().users.getUser(id) — clerkClient is async in v6+
  → prefer the installed signature
</api_drift>

<task_spec>...</task_spec>

<instructions>...</instructions>
```

**Keep installed and prior types in separate sections** — different provenance, different staleness, lets the model distinguish "third-party API I must call correctly" from "internal API my prior tasks created." Installed types come first because they're more authoritative about the world; prior types come second because they're project-specific and can override stylistic patterns.

**Conflict detection algorithm:** for any symbol appearing in both blocks, do a structural diff of param names, types, and return types. If non-trivial, emit an `<api_drift>` entry. This prevents the LLM from silently picking one or hallucinating a hybrid.

Cache the **fully assembled prompt block per `(task-id, deps-hash, prior-tasks-hash)`** at one level above `installedExports.ts`, so repeated runs of the same task without changes cost zero.

## Per-package handling

The package surface area, version-specific gotchas, and what to skip differ enormously. The data below was distilled from current docs and `.d.ts` patterns and informs the per-package extraction priority and gotcha-injection.

**`next` (16.2.x as of April 2026, latest stable).** No `"exports"` field; subpaths resolve via package-relative paths (`next/headers.d.ts` etc. as siblings). Bundled types only. Critical version gotchas to inject as comments alongside the signatures: `cookies()`, `headers()`, `draftMode()` return `Promise` and synchronous fallback was **removed in 16**; `params` and `searchParams` are `Promise` in `page.tsx`/`layout.tsx`/`generateMetadata`; `middleware.ts` is renamed to **`proxy.ts`** in 16; `unstable_after` → stable `after`; `experimental.ppr` removed in favor of `experimental.cacheComponents`; `cacheLife`/`cacheTag` no longer `unstable_`; AMP, `next lint`, `serverRuntimeConfig` removed; min Node 20.9. Use `PageProps<'/blog/[slug]'>` typegen helper. Skip pages-router-only APIs unless `pages/` exists; skip Turbopack rule types and font subset literal unions.

**`react` (19.2.x).** **No bundled types** — relies on `@types/react` via the @types fallback. Most important new-in-19 surfaces an LLM gets wrong: `useActionState` (renamed from `react-dom`'s `useFormState`, returns 3-tuple `[state, dispatch, isPending]`); `use(promise|context)` is a real hook callable in conditionals; `ref` is a regular prop on function components — **don't suggest `forwardRef` for new code**; `ReactNode` now includes `Promise<ReactNode>` for RSC; async function components are valid Server Components; `useRef<T>(null)` returns `RefObject<T | null>`. Skip HTML/SVG attribute interfaces and class-component lifecycle types — they blow the budget. Note the React 19.0.0–19.2.2 RCE in Server Components (CVE-2025-55182, patched 19.2.3+); the extractor should emit a deprecation hint if version is in that range.

**`zod` (4.3.x).** Zod 4 is now at the package root; v3 is at `zod/v3`. Bundled types. Critical changes vs v3 the LLM will get wrong: `z.email()`/`z.uuid()`/`z.url()` are top-level (not `.string().email()`); `z.nativeEnum()` removed (use `z.enum(MyEnum)`); `.merge()` deprecated (use `.extend()`); `ZodError.issues` not `.errors`; `z.promise()` deprecated; `z.function()` is a function builder, not a schema. The extractor should always include `parse`/`safeParse`/`safeParseAsync` signatures and the `z.infer<T>`/`z.input<T>` type helpers.

**`@supabase/supabase-js` (2.103.x).** Bundled types, single root export, but re-exports from `@supabase/postgrest-js`/`auth-js`/`storage-js`/`realtime-js`/`functions-js` so the extraction will transitively pull those .d.ts. Inject the `{ data, error }` result-shape gotcha — LLMs frequently miss the destructure. `.single()` errors on row count ≠ 1; `.maybeSingle()` allows 0–1. `Database` generic goes on `createClient<Database>()`, not on the result. Auto-pagination via `for await` works. Skip realtime channel internals, MFA methods, deep storage configuration.

**`drizzle-orm` (0.45.x stable; 1.0-beta available).** Bundled types, ~50 subpath exports. Pick **one dialect** based on project imports — never ship all. Critical resolution rule: column builders (`pgTable`, `integer`, `text`) come from `drizzle-orm/pg-core`; operators (`eq`, `and`, `or`, `sql`) come from `drizzle-orm` root; `drizzle()` from the per-driver subpath (`drizzle-orm/node-postgres`, `drizzle-orm/postgres-js`, etc.). LLMs frequently mix these up. Always include `$inferSelect`/`$inferInsert` and `.returning()` requirement for PG/SQLite mutations. RQB v1 `relations()` vs RQB v2 `defineRelations()` — don't mix.

**`@clerk/nextjs` (7.2.x, Core 3).** Bundled types. The split between `@clerk/nextjs` (client-safe) and `@clerk/nextjs/server` (auth/currentUser/clerkMiddleware/clerkClient/createRouteMatcher) is the single most important fact to surface. v6+ made `auth()`, `clerkClient()` async; `await auth()` returns `{ userId, isAuthenticated, has, getToken, redirectToSignIn, sessionClaims }`. `clerkMiddleware` lives in `proxy.ts` for Next.js 16+, `middleware.ts` for ≤15. `authMiddleware()` removed. Skip `appearance`/`localization` deep types — huge unions.

**`stripe` (22.x).** Uses `declare module 'stripe'` ambient module pattern (currently being migrated away from but still present), so you must walk into `ModuleDeclaration` bodies — not `getExportedDeclarations()` at top level. Types are ~3MB raw — **never inject wholesale**. Strategy: extract only resources actually used in the project (default to `customers`, `paymentIntents`, `checkout.sessions`, `subscriptions`, `webhooks`); show only method names without param shapes; defer to docs link for full param interfaces. v22 made `Stripe` a real ES6 class — `new Stripe(key, { apiVersion: '2026-03-25.dahlia' })` is mandatory. Webhook construction requires raw request body and `stripe-signature` header. Idempotency key goes in the second arg, not in params. Discriminated event types via `event.type` narrow `event.data.object`.

## Pitfalls and mitigations

The five most consequential pitfalls and how to handle each:

- **`@types/*` vs bundled types precedence.** Bundled wins (TS#19283). Always check the package's own resolution chain first; only fall back to `node_modules/@types/<pkg>` when bundled returns nothing. React is the canonical case where bundled is empty, so the fallback fires.
- **Module resolution mode mismatch.** Under `bundler` the `"node"` condition isn't matched; under `node16`/`nodenext` it is, dispatching `import` vs `require` based on the importer's detected module format. If a package has a `node`-conditional `.d.ts`, our extractor under `bundler` will see a different surface than the user's runtime under `node16`. Mitigation: replicate the project's `tsconfig` `moduleResolution` and `module` exactly. When in doubt, run extraction twice and merge.
- **Ambient `declare module` blocks.** Stripe's pattern, and the `next-auth` augmentation pattern. `getExportedDeclarations()` returns nothing at top level; you must walk the `ModuleDeclaration` body. User-side augmentations (extending `Session`, `Express.Request`) live outside the package and are out of scope.
- **Massive re-export trees.** React, lodash, rxjs, `@aws-sdk/*`. Mitigations: filter by source file path to package directory; cap output count; deduplicate by declaration identity; cache aggressively. For aws-sdk-class packages, only extract sub-modules actually imported (`@aws-sdk/client-s3` not `aws-sdk` umbrella).
- **Yarn PnP and pnpm hoisting.** ts-morph's default file system host can't read PnP zips (#1168). Detect `.pnp.cjs` and warn. pnpm's `node_modules/.pnpm/` symlink layout works fine because the package directories ultimately resolve to real paths.

Other pitfalls worth coding defensively against: triple-slash `<reference lib="dom" />` directives pulling lib files into the project (filter by path before emitting); `paths`/`baseUrl` in user `tsconfig.json` shadowing the actual `node_modules` install (always start from the literal `node_modules/<pkg>/` directory); `export = X` CJS pattern requiring `sourceFile.getExportAssignment()` rather than the default-export key; `typesVersions` redirects (rare but consequential for older TS-version-specific shims).

## Implementation priority

Build in this order. Each stage is a deployable improvement — don't try to ship the whole thing at once.

**P0 (must work for any value):** Package detection from spec (Stage 1) → resolution via `ts.resolveModuleName` (Stage 2) → ts-morph load + `getExportedDeclarations()` extraction (Stages 3–4) → naive concatenation of `node.getText()` for top-level exports → stuff into prompt under a hard 6KB char cap. Skip caching, skip ambient modules, skip per-package gotchas. Get end-to-end working against `react`, `zod`, `next` first because they cover the three resolution paths (`@types` fallback, `exports`-with-`types`, no-`exports`-package-relative).

**P1 (correctness):** Ambient module walking (unblocks Stripe). Filter-by-source-path (cleans output dramatically). `TypeFormatFlags.NoTruncation` with enclosing node (kills `import("/abs/...")` artifacts). Deduplicate by declaration identity. Cache by `package@version__dtsHash__toolVersion` to JSON files in `node_modules/.cache/installed-exports/`. Pre-render prompt strings; store token counts.

**P2 (quality):** Token budget allocator with package scoring + per-package binary-search slot fill. Per-export priority sort. Truncation cascade. JSDoc handling (drop everything except `@deprecated`). Overload collapsing. Big-union truncation. Re-export barrel collapsing.

**P3 (polish):** Per-package gotcha injection (the version-specific notes for next/react/zod/clerk/drizzle/supabase/stripe — emit them inline as `// note:` comments in the rendered TS block when version matches). API drift detection vs `priorExports.ts` output emitting `<api_drift>` blocks. CLI `installed-exports warm` for CI precomputation. Manifest-based parallel worker-thread warming. PnP detection + warning.

**P4 (research-grade):** LLM-fallback package detection for prose-only specs. Module-augmentation merging from user code. Re-render-on-`tsconfig`-change to honor `node16` semantics when the project pins it.

## Conclusion

The hard part of `installedExports.ts` is not the ts-morph code — it's resolving the right `.d.ts` file, knowing what to skip from each package, and sizing the output to fit a real LLM prompt without losing the signal that prevents version-specific hallucinations. **Get resolution right first** by implementing TypeScript's documented algorithm verbatim and using `ts.resolveModuleName` as the source of truth. **Get formatting right second** by emitting stripped TS-shaped declarations in fenced blocks, headered with `pkg@version`, with version-specific gotchas inlined as comments — this is the single highest-leverage hallucination prevention. **Cache aggressively** by `package@version+contentHash` to `node_modules/.cache/installed-exports/`. **Budget like Aider** — priority-weighted per-package slots, binary-search packing, JSDoc-first truncation cascade — at ~1500 tokens / 5KB total. The seven specific packages listed have wildly different surface areas and version risks; ship a per-package gotcha table alongside the generic extractor so the LLM gets the async `cookies()`, the `params: Promise` shape, the `clerk auth()` async upgrade, the Drizzle subpath split, the Stripe ambient-module pattern, and the Zod 4-at-root facts even when the raw signatures don't fully convey them. Build in P0→P3 order; each phase is independently deployable.