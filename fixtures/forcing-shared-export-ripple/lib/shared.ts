// Harder forcing function (T-4-7 attempt 2). The helper `bump` that both
// consumers import is MISSING from this module's exports. The correct fix is to
// add it HERE, because a correct `bump` must close over the module-private
// `counters` map — a consumer cannot reconstruct it locally without access to
// `counters`. shared.ts itself has NO error, so Layer 2 (which only ever edits
// files that appear in the error list) never gets a chance to edit it. Only a
// blast-radius-aware Layer 3 brings shared.ts into scope.

const counters = new Map<string, number>();

export type Slot = "x" | "y";

// MISSING — this is the bug:
//   export function bump(slot: Slot): number {
//     const next = (counters.get(slot) ?? 0) + 1;
//     counters.set(slot, next);
//     return next;
//   }

// Keep `counters` referenced so it isn't a TS6133 unused error on its own.
export function snapshot(): number {
	return counters.size;
}
