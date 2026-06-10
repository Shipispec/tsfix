#!/usr/bin/env node
/**
 * Capture a real (or realistic) broken workspace into a real-failure fixture
 * under `fixtures/real-<timestamp>-<hash>/` (see fixtures/REAL.md for the spec).
 *
 * Usage:
 *   node scripts/capture-fixture.mjs <broken-workspace-path> [opts]
 *
 *   --description "..."     — short text for expected.json#description
 *   --include "<glob>,..."  — extra glob patterns to capture beyond src/**
 *   --shared-deps           — link node_modules to ../_shared/node_modules
 *                             (turn off with --no-shared-deps to snapshot a
 *                             specific package-lock.json instead — strategy (a))
 *   --commit-locked         — also copy package-lock.json into the fixture
 *
 * Real failures are version-specific, so the default real-fixture recipe is
 * `--no-shared-deps --commit-locked` (strategy (a) in fixtures/REAL.md): commit
 * the broken source + the pinned `package-lock.json` + a `setup.sh` that runs
 * `npm ci` on demand; the materialised `node_modules/` itself stays gitignored.
 *
 * Captures (relative to <broken-workspace-path>):
 *   - tsconfig.json
 *   - package.json (deps fields only; scripts and devDeps stripped)
 *   - .ts/.tsx/.d.ts files under the workspace and any --include globs
 *   - Skips: node_modules, dist, .next, build, out, coverage, .git
 *
 * Produces under fixtures/real-<timestamp>-<hash>/:
 *   - expected.json     (mustPass:false by default — see REAL.md lifecycle)
 *   - diagnostics.json  (the broken snapshot's Diagnostic[], for triage)
 *   - tsconfig.json, package.json, README.md, setup.sh
 *   - <captured source files>
 *   - package-lock.json (with --commit-locked)
 *   - node_modules → ../_shared/node_modules (symlink, only with --shared-deps)
 *
 * Run the new fixture by `npm run benchmark -- --fixture real-<timestamp>-<hash>`.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");

// `setup.sh` materialises the fixture's pinned node_modules from its committed
// package-lock.json (node_modules strategy (a) in REAL.md). `--ignore-scripts`
// keeps a captured (untrusted) workspace from running install hooks.
const SETUP_SH = [
	"#!/usr/bin/env sh",
	"# Materialise this fixture's pinned node_modules from package-lock.json.",
	"# Run before benchmarking this fixture for the first time.",
	"set -e",
	'cd "$(dirname "$0")"',
	"npm ci --ignore-scripts --no-audit --no-fund",
	"",
].join("\n");

// ──────────────────────────────────────────────────────────────────────
// CLI parsing
// ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
	const args = {
		workspace: undefined,
		description: undefined,
		include: [],
		sharedDeps: false,
		commitLocked: false,
	};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--description") args.description = argv[++i];
		else if (a === "--include") args.include = (argv[++i] ?? "").split(",").filter(Boolean);
		else if (a === "--no-shared-deps") args.sharedDeps = false;
		else if (a === "--shared-deps") args.sharedDeps = true;
		else if (a === "--commit-locked") args.commitLocked = true;
		else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		} else if (!a.startsWith("--")) rest.push(a);
		else throw new Error(`unknown flag: ${a}`);
	}
	[args.workspace] = rest;
	if (!args.workspace) {
		printHelp();
		process.exit(2);
	}
	return args;
}

function printHelp() {
	console.error(
		[
			"Usage: capture-fixture <broken-workspace-path> [opts]",
			"",
			"  --description \"...\"     short description for expected.json",
			"  --include \"glob,...\"   extra paths to capture beyond src/**",
			"  --shared-deps          symlink node_modules to ../_shared/node_modules",
			"  --no-shared-deps       don't symlink (default; use a lockfile instead)",
			"  --commit-locked        also copy package-lock.json (strategy (a))",
			"",
			"Real-failure recipe (strategy (a)):",
			"  capture-fixture <ws> --no-shared-deps --commit-locked --description \"...\"",
			"",
		].join("\n"),
	);
}

// ──────────────────────────────────────────────────────────────────────
// Walk + filter source files
// ──────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
	"node_modules",
	".next",
	"dist",
	"build",
	"out",
	"coverage",
	".git",
]);

function isSourceFile(name) {
	return name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".d.ts");
}

export function listSourceFiles(workspace) {
	const out = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) {
				if (SKIP_DIRS.has(e.name)) continue;
				walk(join(dir, e.name));
			} else if (e.isFile() && isSourceFile(e.name)) {
				out.push(relative(workspace, join(dir, e.name)));
			}
		}
	};
	walk(workspace);
	return out.sort();
}

// ──────────────────────────────────────────────────────────────────────
// Deterministic fixture-directory name: real-<YYYYMMDD-HHMMSS>-<hash8>
// ──────────────────────────────────────────────────────────────────────

/** UTC `YYYYMMDD-HHMMSS` from a Date. */
export function formatTimestamp(date) {
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return (
		`${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
		`-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
	);
}

