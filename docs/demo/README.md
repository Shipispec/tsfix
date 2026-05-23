# tsfix demo

A reproducible recording of the vite-plugin-svgr `?react` case — the strongest single-fixture demonstration of *"tsc-correctness ≠ runtime-correctness"* — recorded with [Charm vhs](https://github.com/charmbracelet/vhs).

## What it shows

A 15-ish-second terminal recording:

1. The broken `src/Header.ts` imports `{ ReactComponent as Logo } from "./logo.svg"`.
2. `npx tsc --noEmit` fails with `TS2614` and **suggests the wrong fix in its own error message** (`"Did you mean to use 'import ReactComponent from "*.svg"' instead?"`).
3. `npx @shipispec/tsfix --workspace . --llm` runs in ~2 seconds for ~$0.002 and emits the **runtime-correct fix**: `import Logo from "./logo.svg?react"`.
4. `npx tsc --noEmit` exits clean.

The point: tsc's quick-fix would type-check while breaking the dev server (the default import resolves to the asset URL string under vite-plugin-svgr v4, not a component). tsfix reads `package.json`, sees `vite-plugin-svgr@^4`, injects the migration hint, and the LLM picks the runtime-correct form.

## Recording prerequisites

- [Charm vhs](https://github.com/charmbracelet/vhs) installed (`brew install vhs` on macOS).
- An Anthropic API key exported in the shell that runs `vhs`:

  ```bash
  export ANTHROPIC_API_KEY=sk-ant-...
  ```

- One-time fixture install (the `.tape` script doesn't `npm install` so the recording stays clean):

  ```bash
  cd fixture
  npm install
  cd ..
  ```

## Record

From this directory:

```bash
vhs demo.tape
```

Output: `demo.gif`. Reference it from the top of the project `README.md` (the placeholder comment marks the slot).

## Re-recording

The `.tape` script restores the broken `src/Header.ts` from git before each take, so you can re-run `vhs demo.tape` as many times as you want without manually resetting the fixture. (Commit any local changes first, otherwise the `git checkout` is a no-op.)

## What's in the fixture

```
fixture/
  package.json      — declares vite-plugin-svgr@^4 (triggers the library-migration registry)
  tsconfig.json     — strict, ES2022, bundler resolution
  src/
    svg-types.d.ts  — the v4 ambient: *.svg?react = component, *.svg = URL
    logo.svg        — a tiny circle so the import resolves
    Header.ts       — the broken file (intentional TS2614)
```

The fixture is deliberately the smallest possible reproduction of the failure mode — no React, no JSX, no Vite config. Just enough to make tsc emit TS2614 with its misleading quick-fix.
