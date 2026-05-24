// Intentionally broken (vite-plugin-svgr v4+ migration).
// tsc's quick-fix wants `import Logo from "./logo.svg"` — that type-checks
// but resolves to the asset URL at runtime, not a component.
// The runtime-correct fix is `import Logo from "./logo.svg?react"`.
import { ReactComponent as Logo } from "./logo.svg";

export function renderLogo() {
	return Logo({ width: 32, height: 32 });
}
