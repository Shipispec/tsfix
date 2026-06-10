# Real-failure fixtures (`fixtures/real-*`)

Synthetic fixtures (`synthetic-*`, `gen-*`, `so-real-*`, `api-drift-*`) cover
patterns we already understand. **Real-failure fixtures capture the patterns we
don't** — broken workspaces snapshotted from actual production runs where
Layer 0/1 failed to fix a TSC error. This is the self-growing half of the test
suite: every unfixed production failure becomes a pinned regression that we can
flip to "must pass" the moment a fix ships.

See ROADMAP.md Phase 3b for the rationale. This document is the format spec.

---

## Directory layout

Each real fixture lives in its own directory named for *when* it was captured
and a short hash of its contents, so two captures of the same bug never collide:

```
fixtures/real-<timestamp>-<hash>/
├── expected.json          # the contract (schema below) — REQUIRED
├── tsconfig.json          # the workspace's tsconfig at capture time — REQUIRED
├── package.json           # deps only (scripts + devDeps stripped) — REQUIRED
├── package-lock.json      # pinned dep tree (node_modules strategy (a)) — REQUIRED
├── setup.sh               # `npm ci` on demand to materialise node_modules
├── README.md              # human notes: what pattern, why it matters
├── <broken source>.ts(x)  # the snapshotted broken files, dir structure preserved
└── node_modules/          # NOT committed — produced by setup.sh (gitignored)
```

- `<timestamp>` is `YYYYMMDD-HHMMSS` (UTC) from capture time.
- `<hash>` is a short (8-char) content hash of the captured source files, so the
  directory name is stable and deterministic for a given broken workspace.
- The benchmark harness discovers any directory containing both `expected.json`
  and `tsconfig.json` (it skips names starting with `_`, e.g. `_shared`). It also
  skips Layer-2 fixtures, which are marked by `costUsdMax` or `expectedErrorCode`
  in their `expected.json`. Real fixtures use neither, so they are discovered by
  the deterministic Layer-0/1 benchmark.

---

## `expected.json` schema

The benchmark harness reads this contract per fixture (`interface Expected` in
`benchmark/run-benchmark.ts`). Real fixtures use the same schema as the
deterministic synthetic fixtures:

| field | type | meaning |
|---|---|---|
| `description` | `string` | One line: what bug pattern this is and why it matters. |
| `errorsBefore` | `number` | TSC error count in the broken snapshot (known at capture). |
| `errorsAfterMax` | `number` | Max errors allowed after tsfix runs. `0` once a fix exists. |
| `lspFixesAppliedMin` | `number?` | Lower bound on Layer-1 fixes expected (optional). |
| `lspFixesAppliedMax` | `number?` | Upper bound on Layer-1 fixes expected (optional). |
| `expectedFixerCodes` | `string[]?` | TS codes the fixer is expected to touch (optional hint). |
| **`mustPass`** | `boolean` | **The gate.** See lifecycle below. |

Real fixtures captured by `scripts/capture-fixture.mjs` additionally carry
provenance/auto-generated fields, which the harness ignores but humans rely on:

| field | meaning |
|---|---|
| `source` | Path the workspace was captured from. |
| `capturedAt` | `YYYY-MM-DD` capture date. |
| `_hint_remainingByCode` | Auto-filled hint: codes still erroring after a dry-run. Refine/remove before committing. |
| `_hint_remainingByFile` | Same, by file. |

> Note: do **not** add `costUsdMax` or `expectedErrorCode` (singular) to a real
> fixture's `expected.json` — those markers route a fixture to the paid Layer-2
> LLM benchmark (`npm run benchmark:llm`) and exclude it from the free,
> deterministic `npm run benchmark` gate that the Ralph loop runs.

---

## `mustPass` lifecycle

A real fixture's whole point is to start *red* and turn *green* when fixed:

1. **Capture → `mustPass: false`.** A new failure mode that Layer 0/1 cannot yet
   fix. It is committed report-only: the benchmark *runs* it and reports the
   outcome, but a non-passing `mustPass:false` fixture does **not** fail the run
   or CI. This lets production-captured failures live in-tree as a backlog
   without blocking the gate. (The report-only path is implemented in T-3b-3.)
2. **A fix ships** (a new safe code, a fixer improvement, a Layer-2 rule).
3. **Flip → `mustPass: true`** and set `errorsAfterMax: 0` (and tighten
   `lspFixesAppliedMin` if the fix is a Layer-1 fix). From here the fixture is a
   hard regression gate: if a later change reintroduces the failure,
   `npm run benchmark` fails.

`mustPass:true` means "tsfix is contractually required to resolve this";
`mustPass:false` means "known-open, tracked, not yet a gate."

---

## `node_modules` strategy

Real failures are **version-specific** — the bug only reproduces against the
exact dependency versions the production workspace had. So the synthetic-fixture
trick of symlinking every fixture's `node_modules` to a single shared
`fixtures/_shared/node_modules` does **not** apply (that shared tree pins one set
of versions for the whole suite).

ROADMAP 3b lists three options; **real fixtures use strategy (a):**

> **(a) Commit broken `.ts(x)` + `package-lock.json` + `setup.sh`.**
> The fixture commits the source snapshot and the *pinned* `package-lock.json`,
> plus a `setup.sh` that runs `npm ci` on demand to materialise `node_modules`
> from that lock. The directory's `node_modules/` itself is **not** committed
> (it is gitignored) — the lockfile is the source of truth.
>
> - **Pro:** smallest commit footprint; exact, reproducible dep tree; no custom
>   tooling.
> - **Con:** slowest CI — one `npm ci` per fixture before it can run. Acceptable
>   for the first 5–10 real fixtures.

A minimal `setup.sh`:

```sh
#!/usr/bin/env sh
# Materialise this fixture's pinned node_modules from package-lock.json.
# Run before benchmarking this fixture for the first time.
set -e
cd "$(dirname "$0")"
npm ci --ignore-scripts --no-audit --no-fund
```

`--ignore-scripts` keeps a captured (untrusted) workspace from running install
hooks; fixtures only need the on-disk `.d.ts`/runtime files, not lifecycle side
effects.

### When to switch strategies

The other two options exist for scale and are deferred until CI install time is
the bottleneck:

- **(b) Content-addressable cache** shared across real fixtures (pnpm-style).
  Smaller disk at scale, but needs custom tooling. Switch to this if/when (a)'s
  per-fixture `npm ci` dominates CI.
- **(c) Snapshot only the specific `.d.ts` files** the failure touches. Smallest
  disk + fastest CI, but loses fidelity if a fix needs to consult a runtime
  export not in the snapshot.

**Recommendation:** stay on (a) until install time hurts, then evaluate (b).

---

## Capturing a real fixture

Use `scripts/capture-fixture.mjs` (see its `--help`). For strategy (a), capture
with the lockfile committed and shared deps off:

```sh
node scripts/capture-fixture.mjs <name> <broken-workspace-path> \
  --no-shared-deps --commit-locked \
  --description "what this bug is and why Layer 0/1 missed it"
```

This writes the skeleton: `tsconfig.json`, stripped `package.json`, the broken
source files, `package-lock.json`, and an auto-generated `expected.json` with
`mustPass` defaulted from the dry-run baseline. Then:

1. Review `expected.json` — refine `description`, confirm `mustPass:false`,
   remove the `_hint_*` fields once you've used them.
2. Add `setup.sh` (above) and confirm `node_modules/` is gitignored.
3. Run `npm run benchmark -- --fixture real-<name>` to confirm it loads and
   reports.
4. Edit `README.md` to explain the pattern.
