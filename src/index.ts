/**
 * @shipispec/tsmend — LLM-driven TypeScript error repair.
 *
 * Layer 2–4 companion to @shipispec/tsfix. Pre-release; the public surface
 * grows as Layer 2 lands (planned: `mendSingleFile`, `runMendLoop`,
 * `applyEditBlock`).
 *
 * The package re-exports the contract types from `@shipispec/tsfix` so that
 * downstream consumers can import them from either package interchangeably.
 */

export type { MendContext, LayerEvent, Diagnostic } from "@shipispec/tsfix";

export { getTypeContext, resetTypeContextCache } from "./typeContext.js";
export type { TypeContextOptions, TypeContext } from "./typeContext.js";
