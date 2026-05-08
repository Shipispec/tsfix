# tsmend

> LLM-driven TypeScript error repair. Layer 2–4 companion to [@shipispec/tsfix](https://github.com/owgreen-dev/tsfix).

**Status:** Pre-release. Not yet on npm. Layer 2 (single-file LLM mend) targets v0.1.0.

## What this is

[`@shipispec/tsfix`](https://github.com/owgreen-dev/tsfix) deterministically fixes ~56% of TypeScript errors in LLM-generated code (TS2304, TS2305, TS2551, TS2552, TS2724) via the TypeScript Language Service's `getCodeFixesAtPosition`. The remaining 44% are semantic errors that LLMs solve well and deterministic code can't:

- **TS2339** — property does not exist on type
- **TS7006** — parameter implicitly has 'any' type
- **TS2741** — missing required property
- **Cross-file TS2305** — `export { X } from "./mod"` typos that the language service won't fix
- **API drift** — installed package doesn't match the version the LLM was trained on

`@shipispec/tsmend` is the LLM layer that handles those.

## Architecture

The two packages share a public contract via types exported from `@shipispec/tsfix` v0.3.0+:

- `MendContext` — input to a mend agent (workspace + diagnostics + optional spec/task context)
- `LayerEvent` — per-layer event for streaming telemetry
- `Diagnostic` — single tsc error

```
Layer 0 — Prevention      (prompt rules, exported-API injection — your problem)
Layer 1 — tsfix           (deterministic LSP auto-fix)
─────────────────────────────────────────────────────────────────────────
Layer 2 — tsmend (single-file LLM mend, planned v0.1.0)
Layer 3 — tsmend (multi-file LLM mend via findReferences, planned v0.2.0)
Layer 4 — tsmend (stub-and-continue escape hatch, planned v0.3.0)
```

## Differentiator

Every other LLM-driven code repair tool (Aider, Cline, Cursor, OpenHands, bolt.diy) uses generic grep or repo-maps to assemble context. `tsmend` calls the TypeScript Language Service's `getTypeAtLocation()` + `getDeclarations()` to inject the *exact* type definition into the LLM prompt. This is the architectural moat.

## Planned API (not yet implemented)

```ts
import { runMendLoop } from "@shipispec/tsmend";
import { runValidationLoop } from "@shipispec/tsfix";

// Layer 0/1
const tsfixResult = runValidationLoop({ workspaceRoot: "..." });

// Layer 2-4 if anything survived
if (tsfixResult.errorsAfter > 0) {
  const mendResult = await runMendLoop({
    context: {
      workspaceRoot: "...",
      diagnostics: tsfixResult.diagnostics.filter((d) => d.category === "error"),
      erroredFiles: Object.keys(tsfixResult.remainingByFile),
    },
    llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: process.env.ANTHROPIC_API_KEY! },
    maxIterations: 3,
  });
  console.log(mendResult.diagnosticsAfter);
}
```

## License

MIT.
