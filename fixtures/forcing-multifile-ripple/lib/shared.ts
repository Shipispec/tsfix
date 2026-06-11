// The single contested declaration. Two consumers (consumer-num.ts and
// consumer-str.ts) constrain `Value` to INCOMPATIBLE types: one needs it to be
// `number` (arithmetic), the other needs it to be `string` (.toUpperCase()).
//
// No single-file fix can satisfy both. A greedy per-file fixer that responds to
// each error by retyping this shared declaration toward the erroring consumer
// will OSCILLATE forever: make it `number` → consumer-str breaks; make it
// `string` → consumer-num breaks. Only a coordinated multi-file mend (Layer 3)
// that sees BOTH consumers at once and inserts the right conversions can
// converge. This is the forcing function T-4-2 proves (SIGN-106).
//
// `declare const` (no initializer) so flipping `Value`'s type never makes THIS
// file error — the contradiction lives purely in the two consumers, which is
// what makes the oscillation clean and observable.
export type Value = string;
export declare const value: Value;
