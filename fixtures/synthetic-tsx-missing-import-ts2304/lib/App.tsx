// TS2304: 'useState' is used without an import. Layer 1's auto-import resolves
// it from 'react' (available via @types/react). This pins that the deterministic
// fixer works on .tsx files and finds the @types/react fallback — previously
// unpinned (no .tsx fixtures existed).

export function Counter(): JSX.Element {
	const [n, setN] = useState(0);
	return <button onClick={() => setN(n + 1)}>{n}</button>;
}
