# tsfix GitHub Action

Run tsfix as a CI gate — catch (and optionally repair) the TypeScript errors an
AI coder or codegen step leaves behind, before they merge.

The action is a thin wrapper around the published CLI (`npx @shipispec/tsfix`).
It runs **after your dependency install step** (it uses the workspace's own
`typescript`), captures the JSON report as step outputs, writes a job summary,
and fails the step when errors remain (configurable).

## Quick start — deterministic only (free, no key)

```yaml
name: typecheck
on: [pull_request]
jobs:
  tsfix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci            # tsfix uses YOUR installed typescript
      - uses: shipispec/tsfix@main   # see "Pinning" below
        with:
          workspace: .
```

The step fails if any errors survive the deterministic Layer 0/1 pass.

## With LLM mend (opt-in, BYOK)

```yaml
      - uses: shipispec/tsfix@main
        with:
          workspace: .
          llm: true
          llm-provider: anthropic   # or openai | google
          llm-budget-usd: '0.50'    # soft cap; step fails (exit 3) if exceeded
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Report-only (don't fail the build, just surface results)

```yaml
      - id: tsfix
        uses: shipispec/tsfix@main
        with:
          workspace: .
          fail-on-error: 'false'
      - run: echo "fixed ${{ steps.tsfix.outputs.fixes-applied }}, ${{ steps.tsfix.outputs.errors-after }} remain"
```

## Inputs

| input | default | description |
|---|---|---|
| `workspace` | `.` | Path to the workspace (must contain `tsconfig.json`). |
| `files` | (all) | Comma-separated files to scope to. |
| `llm` | `false` | Enable Layer 2 LLM mend on surviving errors (needs a provider key in `env`). |
| `llm-provider` | `anthropic` | `anthropic` \| `openai` \| `google`. |
| `llm-model` | (per provider) | Override the model. |
| `llm-budget-usd` | (none) | Soft USD cap; the run exits non-zero if exceeded. |
| `version` | `latest` | tsfix version / npm dist-tag to run. |
| `fail-on-error` | `true` | Fail the step when errors remain. `false` = report-only. |

## Outputs

| output | description |
|---|---|
| `errors-before` | Error count before any fix. |
| `errors-after` | Error count after all enabled layers. |
| `fixes-applied` | Deterministic (Layer 1) fixes applied. |
| `passed` | `"true"` if zero errors remain. |

## Pinning

The action lives at the repo root (`action.yml`). It was added after the
`v0.7.1` release, so:

- `@main` — always the latest action (fine for trying it out).
- Pin to a **release tag at or after the next version** (e.g. `@v0.7.2`) for a
  stable, immutable ref once it ships.
- For supply-chain-strict setups, pin to the commit SHA.

(`version:` controls which *published CLI* runs; the action ref controls the
*wrapper* — they're independent.)

## Notes

- Run the action **after** `npm ci` / your install step — tsfix repairs against
  the workspace's installed `typescript` (the whole bet), not a bundled copy.
- The deterministic path makes **no network calls** and needs no key. Layer 2 is
  opt-in and only runs when `llm: true` and the matching key is present.
