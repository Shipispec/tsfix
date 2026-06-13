// Imports the correct name directly from math.ts so the rename in calc.ts has
// no downstream ripple — keeps the fixture focused on the export-from rewrite.

import { addTwo } from "./math";

export function bump(n: number): number {
	return addTwo(n);
}
