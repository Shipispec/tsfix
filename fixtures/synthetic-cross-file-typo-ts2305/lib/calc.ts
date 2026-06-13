// TS2305: math.ts exports 'addTwo', not 'addOne'. 'addOne' is edit distance 3
// from 'addTwo' — beyond TS's did-you-mean threshold — so it's a wrong-name,
// not a typo. The export-from rewriter MUST abstain (leave it for Layer 2);
// renaming 'addOne' -> 'addTwo' would silently change intent.

export { addOne } from "./math";
