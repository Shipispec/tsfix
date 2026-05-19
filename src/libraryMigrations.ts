/**
 * Library breaking-change registry for Layer 2.
 *
 * When an installed dependency has a known migration whose correct fix
 * differs from tsc's own quick-fix suggestion, this module injects a hint
 * into the mend prompt so the LLM doesn't blindly follow tsc.
 *
 * Empirically grounded — each entry corresponds to a concrete bench case
 * where, without the hint, both haiku-4-5 and sonnet-4-5 score 0/3
 * functional+secure and follow tsc's misleading quick-fix; with the hint,
 * both score 3/3 functional+secure on the same fixture.
 *
 * Scope: library MIGRATIONS where tsc's quick-fix is misleading or where
 * the correct fix requires syntax not present in the source. NOT for
 * general TS errors — those are tsfix's deterministic Layer 0/1 surface.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface LibraryMigrationHint {
	/** Display name, e.g., `"vite-plugin-svgr@^4.0.0"`. Populated by detect. */
	name: string;
	/** Instructional text injected into the Layer 2 system prompt. */
	hint: string;
}

interface RegistryEntry {
	match: {
		name: string;
		minMajor?: number;
		maxMajor?: number;
	};
	hint: string;
}

/**
 * Built-in registry. Keep entries SMALL — only patterns where we have
 * empirical evidence that the model picks the wrong fix without the hint.
 * Don't lard this up with general advice; that belongs in the system prompt.
 */
export const BUILT_IN_LIBRARY_MIGRATIONS: RegistryEntry[] = [
	{
		match: { name: "vite-plugin-svgr", minMajor: 4 },
		hint:
			"vite-plugin-svgr v4+ (released 2023-09-20) changed how SVG imports work. " +
			"The PREVIOUS form `import { ReactComponent as X } from './x.svg'` no longer works — " +
			"the ambient module declaration now only matches `*.svg?react`. " +
			"Correct fix: `import X from './x.svg?react'` (default import + ?react query suffix). " +
			"DO NOT use tsc's quick-fix `import X from './x.svg'` (no query) — that type-checks " +
			"but resolves to the asset URL string at runtime, not a component.",
	},
	{
		match: { name: "next", minMajor: 15 },
		hint:
			"Next.js 15 changed dynamic-route page props: `params` and `searchParams` are now " +
			"`Promise<...>` instead of plain objects. The fix shape is: change the page's `params` " +
			"type to `Promise<{...}>`, mark the page component `async`, and `await params` inside. " +
			"See https://nextjs.org/docs/app/api-reference/file-conventions/page.",
	},
	{
		match: { name: "ai", minMajor: 3, maxMajor: 4 },
		hint:
			"Vercel AI SDK v3.x has overload-narrowing issues with `generateObject`. If passing a " +
			"schema through an object widened with `satisfies Record<K, z.ZodTypeAny>`, the typed " +
			"overload silently falls back to `output: 'no-schema'` (which forbids the `schema` " +
			"property). Fix: drop the `satisfies Record<...>` widener, or cast the schema at the " +
			"call site.",
	},
	{
		match: { name: "drizzle-orm" },
		hint:
			"Drizzle ORM table access has two distinct surfaces. `db.<table>` is for " +
			"`select/insert/update/delete` builders. `db.query.<table>` is the Relational Queries " +
			"API for `findFirst`/`findMany` with relation loading. If you see " +
			"`Property '<table>' does not exist on type 'PostgresJsDatabase<...>'` when trying to " +
			"call `.findFirst`/`.findMany`, use `db.query.<table>` instead.",
	},
];

/**
 * Match a dep's version-spec string (e.g., "^4.0.0", "~4.0.0", "4.0.0",
 * "4") and return the major-version number, or null if unparseable.
 */
function parseMajor(spec: string): number | null {
	const m = spec.match(/(\d+)(?:\.\d+)*/);
	return m ? parseInt(m[1], 10) : null;
}

/**
 * Read the workspace's package.json, walk dependencies + devDependencies,
 * return the registry entries whose match rule fires.
 *
 * Best-effort: returns `[]` on any failure (missing package.json, parse
 * error, etc.). Never throws.
 */
export function detectLibraryMigrations(
	workspaceRoot: string,
	registry: RegistryEntry[] = BUILT_IN_LIBRARY_MIGRATIONS,
): LibraryMigrationHint[] {
	let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	try {
		const pkgPath = path.join(workspaceRoot, "package.json");
		if (!fs.existsSync(pkgPath)) return [];
		pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
	} catch {
		return [];
	}

	const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	const hints: LibraryMigrationHint[] = [];
	for (const entry of registry) {
		const { match, hint } = entry;
		const versionSpec = allDeps[match.name];
		if (!versionSpec) continue;
		const major = parseMajor(versionSpec);
		if (match.minMajor != null && (major == null || major < match.minMajor)) continue;
		if (match.maxMajor != null && (major == null || major > match.maxMajor)) continue;
		hints.push({ name: `${match.name}@${versionSpec}`, hint });
	}
	return hints;
}

/**
 * Format an array of hints into a prompt block. Empty input → empty string,
 * caller can short-circuit.
 */
export function formatLibraryMigrationsBlock(hints: LibraryMigrationHint[]): string {
	if (hints.length === 0) return "";
	const lines = ["### library-migrations", ""];
	lines.push(
		"These migrations apply to your workspace's installed deps. When tsc's quick-fix " +
			"conflicts with the migration target below, PREFER the migration target. tsc only " +
			"checks types, not runtime semantics — these hints encode runtime constraints tsc " +
			"cannot see.",
	);
	lines.push("");
	for (const h of hints) {
		lines.push(`- [${h.name}] ${h.hint}`);
	}
	return lines.join("\n");
}

/**
 * Build the one-line task description from a list of hints. Empty input
 * → undefined. We've found that putting library names in the
 * `taskDescription` (the prompt's headline framing) is dramatically more
 * effective than burying the same content in the body.
 */
export function formatLibraryMigrationsTaskDescription(
	hints: LibraryMigrationHint[],
): string | undefined {
	if (hints.length === 0) return undefined;
	const names = hints.map((h) => h.name).join(", ");
	return `Library migration: ${names}`;
}
