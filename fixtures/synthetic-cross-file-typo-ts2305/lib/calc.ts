// TS2305: math.ts exports 'addTwo', not 'addOne'. The LSP fixer
// should rename the import here (the only edit needed; consumer.ts
// references this file's export, so changing it has no ripple).

export { addOne } from "./math";
