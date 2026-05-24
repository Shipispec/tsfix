// Package B uses package A via project reference, plus has its own
// canonical TS2552 typo for the fixer to catch.
import { greet } from "../../a/src/index.js";

export function shout(name: string): void {
	consol.log(greet(name).toUpperCase());
}
