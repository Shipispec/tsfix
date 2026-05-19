# tsc-correctness ≠ runtime-correctness: a story about three characters

*Published with tsfix v0.6.0, 2026-05-19.*

Here is a TypeScript error you have probably seen.

```
src/Header.tsx:3:10 - error TS2614: Module '"./logo.svg"' has no exported
  member 'ReactComponent'. Did you mean to use 'import Logo from "./logo.svg"'
  instead?
```

tsc helpfully tells you the fix. Your editor offers it as a one-click Quick Fix. An LLM doing code repair will reliably take it. After the fix:

```tsx
import Logo from "./logo.svg";
//                            ← tsc is now green
//                            ← the dev server now crashes
```

The fixed file type-checks. The app is broken. `Logo` is now the asset URL string, not a React component, so `<Logo />` blows up with "Logo is not a function" the moment the page renders.

This is the gap LLM-driven code repair walks into every day, and the gap tsfix v0.6.0 is built around.

## The three characters

Three things shape the LLM-repair failure in this case, and they all have to be in the room to see why it happens.

**The library author.** `vite-plugin-svgr` v4 changed how you import an SVG as a React component. The default import is now the asset URL, and you have to opt in to the React-component import with a `?react` query suffix:

```tsx
import Logo from "./logo.svg?react";
```

Reasonable choice for them: it makes the plugin's default behavior match what every other Vite asset import does, and the `?react` suffix is explicit. Breaking change, but small. Their migration guide says exactly this.

**The TypeScript team.** TS doesn't know about Vite plugins. All it sees is a `*.svg` ambient module declaration. If your declaration says `export const ReactComponent: ...` and you import `{ ReactComponent }`, that's a named import that doesn't exist — TS2614. Its Quick Fix logic looks for plausible alternative imports from the same module, finds the `default` export, and suggests `import Logo from "./logo.svg"`. From TS's seat, that's a clean suggestion. It makes the program type-check.

TS is right about types and wrong about runtime semantics. It has no way to be otherwise.

**The LLM.** Trained on a corpus that is, overwhelmingly, "code that compiles." Pre-v4 vite-plugin-svgr exported `ReactComponent` as a named member — millions of training tokens still say so. v4 docs exist but they're a thin slice of the data. When tsc says "use the default import instead," the LLM agrees. It would have suggested the same fix on its own.

The LLM is not being lazy. It is doing exactly what its training distribution and the compiler's hint tell it to do. They both happen to be wrong.

## The fix is not the LLM. The fix is the prompt context.

tsfix v0.6.0 reads your `package.json` on every Layer-2 invocation. If it sees `vite-plugin-svgr` at v4 or higher in your dependencies, it injects this into the system prompt headline, *before* the model sees the errored file:

```
### library-migrations
- vite-plugin-svgr: v4 requires the `?react` query suffix to import an SVG
  as a React component. `import Logo from "./logo.svg"` returns the asset URL.

### task
Library migration: vite-plugin-svgr
```

That's it. No fine-tuning, no agent loop, no retrieval pipeline. A registry lookup against `package.json` and four lines of prompt.

On our benchmark, the `?react`-migration case goes from **0/3 to 3/3** with this change. The model already knew about `?react`; it just needed permission to override tsc's hint.

The same shape works for other libraries whose major bumps generate confidently wrong tsc fixes: `next@15` (params and searchParams are now Promises and must be awaited), `ai@v3`/`v6` (`generateText` API rewrite), `drizzle-orm` (parameterized template literals, not string concat).

## Why prompt headline, not "more context"

The first version of this lived in `MendContext.featureSpecText` — a freeform Markdown section the model would see somewhere in the middle of the prompt. It did approximately nothing. The model still followed tsc's quick-fix.

Moving the same two sentences to the **headline `taskDescription`** — the first thing after the system instructions and before the file content — flipped the result. Same content, different position, opposite outcome.

This is consistent with what we know about long-context attention falloff and how Claude in particular interprets the "task" framing: the model treats the headline as *what it's actually being asked to do* and weights the rest of the prompt against it. "Library migration: vite-plugin-svgr" is read as "the user knows about this migration; whatever quick-fix tsc is suggesting, the migration is the reason." That single reframing overrides the gravity well of "tsc says X."

## The wider pattern: tsc-correctness ≠ runtime-correctness

Once you start looking for this pattern you see it everywhere LLMs touch typed code:

- `as keyof T` to silence a TS7053 index-signature error when the key is a runtime string — type-passes, throws at runtime when the key isn't actually a property.
- Substituting `crypto.subtle.digest` for a missing `bcrypt` import — type-passes, ships an unsalted hash to production.
- `dangerouslySetInnerHTML` to dodge a children-type mismatch — type-passes, opens an XSS hole.
- Dropping a function call argument to dodge a TS2554 mismatch — type-passes, silently changes the call's behavior.

Every one of these is the same shape: **tsc is a static system reasoning about types; the program is a dynamic system that has to actually work.** A repair that prioritizes the first over the second is the kind of fix that makes the build green and the production page red.

tsfix v0.6.0 has system-prompt rules against all four. They're not magic — the model can still produce a bad fix — but they shift the prior. On our `as keyof T` benchmark case, the fix rate went from 0/3 to 3/3.

## What this means for the field

The next year of LLM coding tools is going to be lived in this gap. Type-check green is necessary but not sufficient. Test pass rate against synthetic test suites is necessary but not sufficient. The tooling has to know the runtime semantics of the libraries the code is using, not just the type signatures.

`detectLibraryMigrations(workspaceRoot, registry?)` is exported as a public API in tsfix v0.6.0 — extend the registry with your own breaking-change hints. Pull requests welcome.

Try it: `npx @shipispec/tsfix --workspace . --llm`. The CLI reads `package.json`, injects hints when they apply, and you can opt out with `--no-library-hints`.

The svgr case is one of four shipping in the built-in registry today. Send PRs for more.

---

**Links**

- npm: <https://www.npmjs.com/package/@shipispec/tsfix>
- Source: <https://github.com/owgreen-dev/tsfix>
- CHANGELOG (v0.6.0): <https://github.com/owgreen-dev/tsfix/blob/main/CHANGELOG.md>

*Word count: ~720. Aim was ~600; trimmed gently.*
