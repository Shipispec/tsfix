# forcing-multifile-ripple

The **forcing function** for Phase 4 / Layer 3 (multi-file LLM mend). Its job is
to be a cross-file ripple that a greedy *per-file* fixer provably **cannot**
converge on — the honest gate for prove-then-build (SIGN-106, task T-4-2).

## The contradiction

`lib/shared.ts` declares a single contested type:

```ts
export type Value = string;
export declare const value: Value;
```

Two consumers constrain `Value` to **incompatible** types:

| File | Uses `value` as | Error when `Value` is the *other* type |
|---|---|---|
| `lib/consumer-num.ts` | `number` (`value * 2`) | `TS2362` while `Value = string` |
| `lib/consumer-str.ts` | `string` (`value.toUpperCase()`) | `TS2339` while `Value = number` |

`shared.ts` uses `declare const` (no initializer), so flipping `Value`'s type
never makes *that* file error — the contradiction lives purely in the two
consumers, which keeps the oscillation clean and observable.

## Why per-file iteration can't converge

The locally-obvious single-file response to each error is to retype the shared
declaration toward the erroring consumer. That greedy fixer walks a 2-cycle and
never empties the diagnostic set:

```
Value = string  →  { consumer-num.ts : TS2362 }   (fix → set Value = number)
Value = number  →  { consumer-str.ts : TS2339 }   (fix → set Value = string)
Value = string  →  { consumer-num.ts : TS2362 }   ← back to the start
```

No single-file edit satisfies both consumers. Only a **coordinated multi-file
mend** — one that sees both consumers at once and inserts the right conversions
at each site (Layer 3) — can drive this to zero. The deterministic proof of the
oscillation lives in `src/multiFileMend.test.ts`.

## Status

`mustPass: false` (report-only, non-gating per T-3b-3). Layers 0/1 have no safe
quick-fix for these type errors, so the mend loop abstains and **1** error
survives — which is exactly `errorsAfterMax`. The fixture flips to
`mustPass: true` only once a real LLM Layer-3 pass resolves it (the manual,
paid T-4-7 step).
