// Two TS2551 property typos. The compiler knows the right name
// (".length", ".toUpperCase") because of "Did you mean Y", but our
// LSP fixer's SAFE_FIXABLE_CODES does not currently include 2551.
// This fixture documents that boundary — flip the expectation if
// we widen the safe set.

export function describe(items: string[]): string {
	const n = items.lenght;
	return `${n} item(s): ` + items.map((s) => s.toUperCase()).join(", ");
}
