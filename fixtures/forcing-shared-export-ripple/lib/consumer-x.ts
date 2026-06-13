import { bump } from "./shared";

// TS2305: "./shared" has no exported member 'bump'. The semantically correct
// fix is to export `bump` from shared.ts (it must mutate the private
// `counters`); defining a local `bump` here would diverge — a separate, broken
// counter that doesn't share state with consumer-y.
export const x: number = bump("x");
