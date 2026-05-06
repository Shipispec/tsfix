// Three TS2552 "Did you mean" typos that the LSP fixer can auto-correct.
// Note: each call site uses an obviously-misspelled global with no
// alternative meaning. The compiler's auto-fix should rename to the
// canonical form (consol→console, JSon→JSON, Promse→Promise).

export function greet(name: string): void {
	consol.log("hello, " + name);
}

export function parse(text: string): unknown {
	return JSon.parse(text);
}

export function delay(ms: number): Promse<void> {
	return new Promse((resolve) => setTimeout(resolve, ms));
}
