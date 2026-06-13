// TS2322: 'classNam' is a typo of the DOM prop 'className'. TypeScript surfaces
// JSX prop typos as TS2322 ("... is not assignable ...") but ALSO offers its
// high-confidence `spelling` did-you-mean code-fix. Admitting TS2322 to
// SAFE_FIXABLE_CODES (gated by SAFE_FIX_NAMES) lets Layer 1 rename it for free —
// a very common React vibe-coding mistake. Real type mismatches offer no fix,
// so the fixer abstains on those (see synthetic / probe notes).

export function App(): JSX.Element {
	return <div classNam="card">hello</div>;
}