/**
 * 8-char content hash of the captured source files. Stable + deterministic
 * for a given broken workspace (independent of capture time), so re-capturing
 * the same bug yields the same hash slice.
 */
export function contentHash(workspace, sources) {
	const h = createHash("sha256");
	for (const rel of sources) {
		h.update(rel);
		h.update("\0");
		h.update(readFileSync(join(workspace, rel)));
		h.update("\0");
	}
	return h.digest("hex").slice(0, 8);
}

export function fixtureDirName(date, hash) {
	return `real-${formatTimestamp(date)}-${hash}`;
}

/** UTC `YYYY-MM-DD` from a Date. */
export function formatDate(date) {
	const p = (n) => String(n).padStart(2, "0");
	return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}`;
}

// ──────────────────────────────────────────────────────────────────────
// Strip a package.json down to what a fixture needs
// ──────────────────────────────────────────────────────────────────────

export function stripPackageJson(srcPkgJsonPath) {
	if (!existsSync(srcPkgJsonPath)) {
		return {
			name: "captured-fixture",
			version: "0.0.0",
			private: true,
		};
	}
	const src = JSON.parse(readFileSync(srcPkgJsonPath, "utf-8"));
	const out = {
		name: `captured-${src.name ?? "fixture"}`,
		version: "0.0.0",
		private: true,
	};
	if (src.type) out.type = src.type;
	if (src.dependencies) out.dependencies = src.dependencies;
	// devDependencies and scripts intentionally dropped — fixtures don't
	// run lifecycle scripts and the dev tools (tsx, vitest, etc.) come from
	// the package's own node_modules via the runner.
	return out;
}

// ──────────────────────────────────────────────────────────────────────
// Baseline diagnostics — default impl builds dist/ then runs the validation
// loop in-process (dry-run) to capture the broken snapshot's Diagnostic[].
// Injectable so tests can drive `captureFixture` without a real TS workspace.
// ──────────────────────────────────────────────────────────────────────

export async function defaultGatherDiagnostics(workspaceAbs, root = REPO_ROOT) {
	const buildR = spawnSync("npm", ["run", "build", "--silent"], {
		cwd: root,
		encoding: "utf-8",
	});
	if (buildR.status !== 0) {
		throw new Error(`build failed: ${buildR.stderr}`);
	}
	const distIndex = pathToFileURL(join(root, "dist", "index.js")).href;
	const { runValidationLoop } = await import(distIndex);
	// dry-run: the LSP fixer runs in memory but doesn't write, so `diagnostics`
	// is the broken (before-fix) snapshot and `lspFixer.fixesApplied` is what
	// Layer 0/1 *would* fix today.
	const loop = runValidationLoop({ workspaceRoot: workspaceAbs, dryRun: true });
	return {
		errorsBefore: loop.errorsBefore,
		lspFixesApplied: loop.lspFixer?.fixesApplied ?? 0,
		remainingByCode: loop.remainingByCode ?? {},
		remainingByFile: loop.remainingByFile ?? {},
		diagnostics: loop.diagnostics ?? [],
	};
}

// ──────────────────────────────────────────────────────────────────────
// expected.json builder
// ──────────────────────────────────────────────────────────────────────

export function buildExpected({ description, source, capturedAt, baseline }) {
	const { errorsBefore, lspFixesApplied, remainingByCode, remainingByFile } = baseline;
	return {
		description:
			description ??
			`Real-pattern fixture captured from ${source}. Edit this description to explain what bug pattern this represents and why it matters.`,
		source,
		capturedAt,
		errorsBefore,
		// Lenient at capture time: a freshly captured failure is report-only
		// (mustPass:false) and tsfix is not yet required to improve on it.
		// Tighten to 0 when you flip mustPass:true (see REAL.md lifecycle).
		errorsAfterMax: errorsBefore,
		// The gate. New captures start red/report-only; flip to true once a
		// fix ships (and set errorsAfterMax:0). See REAL.md.
		mustPass: false,
		// Hints for the fixture author — refine/remove before committing:
		_hint_lspFixesApplied: lspFixesApplied,
		_hint_remainingByCode: remainingByCode,
		_hint_remainingByFile: remainingByFile,
	};
}

// ──────────────────────────────────────────────────────────────────────
// Core capture — writes the fixture directory. Pure-ish: all I/O is under
// `fixturesRoot`, the clock + diagnostics source are injectable.
// ──────────────────────────────────────────────────────────────────────

export async function captureFixture(opts) {
	const {
		workspaceAbs,
		root = REPO_ROOT,
		fixturesRoot = join(root, "fixtures"),
		description,
		sharedDeps = false,
		commitLocked = false,
		gatherDiagnostics = defaultGatherDiagnostics,
		now = () => new Date(),
		log = () => {},
	} = opts;

	if (!existsSync(workspaceAbs)) {
		throw new Error(`workspace not found: ${workspaceAbs}`);
	}
	const tsconfigSrc = join(workspaceAbs, "tsconfig.json");
	if (!existsSync(tsconfigSrc)) {
		throw new Error(`${workspaceAbs} has no tsconfig.json`);
	}

	log(`[capture] gathering baseline diagnostics for ${workspaceAbs}`);
	const baseline = await gatherDiagnostics(workspaceAbs, root);
	log(
		`[capture] baseline: ${baseline.errorsBefore} error(s) before; tsfix would apply ${baseline.lspFixesApplied} fix(es)`,
	);

	const sources = listSourceFiles(workspaceAbs);
	const hash = contentHash(workspaceAbs, sources);
	const dirName = fixtureDirName(now(), hash);
	const fixtureDir = join(fixturesRoot, dirName);
	if (existsSync(fixtureDir)) {
		throw new Error(`fixture already exists: ${dirName} (remove it to recapture)`);
	}

	log(`[capture] writing fixture to ${fixtureDir} (${sources.length} source file(s))`);
	mkdirSync(fixtureDir, { recursive: true });

	// 1. tsconfig
	cpSync(tsconfigSrc, join(fixtureDir, "tsconfig.json"));

	// 2. package.json (stripped)
	const strippedPkg = stripPackageJson(join(workspaceAbs, "package.json"));
	writeFileSync(
		join(fixtureDir, "package.json"),
		JSON.stringify(strippedPkg, null, "\t") + "\n",
	);

	// 3. Source files (preserving directory structure)
	for (const rel of sources) {
		const dest = join(fixtureDir, rel);
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(join(workspaceAbs, rel), dest);
	}

	// 4. Optional: package-lock.json (node_modules strategy (a))
	if (commitLocked) {
		const lockSrc = join(workspaceAbs, "package-lock.json");
		if (existsSync(lockSrc)) {
			cpSync(lockSrc, join(fixtureDir, "package-lock.json"));
			log("[capture] copied package-lock.json");
		} else {
			log("[capture] warning: --commit-locked but no package-lock.json in workspace");
		}
	}

	// 5. node_modules: symlink to _shared only when explicitly requested.
	//    Real fixtures default to strategy (a) (no symlink; setup.sh + lockfile).
	if (sharedDeps) {
		symlinkSync("../_shared/node_modules", join(fixtureDir, "node_modules"));
	} else {
		// setup.sh materialises node_modules on demand from the lockfile.
		const setupPath = join(fixtureDir, "setup.sh");
		writeFileSync(setupPath, SETUP_SH);
		chmodSync(setupPath, 0o755);
	}

	// 6. diagnostics.json — the broken snapshot's Diagnostic[].
	writeFileSync(
		join(fixtureDir, "diagnostics.json"),
		JSON.stringify(baseline.diagnostics, null, "\t") + "\n",
	);

	// 7. expected.json
	const expected = buildExpected({
		description,
		source: relative(root, workspaceAbs) || workspaceAbs,
		capturedAt: formatDate(now()),
		baseline,
	});
	writeFileSync(
		join(fixtureDir, "expected.json"),
		JSON.stringify(expected, null, "\t") + "\n",
	);

	// 8. README.md
	writeFileSync(
		join(fixtureDir, "README.md"),
		[
			`# fixtures/${dirName}`,
			"",
			expected.description,
			"",
			`Captured: ${expected.capturedAt}`,
			`Source: \`${expected.source}\``,
			"",
			"## Baseline (at capture time)",
			"",
			`- errorsBefore: ${baseline.errorsBefore}`,
			`- tsfix would apply: ${baseline.lspFixesApplied}`,
			`- remainingByCode: ${JSON.stringify(baseline.remainingByCode)}`,
			"",
			"## Lifecycle",
			"",
			"Captured `mustPass:false` (report-only). When a fix ships, flip",
			"`mustPass:true` and set `errorsAfterMax:0`. See `fixtures/REAL.md`.",
			"",
			"## What this exercises",
			"",
			"_Edit this section. Why does this fixture exist? What pattern does it document?_",
			"",
		].join("\n"),
	);

	return { fixtureDir, dirName, expected, diagnostics: baseline.diagnostics };
}

// ──────────────────────────────────────────────────────────────────────
// Main (only when run as a script, not when imported by tests)
// ──────────────────────────────────────────────────────────────────────

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const workspaceAbs = resolve(args.workspace);

	const { dirName } = await captureFixture({
		workspaceAbs,
		description: args.description,
		sharedDeps: args.sharedDeps,
		commitLocked: args.commitLocked,
		log: (m) => console.log(m),
	});

	console.log(`\n[capture] ✓ fixture skeleton written: fixtures/${dirName}/`);
	console.log(`           Next steps:`);
	console.log(`             1. Review fixtures/${dirName}/expected.json — refine description; keep mustPass:false.`);
	console.log(`             2. Run: ./fixtures/${dirName}/setup.sh   (materialise node_modules)`);
	console.log(`             3. Run: npm run benchmark -- --fixture ${dirName}`);
	console.log(`             4. Edit README.md to describe what pattern this represents.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(2);
	});
}
