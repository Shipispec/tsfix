# Ralph Guardrails (Signs)

Learned constraints that prevent repeated failures. Each "sign" is a rule discovered through iteration failures. Add new signs as you encounter failure patterns.

> "Progress should persist. Failures should evaporate." - The Ralph philosophy

---

## Verification Signs

### SIGN-001: Verify Before Complete
**Trigger:** About to output completion promise
**Instruction:** ALWAYS run the verification command (`npm run check-types && npm run test && npm run benchmark`) and confirm it passes before outputting `<promise>COMPLETE</promise>`
**Reason:** Models tend to declare victory without proper verification

### SIGN-002: Check All Tasks Before Complete
**Trigger:** Completing a task in multi-task mode
**Instruction:** Re-read prd.json and count remaining `passes: false` tasks. Only output completion promise when ALL tasks pass, not just the current one.
**Reason:** Premature completion exits loop with work remaining

---

## Progress Signs

### SIGN-003: Document Learnings
**Trigger:** Completing any task
**Instruction:** Update progress.md with what was learned (patterns discovered, files modified, decisions made) before ending iteration
**Reason:** Future iterations need context to avoid re-discovering the same patterns

### SIGN-004: Small Focused Changes
**Trigger:** Making changes per iteration
**Instruction:** Keep changes small and focused. Commit incrementally when tests pass. Don't try to solve everything in one iteration.
**Reason:** Large changes are harder to debug when verification fails

---

## Task Management Signs

### SIGN-005: Use Skip for Manual Tasks
**Trigger:** Encountering a task that requires manual human intervention (creating accounts, API keys, dashboard configuration)
**Instruction:** Set `skip: true` and `skipReason` in prd.json for tasks that cannot be automated. The Ralph loop will ignore skipped tasks and can complete without them.
**Reason:** Allows loop to complete automatable work without blocking on manual steps

### SIGN-006: Reference GitHub Issues in Commits
**Trigger:** Committing changes for a prd.json task
**Instruction:** Include `Fixes #N` or `Closes #N` in commit message body (where N is the `github_issue` from prd.json). Format: `fix: description\n\nFixes #61`
**Reason:** Auto-closes GitHub issues when merged to main, maintains traceability

---

## Project-Specific Signs

Add signs below as you encounter project-specific failure patterns:

<!-- Example format:
### SIGN-XXX: [Descriptive Name]
**Trigger:** [When this sign applies]
**Instruction:** [What to do instead]
**Reason:** [Why this matters]
**Added after:** [Iteration N / date when learned]
-->

### SIGN-101: Every New Error Code or Fix Name Needs a Fixture
**Trigger:** Adding to `SAFE_FIXABLE_CODES` / `SAFE_FIX_NAMES`, or supporting a new TS error code anywhere
**Instruction:** Add a fixture under `fixtures/` that exercises it, and confirm `npm run benchmark` covers it. Never widen the safe set without a pin. For a fix path that can *abstain* (judgment call), pin BOTH the success and the abstain — a success fixture (`mustPass:true`, errorsAfter 0) and a report-only abstain pin (`mustPass:false` with `errorsAfterMax`/`lspFixesAppliedMax`, since the harness treats `mustPass:true` as "must reach 0 errors").
**Reason:** The trust model is only as good as its fixtures (ARCHITECTURE.md invariant). Untested fix paths silently corrupt user code; an unpinned abstain path silently over-reaches.
**Added after:** Seed (2026-06-10); abstain-pin clause after the export-from rewriter (2026-06-13: `synthetic-export-from-typo-ts2724` = fix, `synthetic-cross-file-typo-ts2305` = abstain).

### SIGN-102: Never Bundle TypeScript
**Trigger:** Touching the build, the host abstraction, or imports of `typescript` (especially the Phase 3c shared-Program work)
**Instruction:** Keep `typescript` an external peer dep. Layer 0/1 must load the *workspace's* TypeScript via the lib-path workaround. Do not add `typescript` to the esbuild bundle or import a vendored copy.
**Reason:** The whole bet is using the consumer's TypeScript. Bundling our own re-opens the original lib-path bug.
**Added after:** Seed (2026-06-10)

### SIGN-103: No Scope Creep into spectoship2
**Trigger:** Tempted to reference specs, tasks, models, or `ParsedTask`/`ParsedFeatureSpec`
**Instruction:** This package knows only the structural, consumer-agnostic `MendContext`. Keep all domain concepts out.
**Reason:** Guiding constraint #1 — the package must stay usable by anyone, not coupled to the spec pipeline.
**Added after:** Seed (2026-06-10)

### SIGN-104: Don't Use the Paid LLM Benchmark as the Loop Gate
**Trigger:** About to run `npm run benchmark:llm` inside the loop, or add it to verifyCommand
**Instruction:** The loop gate is `check-types && test && benchmark` only. Run `benchmark:llm` manually (needs `ANTHROPIC_API_KEY`, costs money, nondeterministic) when validating Layer 2 changes.
**Reason:** An unattended loop must verify deterministically and for free; paid/flaky gates cause spurious failures and cost.
**Added after:** Seed (2026-06-10)

### SIGN-105: Preserve Diagnostic Output During Refactors
**Trigger:** Refactoring Layer 0/1 internals (e.g., Phase 3c shared Program/host)
**Instruction:** Diagnostics produced before and after must be byte-identical. Add/keep a regression test asserting equality, and confirm `npm run benchmark` stays 14/14 before flipping a task to `passes: true`.
**Reason:** Perf work must not change behavior. The benchmark and diagnostic-equality tests are the safety net.
**Added after:** Seed (2026-06-10)

### SIGN-106: Layer 3 is Prove-Then-Build — Respect the T-4-2 Gate
**Trigger:** Working any Phase 4 Layer-3 build task (T-4-3, T-4-4) after T-4-2
**Instruction:** T-4-2 must first PROVE that per-file iteration cannot converge on the forcing fixture. If T-4-2 concludes the opposite — that `runMendLoop`'s per-file iteration already converges (no forcing function exists) — then do NOT build Layer 3: set T-4-3 and T-4-4 `skip:true` with a `skipReason` pointing at the T-4-2 finding, record "Layer 3 deferred" in `plans/progress.md`, and let the loop complete on the remaining tasks. Never build the multi-file mend before its need is demonstrated.
**Reason:** STATUS.md documents that prior synthetic ripple fixtures converged via iteration. Building Layer 3 speculatively is YAGNI and adds an unproven LLM path. The whole point of Phase 4's design is to build it only if proven necessary.
**Added after:** Phase 4 planning (2026-06-11)

### SIGN-107: Layer 3 Loop Work Must Mock the LLM
**Trigger:** Writing tests or verification for any Layer-3 task (T-4-1..T-4-4)
**Instruction:** The unattended loop builds only the DETERMINISTIC half of Layer 3 — blast-radius via `findReferences`, the prompt builder, multi-file edit application, and wiring. Every test injects a fake LLM via `_callLLM` (as `runFullStack.test.ts` / `mendAgent.test.ts` already do). Never call a real model in the loop. The real paid validation is the manual, skipped T-4-7.
**Reason:** SIGN-104 — the loop gate (`check-types && test && benchmark`) must stay free and deterministic. A real LLM call is nondeterministic, costs money, and would cause spurious loop failures.
**Added after:** Phase 4 planning (2026-06-11)
