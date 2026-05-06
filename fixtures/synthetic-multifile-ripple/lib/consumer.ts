// Three typos resolved in three iterations:
// Iter 1: TS2724 'Greater' → 'Greeter' (import name).
// Iter 2: TS2552 'Greater' → 'Greeter' (type annotation site, only fixable
//         once the import is renamed). While `Greater` is undefined,
//         `g`'s type is `any`, so iter 3 is invisible.
// Iter 3: TS2551 'greetNam' → 'greetName' (method spelling fix), only
//         visible once `g` has type `Greeter`.

import { Greater } from "./types";

export function greet(g: Greater): string {
	return g.greetNam("alice");
}
