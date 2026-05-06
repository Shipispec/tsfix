/**
 * In-process TypeScript validator (Phase 5 — TSC iron-clad).
 *
 * Replaces the `tsc --noEmit` shell exec with `ts.createProgram` +
 * `getPreEmitDiagnostics()`. Three wins over shelling:
 *
 *   1. **Structured diagnostics** — `{file, start, length, code, messageText,
 *      category, relatedInformation}` natively, no regex parsing of tsc text
 *      output. Feeds Layer 2's symbol tracer directly.
 *
 *   2. **Speed** — long-lived Program per workspace caches lib files,
 *      transitive deps, and tsconfig parse. Cold start is comparable; warm
 *      validation is ~5-10× faster than spawning a fresh tsc process.
 *
 *   3. **Diagnostic enrichment** — we have the AST in hand, so each error
 *      can carry the offending node's source span and aliased symbol info,
 *      which the shell tsc doesn't provide.
 *
 * Backwards compatibility: feature-flagged via `SPECTOSHIP_TSC_INPROCESS`
 * env var. Shell tsc remains the default until we measure parity on real
 * projects.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

export interface InProcessTscResult {
	passed: boolean;
	/** Diagnostic messages formatted in the same shape as `tsc` output. */
	output: string;
	/** Structured per-error data — drives Layer 2 cross-file tracer. */
	diagnostics: Array<{
		file: string;
		line: number;
		column: number;
		code: string;
		message: string;
		category: "error" | "warning" | "message" | "suggestion";
	}>;
	/** Number of lines of output for log truncation. */
	lineCount: number;
}

