// TS2724: math.ts exports 'addTwo'; this re-export has a fat-finger typo
// ('addTwoo', edit distance 1), so TS emits "Did you mean 'addTwo'?" — but
// provides NO applyable code-fix for the `export { X } from "..."` form. Layer
// 1's export-from rewriter handles it: a unique close match within TS's own
// spelling threshold is renamed deterministically (no LLM).

export { addTwoo } from "./math";
