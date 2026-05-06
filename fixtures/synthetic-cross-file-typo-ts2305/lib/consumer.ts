// Imports the correct name directly from math.ts so the rename in
// calc.ts has no downstream effect — keeps this fixture focused on
// the export-from rename behavior.

import { addTwo } from "./math";

export function bump(n: number): number {
	return addTwo(n);
}
