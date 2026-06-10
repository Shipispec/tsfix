// Real-failure seed (T-3b-3): a captured pattern Layer 0/1 cannot yet auto-fix.
//
// `formatTotal` is declared to return a `number`, but its body returns a
// formatted string. This is a genuine TS2322 type mismatch with NO safe
// quick-fix: nothing can mechanically decide whether the signature or the body
// is the intended contract, so the LSP fixer (Layer 0/1) abstains and the error
// survives. It is committed `mustPass:false` (report-only) until a fix ships —
// see fixtures/REAL.md for the lifecycle.

export interface Money {
	cents: number;
	currency: string;
}

export function formatTotal(items: Money[]): number {
	const totalCents = items.reduce((acc, it) => acc + it.cents, 0);
	return `${(totalCents / 100).toFixed(2)}`;
}
