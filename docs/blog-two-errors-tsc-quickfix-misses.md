# Two TypeScript errors your AI coder makes that tsc's own Quick Fix won't fix

*Draft — to publish with tsfix v0.7.x. Companion to [tsc-correctness ≠ runtime-correctness](https://dev.to/oscar_green_2836be55d3b02/tsc-correctness-runtime-correctness-3ol5).*

VS Code's "Quick Fix" lightbulb is quietly one of the best things about TypeScript. Behind it is the TS Language Service's code-fix engine: type a name slightly wrong, and tsc both *tells you* the right one and *offers the edit*. Most LLM code-repair loops lean on exactly this — run `tsc --noEmit`, apply the suggested fix, move on. It's free, deterministic, and right far more often than an LLM guessing.

But the Quick Fix engine has blind spots. And because AI coders generate a *lot* of boilerplate — barrel files, re-export hubs, React components — they hit those blind spots constantly. Here are two where tsc clearly knows the answer but won't hand you the edit, so the error sails past the cheap deterministic layer and into your (paid, slower, probabilistic) LLM repair step — or worse, into your PR.

## Blind spot #1: the typo'd re-export

You've seen tsc fix this for an `import`:

```ts
// utils.ts exports `getUserEmail`
import { getUserEmial } from "./utils";
//       ^^^^^^^^^^^^ TS2724: did you mean 'getUserEmail'?
```

Your editor offers the rename. One click, done. Now write the *exact same typo* in a re-export — the thing every `index.ts` barrel file is made of:

```ts
export { getUserEmial } from "./utils";
//       ^^^^^^^^^^^^ TS2724: did you mean 'getUserEmail'?
```

Same error code. Same "did you mean" message — tsc has *already computed the answer*. But ask the Language Service for a code-fix at that position and you get back… nothing. An empty array. The Quick Fix lightbulb never appears, and any tool that relies on `getCodeFixesAtPosition` (most of them) has nothing to apply.

It's a genuine asymmetry in the compiler: the `import` form gets a fix, the `export … from` form doesn't. Generated barrel files are *full* of re-exports, so this is not a rare case in codegen output — it's a recurring one.

## Blind spot #2: the JSX prop typo

```tsx
export function Card() {
  return <div classNam="card">…</div>;
  //          ^^^^^^^^ TS2322
}
```

`classNam` is an obvious typo of `className`, and tsc *does* offer a `spelling` code-fix here. So why does it slip through? Because it surfaces as **TS2322 — "Type … is not assignable to type …"**, the broad, scary type-mismatch code. Repair loops (sensibly) treat TS2322 as "needs semantic reasoning, send it to the LLM," because the *vast majority* of TS2322s are real type errors with no safe mechanical fix:

```ts
const n: number = "hello";   // TS2322 — no code-fix; genuinely needs a human/LLM
```

So the one TS2322 that *is* a trivial deterministic fix — the prop typo — gets lumped in with the ones that aren't, and pays the LLM tax (or doesn't get fixed at all). React-heavy AI output produces these all day.

## Fixing both deterministically — without re-implementing tsc

[tsfix](https://github.com/shipispec/tsfix) v0.7.0 closes both, in the free, no-network, no-API-key deterministic layer:

- **Re-export typos.** When the Quick Fix engine returns nothing for a `export { X } from "./mod"` error, tsfix resolves the target module's real exports via the TypeChecker and renames `X` to the closest one — but *only within TypeScript's own did-you-mean threshold* (`distance < floor(len·0.4)+1`). It doesn't re-implement tsc's fix engine; it reuses tsc's exact spelling cutoff, so it's never more aggressive than the compiler would be. A far-off wrong-name (`getEmail` vs `getUserEmail`) is *not* a typo — tsfix abstains and lets it escalate.
- **JSX prop typos.** tsfix admits TS2322 to its fixable set but gates it behind the already-trusted `spelling` fix name. The prop typo (which carries a `spelling` fix) gets renamed; the `number = "hello"` mismatch (which carries *no* fix) is left untouched. Real type errors never get mechanically rewritten.

The whole design rule is **abstain when unsure**. On a worked example — a workspace with a typo'd re-export, a typo'd JSX prop, and an ordinary name typo — the previously-published version fixed 1 of 3 and left the two above; v0.7.0 fixes all 3, deterministically, before any LLM is involved.

```bash
npx @shipispec/tsfix --workspace .        # free, deterministic, no key
```

## Why this matters beyond two error codes

These two are small. The point they illustrate isn't: **a lot of "AI coding repair" doesn't need an LLM at all.** The Quick Fix engine already solves a huge fraction of generated-code errors for free — and where it has blind spots, you can often fill them deterministically by borrowing tsc's *own* heuristics rather than guessing. That keeps the LLM (and its cost, latency, and occasional confident wrongness) for the errors that genuinely need judgment.

The harder, more interesting half of that story — where tsc gives you a fix that's *wrong at runtime* because it doesn't know your installed library versions — is in the companion post: [tsc-correctness ≠ runtime-correctness](https://dev.to/oscar_green_2836be55d3b02/tsc-correctness-runtime-correctness-3ol5).

tsfix is MIT, BYOK for the LLM layer, and the deterministic layer needs no key: [github.com/shipispec/tsfix](https://github.com/shipispec/tsfix).

---

*Tags: typescript, ai, webdev, opensource*
