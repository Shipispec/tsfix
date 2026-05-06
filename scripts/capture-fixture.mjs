#!/usr/bin/env node
/**
 * Capture a real (or realistic) broken workspace into a fixture under
 * `fixtures/real-<name>/`.
 *
 * Usage:
 *   node scripts/capture-fixture.mjs <name> <broken-workspace-path> [opts]
 *
 *   --description "..."     — short text for expected.json#description
 *   --include "<glob>,..."  — extra glob patterns to capture beyond src/**
 *   --shared-deps           — link node_modules to ../_shared/node_modules
 *                             (default; turn off with --no-shared-deps to
 *                             snapshot a specific package-lock.json instead)
 *   --commit-locked         — also copy package-lock.json into the fixture
 *
 * Captures (relative to <broken-workspace-path>):
 *   - tsconfig.json (or *.tsconfig.json variants if found)
 *   - package.json (deps fields only; scripts and devDeps stripped)
 *   - .ts/.tsx/.d.ts files under `src/` and any --include globs
 *   - Skips: node_modules, dist, .next, build, out, coverage, .git
 *
 * Produces under fixtures/real-<name>/:
 *   - expected.json (auto-generated from baseline diagnostics)
 *   - tsconfig.json, package.json, README.md
 *   - <captured source files>
 *   - node_modules → ../_shared/node_modules (symlink, default)
 *
 * Run the new fixture by `npm run benchmark -- --fixture real-<name>` to
 * verify it loads.
 */

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// ──────────────────────────────────────────────────────────────────────
// CLI parsing
// ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const args = {
		name: undefined,
		workspace: undefined,
		description: undefined,
		include: [],
		sharedDeps: true,
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
	[args.name, args.workspace] = rest;
	if (!args.name || !args.workspace) {
		printHelp();
		process.exit(2);
	}
	return args;
}

