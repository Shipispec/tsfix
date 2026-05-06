// LLMs typo hook names constantly. The compiler emits TS2305
// "Module 'react' has no exported member 'ueState'" plus a
// did-you-mean for 'useState'. The LSP fixer should rename it.

import { ueState } from "react";

export function counter(): readonly [number, (n: number) => void] {
	const [n, setN] = ueState(0);
	return [n, setN];
}
