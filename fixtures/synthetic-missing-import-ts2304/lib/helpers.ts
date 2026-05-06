// Defines a helper. The consumer in lib/consumer.ts will USE this without
// importing it — TS2304 — and the LSP fixer's auto-import should add the
// import statement.

export function makeGreeting(name: string): string {
	return `hello, ${name}`;
}
