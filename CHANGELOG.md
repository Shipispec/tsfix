# Changelog

All notable changes to `@shipispec/tsmend` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Pre-release. Not yet on npm.

### Bootstrap (2026-05-07)
- Repository created at https://github.com/owgreen-dev/tsmend
- Initial scaffolding: `package.json` (private, version 0.0.1), `tsconfig.json`, CI workflow at `.github/workflows/test.yml`, placeholder `src/index.ts` re-exporting the contract types from `@shipispec/tsfix`.
- Depends on `@shipispec/tsfix ^0.3.0` (which exports `MendContext`, `LayerEvent`, `Diagnostic` types) plus `@ai-sdk/anthropic ^3.0.44` and `ai ^6.0.86` (Vercel AI SDK v6) for LLM calls.

### Planned for v0.1.0 (Layer 2 — single-file LLM mend)
- `getTypeContext(opts)` — TS Language Service helper. Resolves an error site to its declaring type via `getTypeAtLocation()` + `getDeclarations()`. The architectural moat — no other OSS tool does this for TS.
- `mendSingleFile(opts)` — single-LLM repair using Vercel AI SDK with Anthropic prompt caching. Single-file scope.
- `applyEditBlock(opts)` — SEARCH/REPLACE patch parser + applier. Aider's `editblock` format with fuzzy match (exact → rstrip → strip).
- `runMendLoop(opts)` — bounded retry (default 3 iterations) with no-progress detection (signature-set comparison).
- Three "Layer 0 cannot fix, Layer 2 should fix" fixtures: TS2339, TS7006, TS2741.

[Unreleased]: https://github.com/owgreen-dev/tsmend/compare/HEAD...HEAD
