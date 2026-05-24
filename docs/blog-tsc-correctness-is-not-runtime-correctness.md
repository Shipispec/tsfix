# tsc-correctness ≠ runtime-correctness

*Published with tsfix v0.6.2, 2026-05-24.*

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

## The same gap, with worse consequences

The svgr case is the easy version of the failure mode: a crashed dev server is loud, immediate, and obviously broken. Move the same dynamic into security territory and the failure goes quiet.

**Case 1 — `dangerouslySetInnerHTML` as a children-type escape hatch.** An LLM is asked to render some user-controlled HTML in a React component. The component signature says `children: string`, the input is an HTML string, tsc complains. The path of least resistance — and one I've seen models take — is to switch the rendering to `dangerouslySetInnerHTML={{ __html: input }}`. The error vanishes. The XSS hole opens. Same three-character collision: React's type system *correctly* warns that an HTML string isn't a React node; tsc enforces it; the LLM picks the dodge that makes the type-checker happy. The runtime-correct fix is to render the text as JSX (`{input}` auto-escapes) or sanitize via DOMPurify before mounting. The type system has no way to know which of those you wanted.

**Case 2 — substituting `crypto.subtle.digest` for a missing `bcrypt` import.** A repo's `package.json` lists `bcrypt`; the source imports it; an LLM-generated refactor accidentally removes the import line. tsc emits `Cannot find name 'bcrypt'. Did you mean 'crypto'?` — and the LLM dutifully takes the suggestion, switching `bcrypt.hash(password, 10)` to `crypto.subtle.digest("SHA-256", encoder.encode(password))`. tsc is happy. The code compiles. An unsalted, un-adaptive SHA-256 of every user password is now shipping to production. Every detail of tsc's reasoning was correct — `crypto` *is* the closest in-scope identifier, and SHA-256 *does* return a digest — but the runtime semantics are catastrophically different from a salted, adaptive-cost password hash.

Both cases are the same shape as svgr, just with stakes that get someone fired instead of a broken page reload. **tsc is a static system reasoning about types; the program is a dynamic system that has to actually work.** A repair that prioritizes the first over the second is the kind of fix that makes the build green and the security report red.

tsfix v0.6.0 added explicit prompt-level rules against both of these (plus `as keyof T` to silence index-signature errors, and dropping arguments to silence TS2554). They're not magic — the model can still produce a bad fix — but they shift the prior. Across the bench, the cases that exercise these patterns went from 0/3 to 3/3 functional-and-secure.

## The bet I'm making

The next moat in LLM coding tools is not on the model side. The frontier-model gap has narrowed to weeks at best; everyone codes against the same three providers. The moat is on the **structured-knowledge side** — the layer that injects the things a model trained on five years of mixed-version code cannot reliably know: which libraries broke, in which versions, with which migration. Library-migration registries are one form. Framework-version-aware refactoring is another. Security-pattern recognition is a third.

These are unsexy databases of "this is wrong now, do that instead," extended one entry at a time by humans who hit the failure mode and submitted a fix. The first project to ship a registry serious enough to embed into Cursor / Claude Code / Continue.dev / Cline as a sub-component wins the **post-generation correctness** category. That's the integration that touches every one of those tools' users, every codegen pass, every day. It compounds: every new library entry makes your tool relatively more useful versus every alternative.

We've open-sourced our registry under MIT. It currently knows about `vite-plugin-svgr` v4, `next` v15, the Vercel AI SDK v3, and `drizzle-orm`. Four entries is a starting line, not a finish line. The interesting thing is that adding the fifth, sixth, and hundredth entries is *exactly* the kind of contribution this codebase is structured to receive — see `src/libraryMigrations.ts`, the registry-extension guide in `CONTRIBUTING.md`, and the pinned discussion *"Which library should the migration registry cover next?"*

## Try it

```bash
npx @shipispec/tsfix --workspace . --llm
```

On the first run, Layer 0/1 clears the trivial errors deterministically (typos, missing imports — no LLM, no network, no cost). Layer 2 takes whatever's left, with library hints firing automatically when one of the four currently-registered packages is in your `package.json`. You'll see a per-error tally, per-iteration token / cost numbers, and either `stopReason=fixed` or a list of remaining errors. Layer 0/1 by itself needs no API key. Layer 2 needs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY` — your choice via `--llm-provider`.

If your stack hits one of the patterns above and tsfix doesn't yet know about it, the registry-suggestion issue template is the fastest path to making sure no one else in your category hits it again.

---

**Links**

- npm: <https://www.npmjs.com/package/@shipispec/tsfix>
- Source: <https://github.com/owgreen-dev/tsfix>
- CHANGELOG: <https://github.com/owgreen-dev/tsfix/blob/main/CHANGELOG.md>
- Library-migration registry: <https://github.com/owgreen-dev/tsfix/blob/main/src/libraryMigrations.ts>
- "Which library next?" discussion: <https://github.com/owgreen-dev/tsfix/discussions>
