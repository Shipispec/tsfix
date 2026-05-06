/**
 * @shipispec/tsfix — public API.
 *
 * A reusable TypeScript error-recovery agent. Validates LLM-generated (or any)
 * TypeScript code via in-process tsc, auto-fixes deterministic error classes
 * (TS2304/2305/2552/2724) via TypeScript's built-in code-fix engine, and
 * exposes hooks for LLM-driven repair (planned, not yet shipped).
 *
 * ## Quick start (library)
 *
 * ```ts
 * import { runValidationLoop } from "@shipispec/tsfix";
 *
 * const result = await runValidationLoop({
 *   workspaceRoot: "/path/to/your/project",
 *   targetFiles: ["src/index.ts", "src/utils.ts"],
 * });
 *
 * console.log(result.passed, result.errorsAfter, result.lspFixer.fixesApplied);
 * ```
 *
 * ## Quick start (CLI)
 *
 * ```
 * npx @shipispec/tsfix --workspace ./my-project
 * ```
 *
 * ## Layered API
 *
 * - `runValidationLoop` — full deterministic loop (recommended entry point)
 * - `runInProcessTsc` — just type-check, returns structured diagnostics
 * - `runLSPFixerPass` — just the auto-fix pass, edits files in place
 *
 * ## What it doesn't do (yet)
 *
 * LLM-driven repair (the mend-agent layers from the spectoship pipeline) is
 * not exported here yet. They depend on internal types (ParsedTask) that need
 * to be redesigned as opaque interfaces before they can be moved into this
 * package. v0.2 target.
 */

export { runInProcessTsc, isInProcessTscEnabled, resetInProcessTscCache } from "./validatorInProcess.js";
export type { InProcessTscOptions, InProcessTscResult } from "./validatorInProcess.js";

export { runLSPFixerPass, isLSPFixerEnabled, resetLSPFixerCache } from "./tsLanguageServiceFixer.js";
export type { LSPFixerOptions, LSPFixerResult, LSPFixerLogger } from "./tsLanguageServiceFixer.js";

import * as fs from "node:fs";
import * as path from "node:path";
import {
	runInProcessTsc,
	resetInProcessTscCache,
	type InProcessTscResult,
} from "./validatorInProcess.js";
import { runLSPFixerPass } from "./tsLanguageServiceFixer.js";

/** Logger shape required by the validation/fix loop. Plain object with three methods. */
export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export interface ValidationLoopOptions {
	/** Absolute path to the workspace (must contain `tsconfig.json`). */
	workspaceRoot: string;
	/**
	 * Files to scope the type-check + fix to. If omitted, all .ts/.tsx files
	 * under `workspaceRoot` (excluding node_modules, .next, dist, build, .git)
	 * are discovered.
	 */
	targetFiles?: string[];
	/** Skip Layer 0 LSP auto-fixer. Default false. */
	skipLSPFixer?: boolean;
	/**
	 * Run the LSP fixer in memory but do NOT persist edits to disk. The
	 * returned `lspFixer.filesEdited` lists files that *would* have been
	 * written. Useful for previewing changes before letting tsfix mutate a
	 * workspace. Default false.
	 */
	dryRun?: boolean;
	/** Default: a no-op logger. Pass your own to capture layer events. */
	logger?: Logger;
}

export interface ValidationLoopResult {
	passed: boolean;
	errorsBefore: number;
	errorsAfter: number;
	lspFixer: {
		ran: boolean;
		fixesApplied: number;
		filesEdited: string[];
		iterations: number;
	};
	remainingByCode: Record<string, number>;
	remainingByFile: Record<string, number>;
	diagnostics: InProcessTscResult["diagnostics"];
	elapsedMs: number;
}

const noopLogger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

/**
 * Discover all `.ts` / `.tsx` files under a workspace, excluding common
 * non-source dirs. Skips `.d.ts` declaration files.
 */
export function discoverTsFiles(workspaceRoot: string): string[] {
	const out: string[] = [];
	const skip = new Set(["node_modules", ".next", "dist", "build", ".git", "out", "coverage"]);
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory()) {
				if (skip.has(e.name)) {
					continue;
				}
				walk(path.join(dir, e.name));
			} else if (e.isFile() && !e.name.endsWith(".d.ts")) {
				if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
					out.push(path.relative(workspaceRoot, path.join(dir, e.name)));
				}
			}
		}
	};
	walk(workspaceRoot);
	return out;
}

/**
 * Run the full deterministic validation + fix loop:
 *
 *   1. In-process tsc → capture baseline diagnostics
 *   2. If errors AND not `skipLSPFixer`, run Layer 0 LSP auto-fix
 *   3. If fixes were applied, re-run in-process tsc to capture post-fix state
 *   4. Return aggregated result
 *
 * Throws on missing `tsconfig.json` or workspace path.
 */
export function runValidationLoop(opts: ValidationLoopOptions): ValidationLoopResult {
	const { workspaceRoot, skipLSPFixer = false, dryRun = false } = opts;
	const logger = opts.logger ?? noopLogger;

	if (!fs.existsSync(workspaceRoot)) {
		throw new Error(`workspace not found: ${workspaceRoot}`);
	}
	if (!fs.existsSync(path.join(workspaceRoot, "tsconfig.json"))) {
		throw new Error(`no tsconfig.json in ${workspaceRoot}`);
	}

	const targetFiles = opts.targetFiles ?? discoverTsFiles(workspaceRoot);
	const startMs = Date.now();

	resetInProcessTscCache();
	const before = runInProcessTsc({ workspaceRoot, generatedFiles: targetFiles, logger });
	const errorsBefore = before.diagnostics.filter((d) => d.category === "error").length;

	let after = before;
	let lspFixer = {
		ran: false,
		fixesApplied: 0,
		filesEdited: [] as string[],
		iterations: 0,
	};

	if (errorsBefore > 0 && !skipLSPFixer) {
		const lsp = runLSPFixerPass({ workspaceRoot, targetFiles, logger, dryRun });
		lspFixer = {
			ran: true,
			fixesApplied: lsp.fixesApplied,
			filesEdited: lsp.filesEdited,
			iterations: lsp.iterations,
		};
		// In dry-run mode, the fixer didn't write to disk — re-running tsc
		// would see the original errors, defeating the preview. Use the
		// fixer's own remainingErrors as the authoritative post-fix view.
		if (lsp.fixesApplied > 0 && !dryRun) {
			resetInProcessTscCache();
			after = runInProcessTsc({ workspaceRoot, generatedFiles: targetFiles, logger });
		}
	}

	const errorDiags = after.diagnostics.filter((d) => d.category === "error");
	const errorsAfter = errorDiags.length;

	const remainingByCode: Record<string, number> = {};
	const remainingByFile: Record<string, number> = {};
	for (const d of errorDiags) {
		remainingByCode[d.code] = (remainingByCode[d.code] ?? 0) + 1;
		remainingByFile[d.file] = (remainingByFile[d.file] ?? 0) + 1;
	}

	return {
		passed: errorsAfter === 0,
		errorsBefore,
		errorsAfter,
		lspFixer,
		remainingByCode,
		remainingByFile,
		diagnostics: after.diagnostics,
		elapsedMs: Date.now() - startMs,
	};
}
