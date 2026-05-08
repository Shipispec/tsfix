/**
 * @shipispec/tsmend — LLM-driven TypeScript error repair.
 *
 * Layer 2–4 companion to @shipispec/tsfix. Pre-release; the public surface
 * below is empty until the Layer 2 implementation lands (planned exports:
 * `mendSingleFile`, `runMendLoop`, `getTypeContext`, `applyEditBlock`).
 *
 * The package re-exports the contract types from `@shipispec/tsfix` so that
 * downstream consumers can import them from either package interchangeably.
 */

export type { MendContext, LayerEvent, Diagnostic } from "@shipispec/tsfix";
