# forcing-shared-export-ripple — a Layer 3 *limitation* example (not a passing fixture)

This fixture was built during **T-4-7** while trying to prove Layer 3
(multi-file mend) is necessary. It documents a case neither Layer 2 nor Layer 3
can fix — i.e. one arm of the pincer in ARCHITECTURE.md §13's "T-4-7 finding".

**Shape:** `lib/shared.ts` is missing an exported helper `bump` that both
`consumer-x.ts` and `consumer-y.ts` import (2× TS2305). The *correct* fix lives
in `shared.ts`, because a correct `bump` must close over the module-private
`counters` map — a consumer cannot reconstruct it locally without that state.

**Why it's kept (report-only, `mustPass: false`):**

- **Layer 2 can't fix it:** `shared.ts` has no error of its own, so it never
  appears in the error list `runMendLoop` iterates — Layer 2 only ever edits
  errored files, so it can't add the export to `shared.ts`.
- **Layer 3 can't fix it either:** Layer 3's blast radius comes from
  `findReferences()`, but `bump` is *missing* — there's no declaration to trace,
  so `shared.ts` is never pulled into scope. Real-LLM run: `noProgress`.

This is the counterpart to `forcing-multifile-ripple`, where the opposite
happens (Layer 2 fixes it locally and Layer 3 is never needed). Together they
show why no `errorsAfter === 0` fixture forces Layer 3. See ARCHITECTURE.md §13
and `plans/progress.md` (2026-06-13) for the full analysis.

**Do not flip `mustPass` to true** without first re-justifying Layer 3 on
fix-quality grounds (a different eval than error count).
