// Two TS7006 errors (implicit any on params). The LSP fixer's
// inferAny code-action would guess types, but its guess is often
// wrong (e.g. `unknown` when the user meant a domain interface).
// Documented: do not auto-fix; let the LLM mend-agent handle it.

export function mapItems(items, fn) {
	return items.map(fn);
}

export function reduceItems(items, fn) {
	return items.reduce(fn, 0);
}
