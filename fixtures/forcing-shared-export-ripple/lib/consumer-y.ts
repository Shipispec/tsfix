import { bump } from "./shared";

// TS2305: same missing export as consumer-x. Two consumers needing the SAME
// shared symbol is what makes the single-shared-edit fix correct and the
// per-consumer local redefinition obviously wrong (duplicated divergent state).
export const y: number = bump("y");
