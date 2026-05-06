#!/usr/bin/env node
/**
 * Real-world test matrix for `@shipispec/tsfix`.
 *
 * Pre-publish gate. Builds the local tarball, then for each
 * `test-matrix/<sample>/` directory:
 *
 *   1. Copy the sample to /tmp/matrix-<sample>/
 *   2. Run `npm install` (sample's own deps; usually just react/@types)
 *   3. Install our local tarball: `npm install <abs-tarball-path>`
 *   4. Run `tsfix --workspace . --json`
 *   5. Compare actual outcome against `expected.json`
 *
 * Each sample exercises a different TypeScript project shape so we catch
 * setups where the published package fails. Pass = ship-ready.
 *
 * Run via `npm run matrix`. Exit 0 if all samples pass, 1 if any fail,
 * 2 on harness error.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const matrixDir = resolve(root, "test-matrix");
const tmpRoot = join(tmpdir(), "tsfix-matrix");

function log(...args) {
	process.stderr.write(args.join(" ") + "\n");
}

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
	if (r.error) throw r.error;
	return r;
}

// ──────────────────────────────────────────────────────────────────────
// 1. Build the local tarball
// ──────────────────────────────────────────────────────────────────────

log("[matrix] building local tarball");
const packResult = run("npm", ["pack", "--silent"], { cwd: root });
if (packResult.status !== 0) {
	log("[matrix] npm pack failed:", packResult.stderr);
	process.exit(2);
}
const tarballName = packResult.stdout.trim().split("\n").pop();
const tarballAbsPath = resolve(root, tarballName);
log("[matrix] tarball:", tarballAbsPath);

// ──────────────────────────────────────────────────────────────────────
// 2. Discover samples
// ──────────────────────────────────────────────────────────────────────

const samples = readdirSync(matrixDir, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.filter((name) => existsSync(join(matrixDir, name, "expected.json")));

if (samples.length === 0) {
	log("[matrix] no samples found in", matrixDir);
	process.exit(2);
}

log(`[matrix] discovered ${samples.length} sample(s):`, samples.join(", "));

// ──────────────────────────────────────────────────────────────────────
// 3. Run each sample
// ──────────────────────────────────────────────────────────────────────

if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpRoot, { recursive: true });

const results = [];

for (const name of samples) {
	const sampleSrc = join(matrixDir, name);
	const sampleDest = join(tmpRoot, name);
	const expected = JSON.parse(readFileSync(join(sampleSrc, "expected.json"), "utf-8"));

	log(`\n──── ${name} ─────────────────────────────────────────`);
	log(`[${name}] ${expected.description}`);

	// Copy sample → /tmp
	cpSync(sampleSrc, sampleDest, { recursive: true });

	// Install sample's own deps (if any)
	const samplePkg = JSON.parse(readFileSync(join(sampleDest, "package.json"), "utf-8"));
	const hasOwnDeps = samplePkg.dependencies || samplePkg.devDependencies;
	if (hasOwnDeps) {
		log(`[${name}] npm install (sample deps)`);
		const r = run("npm", ["install", "--no-audit", "--no-fund", "--silent"], {
			cwd: sampleDest,
			stdio: ["ignore", "ignore", "pipe"],
		});
		if (r.status !== 0) {
			results.push({ name, passed: false, reason: `sample npm install failed: ${r.stderr}` });
			continue;
		}
	}

	// Install the local tarball (and its peer dep typescript)
	log(`[${name}] npm install <tarball>`);
	const installR = run(
		"npm",
		["install", "--no-audit", "--no-fund", "--silent", tarballAbsPath, "typescript"],
		{ cwd: sampleDest, stdio: ["ignore", "ignore", "pipe"] },
	);
	if (installR.status !== 0) {
		results.push({ name, passed: false, reason: `tarball install failed: ${installR.stderr}` });
		continue;
	}

	// Run tsfix
	const tsfixBin = join(sampleDest, "node_modules", ".bin", "tsfix");
	if (!existsSync(tsfixBin)) {
		results.push({ name, passed: false, reason: "bin not present after install" });
		continue;
	}
	log(`[${name}] tsfix --workspace . --json`);
	const fixR = run(tsfixBin, ["--workspace", ".", "--json"], { cwd: sampleDest });
	let report;
	try {
		report = JSON.parse(fixR.stdout);
	} catch (err) {
		results.push({
			name,
			passed: false,
			reason: `tsfix output not JSON. exit=${fixR.status}. stdout=${fixR.stdout.slice(0, 200)}. stderr=${fixR.stderr.slice(0, 200)}`,
		});
		continue;
	}

	// Compare against expected
	const failures = [];
	if (expected.errorsBefore !== undefined && report.errorsBefore !== expected.errorsBefore) {
		failures.push(`errorsBefore: expected ${expected.errorsBefore}, got ${report.errorsBefore}`);
	}
	if (expected.errorsAfterMax !== undefined && report.errorsAfter > expected.errorsAfterMax) {
		failures.push(`errorsAfter ${report.errorsAfter} > max ${expected.errorsAfterMax}`);
	}
	if (
		expected.lspFixesAppliedMin !== undefined &&
		report.lspFixer &&
		report.lspFixer.fixesApplied < expected.lspFixesAppliedMin
	) {
		failures.push(
			`lspFixesApplied ${report.lspFixer.fixesApplied} < min ${expected.lspFixesAppliedMin}`,
		);
	}
	if (
		expected.lspFixesAppliedMax !== undefined &&
		report.lspFixer &&
		report.lspFixer.fixesApplied > expected.lspFixesAppliedMax
	) {
		failures.push(
			`lspFixesApplied ${report.lspFixer.fixesApplied} > max ${expected.lspFixesAppliedMax}`,
		);
	}
	if (expected.mustPass && !report.passed) {
		failures.push(`mustPass=true but report.passed=false`);
	}
	// File-content assertions: each `expectFileContains` substring must exist
	// in at least one .ts/.tsx file under the sample dir post-fix.
	if (expected.expectFileContains) {
		const allContent = [];
		const walk = (d) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				if (e.isDirectory()) {
					if (["node_modules", "dist", ".next"].includes(e.name)) continue;
					walk(join(d, e.name));
				} else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
					allContent.push(readFileSync(join(d, e.name), "utf-8"));
				}
			}
		};
		walk(sampleDest);
		const haystack = allContent.join("\n");
		for (const needle of expected.expectFileContains) {
			if (!haystack.includes(needle)) {
				failures.push(`expectFileContains "${needle}": not found in any .ts(x) file post-fix`);
			}
		}
	}

	const passed = failures.length === 0;
	log(`[${name}] ${passed ? "✓ PASS" : "✗ FAIL"}`);
	if (!passed) failures.forEach((f) => log(`         └─ ${f}`));
	results.push({
		name,
		passed,
		expected,
		report: {
			errorsBefore: report.errorsBefore,
			errorsAfter: report.errorsAfter,
			lspFixesApplied: report.lspFixer?.fixesApplied,
		},
		failures,
	});
}

// ──────────────────────────────────────────────────────────────────────
// 4. Summary
// ──────────────────────────────────────────────────────────────────────

log("\n══════════════════════════════════════════════════════════");
const passed = results.filter((r) => r.passed).length;
log(`Matrix: ${passed}/${results.length} passed`);
for (const r of results) {
	const icon = r.passed ? "✓" : "✗";
	const limitTag = r.expected?.isLimitation ? " [documented limitation]" : "";
	const detail = r.report
		? `(${r.report.errorsBefore} → ${r.report.errorsAfter}, fixes: ${r.report.lspFixesApplied})`
		: r.reason || "";
	log(`  ${icon} ${r.name.padEnd(22)} ${detail}${limitTag}`);
}

// Cleanup the local tarball; leave /tmp/tsfix-matrix/ for manual inspection.
rmSync(tarballAbsPath, { force: true });

process.exit(passed === results.length ? 0 : 1);