function printHelp() {
	console.error(
		[
			"Usage: capture-fixture <name> <broken-workspace-path> [opts]",
			"",
			"  --description \"...\"     short description for expected.json",
			"  --include \"glob,...\"   extra paths to capture beyond src/**",
			"  --no-shared-deps       don't symlink to ../_shared/node_modules",
			"  --commit-locked        also copy package-lock.json",
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

function listSourceFiles(workspace) {
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
// Run tsfix --dry-run for baseline diagnostics
// ──────────────────────────────────────────────────────────────────────

function runBaselineDiagnostics(workspace) {
	// We need the local tsfix bin. Build the dist first to make sure it's
	// fresh.
	const buildR = spawnSync("npm", ["run", "build", "--silent"], {
		cwd: root,
		encoding: "utf-8",
	});
	if (buildR.status !== 0) {
		throw new Error(`build failed: ${buildR.stderr}`);
	}
	const tsfixCli = join(root, "dist", "cli.js");
	const r = spawnSync(
		process.execPath,
		[tsfixCli, "--workspace", workspace, "--json", "--dry-run"],
		{ encoding: "utf-8" },
	);
	if (r.status !== 0 && r.status !== 1) {
		throw new Error(`tsfix dry-run errored (exit ${r.status}): ${r.stderr || r.stdout}`);
	}
	let report;
	try {
		report = JSON.parse(r.stdout);
	} catch (err) {
		throw new Error(`tsfix output not JSON: ${r.stdout.slice(0, 200)}`);
	}
	return report;
}

// ──────────────────────────────────────────────────────────────────────
// Strip a package.json down to what a fixture needs
// ──────────────────────────────────────────────────────────────────────

function stripPackageJson(srcPkgJsonPath) {
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
// Main
// ──────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const workspaceAbs = resolve(args.workspace);
if (!existsSync(workspaceAbs)) {
	console.error(`error: workspace not found: ${workspaceAbs}`);
	process.exit(2);
}
const tsconfigSrc = join(workspaceAbs, "tsconfig.json");
if (!existsSync(tsconfigSrc)) {
	console.error(`error: ${workspaceAbs} has no tsconfig.json`);
	process.exit(2);
}

const fixtureDir = join(root, "fixtures", `real-${args.name}`);
if (existsSync(fixtureDir)) {
	console.error(`error: fixture already exists: fixtures/real-${args.name}/`);
	console.error("       remove it first if you want to recapture.");
	process.exit(2);
}

console.log(`[capture] running tsfix dry-run against ${workspaceAbs}`);
const report = runBaselineDiagnostics(workspaceAbs);
const errorsBefore = report.errorsBefore;
const lspFixesApplied = report.lspFixer?.fixesApplied ?? 0;
const remainingByCode = report.remainingByCode ?? {};
const remainingByFile = report.remainingByFile ?? {};
console.log(
	`[capture] baseline: ${errorsBefore} error(s) before; tsfix would apply ${lspFixesApplied} fix(es)`,
);

console.log(`[capture] writing fixture skeleton to ${fixtureDir}`);
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
const sources = listSourceFiles(workspaceAbs);
console.log(`[capture] ${sources.length} source file(s)`);
for (const rel of sources) {
	const dest = join(fixtureDir, rel);
	mkdirSync(dirname(dest), { recursive: true });
	cpSync(join(workspaceAbs, rel), dest);
}

// 4. Optional: package-lock.json
if (args.commitLocked) {
	const lockSrc = join(workspaceAbs, "package-lock.json");
	if (existsSync(lockSrc)) {
		cpSync(lockSrc, join(fixtureDir, "package-lock.json"));
		console.log("[capture] also copied package-lock.json");
	}
}

// 5. node_modules: symlink to _shared by default
if (args.sharedDeps) {
	symlinkSync("../_shared/node_modules", join(fixtureDir, "node_modules"));
}

// 6. expected.json
const fixerCodes = new Set();
// Codes the fixer would apply something to: any code currently in
// SAFE_FIXABLE_CODES that appears in the baseline. We can't easily extract
// that set from a published bundle, so just record the dominant remaining
// codes as a hint to the human filling this out.
const expected = {
	description:
		args.description ??
		`Real-pattern fixture captured from ${relative(root, workspaceAbs)}. Edit this description to explain what bug pattern this represents and why it matters.`,
	source: relative(root, workspaceAbs) || workspaceAbs,
	capturedAt: new Date().toISOString().slice(0, 10),
	errorsBefore,
	errorsAfterMax: 0,
	lspFixesAppliedMin: lspFixesApplied,
	mustPass: errorsBefore > 0 && lspFixesApplied >= errorsBefore,
	// Hints for the fixture author — remove or refine before committing:
	_hint_remainingByCode: remainingByCode,
	_hint_remainingByFile: remainingByFile,
};
writeFileSync(join(fixtureDir, "expected.json"), JSON.stringify(expected, null, "\t") + "\n");

// 7. README.md
writeFileSync(
	join(fixtureDir, "README.md"),
	[
		`# fixtures/real-${args.name}`,
		"",
		expected.description,
		"",
		`Captured: ${expected.capturedAt}`,
		`Source: \`${expected.source}\``,
		"",
		"## Baseline (at capture time)",
		"",
		`- errorsBefore: ${errorsBefore}`,
		`- tsfix would apply: ${lspFixesApplied}`,
		`- remainingByCode: ${JSON.stringify(remainingByCode)}`,
		"",
		"## What this exercises",
		"",
		"_Edit this section. Why does this fixture exist? What pattern does it document?_",
		"",
	].join("\n"),
);

console.log(`\n[capture] ✓ fixture skeleton written.`);
console.log(`           Next steps:`);
console.log(`             1. Review fixtures/real-${args.name}/expected.json — refine description, mustPass.`);
console.log(`             2. Run: npm run benchmark -- --fixture real-${args.name}`);
console.log(`             3. Edit README.md to describe what pattern this represents.`);
