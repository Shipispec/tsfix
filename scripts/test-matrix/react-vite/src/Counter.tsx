// Vite-style React TSX. Two TS2552 typos.
//   `consol.log(...)` → `console.log(...)`
//   `wndow.location` → `window.location`
import { useState } from "react";

export function Counter(): JSX.Element {
	const [n, setN] = useState(0);
	consol.log("counter render", n);
	const url = wndow.location.href;
	return <button onClick={() => setN(n + 1)}>{n} {url}</button>;
}
