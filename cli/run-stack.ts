/**
 * Standalone TSC Defense Stack runner.
 *
 * Runs the deterministic layers (in-process tsc + LSP fixer) against an
 * arbitrary workspace and reports per-layer outcomes. No LLM calls.
 *
 * Usage:
 *   npx tsx tsc-defense-stack/cli/run-stack.ts --workspace <path>
 *   npx tsx tsc-defense-stack/cli/run-stack.ts --workspace <path> --json
 *   npx tsx tsc-defense-stack/cli/run-stack.ts --workspace <path> --no-lsp
 *
 * Why standalone: iterate on TSC reliability without running the full
 * SpecToShip pipeline (~$1 per run). See tsc-defense-stack/CLAUDE.md.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
	runValidationLoop,
	discoverTsFiles,
	type ValidationLoopResult,
} from "../src/index.js";

interface CliArgs {
	workspace: string;
	json: boolean;
	noLsp: boolean;
	dryRun: boolean;
	files: string[] | undefined;
	verbose: boolean;
}

interface StackReport {
	workspace: string;
	errorsBefore: number;
	lspFixer: {
		ran: boolean;
		fixesApplied: number;
		filesEdited: string[];
		iterations: number;
	} | null;
	errorsAfter: number;
	remainingByCode: Record<string, number>;
	remainingByFile: Record<string, number>;
	passed: boolean;
	elapsedMs: number;
	dryRun: boolean;
	logs?: string[];
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		workspace: "",
		json: false,
		noLsp: false,
		dryRun: false,
		files: undefined,
		verbose: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--workspace" || a === "-w") {
			args.workspace = argv[++i] ?? "";
		} else if (a === "--json") {
			args.json = true;
		} else if (a === "--no-lsp") {
			args.noLsp = true;
		} else if (a === "--dry-run") {
			args.dryRun = true;
		} else if (a === "--files") {
			args.files = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		} else if (a === "--verbose" || a === "-v") {
			args.verbose = true;
		} else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		}
	}
	if (!args.workspace) {
		console.error("error: --workspace <path> is required");
		printHelp();
		process.exit(2);
	}
	return args;
}

function printHelp(): void {
	console.error(`
Usage: run-stack --workspace <path> [options]

Options:
  --workspace, -w <path>   Workspace root (required)
  --files <list>           Comma-separated file paths to scope tsc/lsp to (default: all .ts/.tsx)
  --no-lsp                 Skip Layer 0 LSP auto-fixer
  --dry-run                Run the LSP fixer in memory; do NOT write changes
                           to disk. Lists files that would be edited.
  --json                   Emit JSON report on stdout
  --verbose, -v            Stream layer logs to stderr
  --help, -h               Show this help

Exit codes:
  0  no errors after stack
  1  errors remain after stack
  2  bad arguments / harness error
`.trim());
}

function makeLogger(captureLines: string[], verbose: boolean) {
	const log = (level: string, msg: string) => {
		const line = `[${level}] ${msg}`;
		captureLines.push(line);
		if (verbose) process.stderr.write(line + "\n");
	};
	return {
		info: (m: string) => log("info", m),
		warn: (m: string) => log("warn", m),
		error: (m: string) => log("error", m),
	};
}

function printHumanReport(r: StackReport): void {
	const w = process.stderr;
	w.write(`\nTSC Defense Stack — ${r.workspace}${r.dryRun ? " (dry-run)" : ""}\n`);
	w.write(`  errors before: ${r.errorsBefore}\n`);
	if (r.lspFixer?.ran) {
		const verb = r.dryRun ? "would apply" : "applied";
		const editVerb = r.dryRun ? "would edit" : "edited";
		w.write(
			`  LSP fixer:     ${verb} ${r.lspFixer.fixesApplied} fix(es) in ${r.lspFixer.iterations} iter(s); ${editVerb} ${r.lspFixer.filesEdited.length} file(s)\n`,
		);
		if (r.dryRun && r.lspFixer.filesEdited.length > 0) {
			for (const f of r.lspFixer.filesEdited) {
				w.write(`    - ${f}\n`);
			}
		}
	} else {
		w.write(`  LSP fixer:     skipped\n`);
	}
	w.write(`  errors after:  ${r.errorsAfter}\n`);
	if (r.errorsAfter > 0) {
		const top = Object.entries(r.remainingByCode)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8);
		w.write(`  top remaining codes:\n`);
		for (const [code, n] of top) {
			w.write(`    ${code.padEnd(8)} ${n}\n`);
		}
	}
	w.write(`  elapsed:       ${r.elapsedMs}ms\n`);
	w.write(`  ${r.passed ? "✓ PASS" : "✗ FAIL"}\n\n`);
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const workspaceRoot = path.resolve(args.workspace);
	if (!fs.existsSync(workspaceRoot)) {
		console.error(`error: workspace not found: ${workspaceRoot}`);
		return 2;
	}
	if (!fs.existsSync(path.join(workspaceRoot, "tsconfig.json"))) {
		console.error(`error: no tsconfig.json in ${workspaceRoot}`);
		return 2;
	}

	const logs: string[] = [];
	const logger = makeLogger(logs, args.verbose);

	const targetFiles = args.files ?? discoverTsFiles(workspaceRoot);
	if (targetFiles.length === 0) {
		console.error("error: no .ts/.tsx files found in workspace");
		return 2;
	}

	const loop: ValidationLoopResult = runValidationLoop({
		workspaceRoot,
		targetFiles,
		skipLSPFixer: args.noLsp,
		dryRun: args.dryRun,
		logger,
	});

	const report: StackReport = {
		workspace: path.relative(process.cwd(), workspaceRoot) || workspaceRoot,
		errorsBefore: loop.errorsBefore,
		lspFixer: args.noLsp
			? { ran: false, fixesApplied: 0, filesEdited: [], iterations: 0 }
			: loop.lspFixer,
		errorsAfter: loop.errorsAfter,
		remainingByCode: loop.remainingByCode,
		remainingByFile: loop.remainingByFile,
		passed: loop.passed,
		elapsedMs: loop.elapsedMs,
		dryRun: args.dryRun,
	};

	if (args.json) {
		process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	} else {
		printHumanReport(report);
	}

	return report.passed ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error("harness error:", err instanceof Error ? err.stack : err);
		process.exit(2);
	},
);