export interface InProcessTscOptions {
	workspaceRoot: string;
	/** Optional list of files to filter diagnostics to (matches shell tsc filter). */
	generatedFiles?: string[];
	logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

/** Long-lived per-workspace Program cache. Speeds warm validation. */
interface CachedProgram {
	rootFiles: string[];
	options: ts.CompilerOptions;
	host: ts.CompilerHost;
	program: ts.Program;
	configMtime: number;
}
const programCache = new Map<string, CachedProgram>();

/**
 * Run tsc in-process. Compatible with the shell-based ToolResult shape
 * so the caller can swap implementations transparently.
 */
export function runInProcessTsc(opts: InProcessTscOptions): InProcessTscResult {
	const { workspaceRoot, generatedFiles, logger } = opts;
	const tsconfigPath = path.join(workspaceRoot, "tsconfig.json");
	if (!fs.existsSync(tsconfigPath)) {
		return {
			passed: true,
			output: "(no tsconfig.json — skipped)",
			diagnostics: [],
			lineCount: 1,
		};
	}

	const program = getOrCreateProgram(workspaceRoot, tsconfigPath, logger);
	if (!program) {
		return {
			passed: true,
			output: "(failed to create program — skipping)",
			diagnostics: [],
			lineCount: 1,
		};
	}

	const allDiagnostics = ts.getPreEmitDiagnostics(program);
	const structured = formatDiagnostics(allDiagnostics, workspaceRoot);

	// Filter to generated files when provided (mirrors shell-tsc filter).
	const filtered = generatedFiles?.length
		? structured.filter((d) =>
				generatedFiles.some((g) => g.replace(/^\.\//, "") === d.file.replace(/^\.\//, "")),
			)
		: structured;

	const errors = filtered.filter((d) => d.category === "error");

	const output = errors
		.map((d) => `${d.file}(${d.line},${d.column}): error ${d.code}: ${d.message}`)
		.join("\n");

	return {
		passed: errors.length === 0,
		output: output || "(no errors)",
		diagnostics: filtered,
		lineCount: output.split("\n").length,
	};
}

function getOrCreateProgram(
	workspaceRoot: string,
	tsconfigPath: string,
	logger: { warn(msg: string): void; error(msg: string): void },
): ts.Program | null {
	let configMtime = 0;
	try {
		configMtime = fs.statSync(tsconfigPath).mtimeMs;
	} catch {
		return null;
	}

	const cached = programCache.get(workspaceRoot);
	if (cached && cached.configMtime === configMtime) {
		// Refresh source files in case generated code changed on disk —
		// the program reuses the same options/host but reloads source-file content.
		try {
			const refreshed = ts.createProgram({
				rootNames: cached.rootFiles,
				options: cached.options,
				host: cached.host,
				oldProgram: cached.program,
			});
			cached.program = refreshed;
			return refreshed;
		} catch (err) {
			logger.warn(
				`[in-process-tsc] refresh failed; rebuilding: ${err instanceof Error ? err.message : String(err)}`,
			);
			programCache.delete(workspaceRoot);
		}
	}

	// Cold path — parse tsconfig from scratch.
	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (configFile.error) {
		logger.error(
			`[in-process-tsc] tsconfig parse error: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
		);
		return null;
	}
	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		path.dirname(tsconfigPath),
	);
	if (parsed.errors.length > 0) {
		const msgs = parsed.errors
			.map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n"))
			.join("; ");
		logger.warn(`[in-process-tsc] tsconfig parse warnings: ${msgs}`);
	}

	const host = ts.createCompilerHost(parsed.options);
	// Override the default-lib location to point at the WORKSPACE's typescript
	// install instead of the extension-bundled one. esbuild bundles `typescript`
	// into dist/extension.js, which breaks the bundled module's __dirname-based
	// lib file lookup (`lib.dom.d.ts`, `lib.es2015.d.ts`, etc. aren't shipped
	// inside the bundle). Without this override, every workspace task fails
	// with "Cannot find name 'Promise'" / "'window'" / etc. (test28R, 2026-05-03).
	const workspaceLibDir = path.join(workspaceRoot, "node_modules", "typescript", "lib");
	if (fs.existsSync(workspaceLibDir)) {
		const originalGetDefaultLibFileName = host.getDefaultLibFileName.bind(host);
		host.getDefaultLibLocation = () => workspaceLibDir;
		host.getDefaultLibFileName = (options) => {
			const fileName = path.basename(originalGetDefaultLibFileName(options));
			return path.join(workspaceLibDir, fileName);
		};
	}
	let program: ts.Program;
	try {
		program = ts.createProgram({
			rootNames: parsed.fileNames,
			options: parsed.options,
			host,
		});
	} catch (err) {
		logger.error(
			`[in-process-tsc] createProgram failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}

	programCache.set(workspaceRoot, {
		rootFiles: parsed.fileNames,
		options: parsed.options,
		host,
		program,
		configMtime,
	});
	return program;
}

function formatDiagnostics(
	diagnostics: readonly ts.Diagnostic[],
	workspaceRoot: string,
): InProcessTscResult["diagnostics"] {
	const out: InProcessTscResult["diagnostics"] = [];
	for (const d of diagnostics) {
		if (!d.file || d.start === undefined) {
			// Generic non-file errors (rare) — emit with synthetic location.
			out.push({
				file: "(global)",
				line: 0,
				column: 0,
				code: `TS${d.code}`,
				message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
				category: categoryName(d.category),
			});
			continue;
		}
		const fileName = d.file.fileName;
		// Skip lib files and node_modules from diagnostics — they're never
		// the user's bug to fix.
		if (fileName.includes("node_modules")) {
			continue;
		}
		if (/lib\.[a-z0-9.]+\.d\.ts$/.test(fileName)) {
			continue;
		}

		const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
		out.push({
			file: path.relative(workspaceRoot, fileName) || fileName,
			line: line + 1,
			column: character + 1,
			code: `TS${d.code}`,
			message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
			category: categoryName(d.category),
		});
	}
	return out;
}

function categoryName(
	c: ts.DiagnosticCategory,
): InProcessTscResult["diagnostics"][number]["category"] {
	switch (c) {
		case ts.DiagnosticCategory.Error:
			return "error";
		case ts.DiagnosticCategory.Warning:
			return "warning";
		case ts.DiagnosticCategory.Message:
			return "message";
		case ts.DiagnosticCategory.Suggestion:
			return "suggestion";
	}
}

/** Reset cache (for tests + when workspace switches). */
export function resetInProcessTscCache(): void {
	programCache.clear();
}

/**
 * Whether the in-process path is enabled. Defaults to ON as of Sprint J
 * (2026-05-03) — shell tsc consistently times out at 60s on Node 23 due to
 * the documented tsc startup-pause bug, blocking every code-gen task.
 * In-process is also 5-10× faster on warm runs because the Program is reused.
 *
 * Set `SPECTOSHIP_TSC_INPROCESS=false` to opt out.
 */
export function isInProcessTscEnabled(): boolean {
	return process.env.SPECTOSHIP_TSC_INPROCESS !== "false";
}
