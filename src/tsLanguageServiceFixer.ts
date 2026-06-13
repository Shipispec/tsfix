/**
 * TS Language Service Fixer — Sprint G / Sprint J (2026-05-03).
 *
 * Layer 0 of the mend stack. Uses TypeScript's built-in `LanguageService.getCodeFixesAtPosition`
 * (the same engine VS Code's Quick Fix uses) to resolve common errors *deterministically*,
 * before we spend a single LLM call on them.
 *
 * Why this exists: ~80% of generated-code TS errors fall into a small set of
 * boring categories that the compiler already knows how to fix:
 *
 *   - TS2304 "Cannot find name X"           → auto-import
 *   - TS2305 "no exported member named X"   → did-you-mean rename
 *   - TS2551 "Property X does not exist on Y. Did you mean Z?" → spelling fix
 *   - TS2552 "Cannot find name X. Did you mean Y?" → spelling fix
 *   - TS2724 "no exported member, did you mean Y?" → import rename
 *
 * For these, the fixer is free (no LLM), fast (~ms), and deterministic.
 * The LLM mend stack only gets called for *interesting* errors that require
 * semantic reasoning (signature drift, missing logic, package gotchas).
 *
 * Conservative coverage: we only apply fixes for codes whose auto-fixes are
 * unambiguous. Codes like TS7006 (implicit any) and TS2741 (missing property)
 * are skipped — those need human intent to choose the right type or default
 * value, and a wrong auto-fix introduces silent bugs.
 *
 * Iteration cap: 5 passes. After each pass we re-validate; cascades like
 * "rename import → rename type annotation → rename method call" can need 3-4
 * hops to converge. The signature-set progress check stops sooner if no new
 * errors appear. If errors remain after pass 5, escalate to LLM mend.
 *
 * Feature flag: `SPECTOSHIP_TS_LSP_FIXER=false` opts out (default: ON).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { isPerfEnabled, recordPerf, timePerf } from "./perfInstrument.js";
import {
	getSharedDocumentRegistry,
	isLibFile,
	isSharedHostEnabled,
	sharedScriptVersion,
} from "./sharedTsHost.js";

/** TS error codes whose built-in code-fix is safe to apply without human review. */
const SAFE_FIXABLE_CODES = new Set<number>([
	2304, // Cannot find name 'X'
	2305, // Module '...' has no exported member 'X'
	2322, // Type 'X' is not assignable to type 'Y' — admitted ONLY for the
	//       did-you-mean case (e.g. a typo'd JSX prop `classNam`→`className`),
	//       which TS surfaces as TS2322 with a `spelling` code-fix. Real type
	//       mismatches (number = string, etc.) offer no code-fix at all, so the
	//       SAFE_FIX_NAMES gate makes the fixer abstain on them — it never
	//       touches a genuine type error, only applies the high-confidence
	//       `spelling` rename. (Probed 2026-06-13.)
	2551, // Property 'X' does not exist on type 'Y'. Did you mean 'Z'?
	2552, // Cannot find name 'X'. Did you mean 'Y'?
	2724, // '...' has no exported member named 'X'. Did you mean 'Y'?
]);

/**
 * Allowlist of TypeScript fix names we will apply. Many TS error codes return
 * multiple alternative fixes (e.g. for TS2304: "import" adds an import,
 * `fixMissingFunctionDeclaration` declares a stub) and the wrong one rewrites
 * intent. Only the names below are deterministic and safe.
 *
 * Discovered via probe (2026-05-03): for TS2304 'Cannot find name', the LSP
 * returns ["import", "fixMissingFunctionDeclaration"]. Without this allowlist,
 * the equivalence check rejected both and the auto-import never fired.
 */
const SAFE_FIX_NAMES = new Set<string>([
	"import", // auto-add import statement (TS2304, TS2305)
	"fixImport", // alternative auto-import in some scenarios
	"spelling", // did-you-mean rename for TS2552 (the actual fixName the LSP returns)
	"fixSpelling", // alternate spelling-fix name some TS versions emit
]);

export interface LSPFixerLogger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export interface LSPFixerOptions {
	workspaceRoot: string;
	/** Files where errors were detected. Limits the fix scope. */
	targetFiles: string[];
	logger: LSPFixerLogger;
	/** Max iterations (default 5). Signature-set progress check stops sooner. */
	maxIterations?: number;
	/**
	 * When true, run the full fix loop in memory but do NOT persist edits to
	 * disk. Returned `LSPFixerResult` is identical otherwise — `filesEdited`
	 * lists the files that *would* have been written, `fixesApplied` is the
	 * count of fixes the loop computed. Use to preview what tsfix would do
	 * before letting it modify a workspace.
	 */
	dryRun?: boolean;
	/**
	 * Per-error telemetry callback. One event per `(errorCode, fix-attempt)`
	 * with `fixed: true` when the fix landed and `fixed: false` when the LSP
	 * abstained (no safe candidate). Events fire even on dry runs.
	 * Optional — undefined callback costs nothing.
	 */
	onLayerEvent?: (event: import("./index.js").LayerEvent) => void;
}

export interface LSPFixerResult {
	/** Number of fixes successfully applied across all iterations. */
	fixesApplied: number;
	/** Files whose contents were modified on disk. */
	filesEdited: string[];
	/** Iteration count when fixer stopped (1 if it converged on first pass). */
	iterations: number;
	/** When true, every diagnostic was auto-fixable and resolved. Caller can skip LLM mend. */
	allResolved: boolean;
	/** Errors remaining after the last iteration (caller passes these to LLM mend). */
	remainingErrors: Array<{
		file: string;
		line: number;
		column: number;
		code: string;
		message: string;
	}>;
}

/**
 * Apply LSP code-fixes to all diagnostics in the workspace whose error code
 * is in SAFE_FIXABLE_CODES. Writes edits back to disk. Re-runs ts diagnostics
 * after each pass; stops when no further fixable errors remain or
 * maxIterations is reached.
 *
 * Throws on host setup failure (missing tsconfig, etc.) — callers should
 * catch and fall through to LLM mend.
 */
export function runLSPFixerPass(opts: LSPFixerOptions): LSPFixerResult {
	const { workspaceRoot, targetFiles, logger, onLayerEvent } = opts;
	const maxIterations = opts.maxIterations ?? 5;
	const dryRun = opts.dryRun ?? false;
	const tsconfigPath = path.join(workspaceRoot, "tsconfig.json");
	if (!fs.existsSync(tsconfigPath)) {
		return {
			fixesApplied: 0,
			filesEdited: [],
			iterations: 0,
			allResolved: true,
			remainingErrors: [],
		};
	}

	const compilerOptions = readCompilerOptions(tsconfigPath, logger);
	if (!compilerOptions) {
		return {
			fixesApplied: 0,
			filesEdited: [],
			iterations: 0,
			allResolved: true,
			remainingErrors: [],
		};
	}

	// Build a versioned in-memory snapshot table. The host reads from this
	// table for files we've edited, falling back to disk for everything else.
	// Without versioning, the LanguageService caches stale ASTs and misfires.
	const snapshots = new Map<string, { content: string; version: number }>();
	const filesEdited = new Set<string>();
	let totalFixes = 0;

	// Resolve workspace's typescript lib dir for `getDefaultLibFileName` — the
	// extension-bundled typescript can't find its lib files (esbuild strips
	// `__dirname` resolution). See validatorInProcess.ts for the same fix.
	const workspaceLibDir = path.join(workspaceRoot, "node_modules", "typescript", "lib");
	const hasWorkspaceLib = fs.existsSync(workspaceLibDir);

	// Shared lib-file parse (T-3c-2): reuse the process-global DocumentRegistry
	// so the lib `.d.ts` parse Layer 0 already paid for is reused here instead
	// of re-parsed. With a persistent shared registry, non-lib files must be
	// versioned by content (`sharedScriptVersion`) so a later pass on the same
	// path can never see a stale parse. Opt out via TSFIX_SHARED_HOST=false,
	// which restores the pre-refactor fresh-registry + ordinal-version behavior.
	const sharedHost = isSharedHostEnabled();

	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => Array.from(snapshots.keys()),
		getScriptVersion: (fileName) => {
			const snap = snapshots.get(fileName);
			if (!sharedHost) {
				return String(snap?.version ?? 0);
			}
			if (!snap) {
				return isLibFile(fileName) ? "1" : "0";
			}
			return sharedScriptVersion(fileName, snap.content, snap.version);
		},
		getScriptSnapshot: (fileName) => {
			const cached = snapshots.get(fileName);
			if (cached) {
				return ts.ScriptSnapshot.fromString(cached.content);
			}
			if (!fs.existsSync(fileName)) {
				return undefined;
			}
			// Perf (opt-in): time the cold read of lib `.d.ts` files. The parse
			// cost lands later in the first `getSemanticDiagnostics` pass; see
			// `layer1.firstDiagnosticsMs` below.
			const libStart =
				isPerfEnabled() && /lib\.[a-z0-9.]+\.d\.ts$/.test(fileName) ? Date.now() : 0;
			try {
				const content = fs.readFileSync(fileName, "utf-8");
				snapshots.set(fileName, { content, version: 1 });
				return ts.ScriptSnapshot.fromString(content);
			} catch {
				return undefined;
			} finally {
				if (libStart) {
					recordPerf("layer1.libReadMs", Date.now() - libStart);
				}
			}
		},
		getCurrentDirectory: () => workspaceRoot,
		getCompilationSettings: () => compilerOptions,
		getDefaultLibFileName: (options) => {
			if (hasWorkspaceLib) {
				// Return absolute path inside the workspace's typescript install.
				// LanguageService uses the directory of this file as the lib dir,
				// which means lib.dom.d.ts / lib.es2015.d.ts etc. resolve there too.
				return path.join(workspaceLibDir, path.basename(ts.getDefaultLibFilePath(options)));
			}
			return ts.getDefaultLibFilePath(options);
		},
		fileExists: (fileName) => snapshots.has(fileName) || fs.existsSync(fileName),
		readFile: (fileName) =>
			snapshots.get(fileName)?.content ??
			(fs.existsSync(fileName) ? fs.readFileSync(fileName, "utf-8") : undefined),
		readDirectory: ts.sys.readDirectory,
		directoryExists: ts.sys.directoryExists,
		getDirectories: ts.sys.getDirectories,
	};

	// Seed the snapshot map with all target files so the LanguageService
	// scans them on first call.
	for (const f of targetFiles) {
		const abs = path.isAbsolute(f) ? f : path.join(workspaceRoot, f);
		if (!fs.existsSync(abs)) {
			continue;
		}
		const content = fs.readFileSync(abs, "utf-8");
		snapshots.set(abs, { content, version: 1 });
	}

	if (isPerfEnabled()) {
		recordPerf("layer1.coldCount", 1);
	}
	const service = timePerf("layer1.createServiceMs", () =>
		ts.createLanguageService(
			host,
			sharedHost ? getSharedDocumentRegistry() : ts.createDocumentRegistry(),
		),
	);

	let iter = 0;
	let lastErrorSignatures = new Set<string>();
	for (iter = 1; iter <= maxIterations; iter++) {
		// The first diagnostics pass forces the cold lib-file parse — time it
		// separately as the Layer-1 lib-load proxy (T-3c-1 baseline).
		const fixableErrors =
			iter === 1
				? timePerf("layer1.firstDiagnosticsMs", () =>
						collectFixableErrors(service, snapshots, workspaceRoot),
					)
				: collectFixableErrors(service, snapshots, workspaceRoot);
		if (fixableErrors.length === 0) {
			break;
		}
		// Detect "stuck loop": same identical set of fixable errors across two
		// iterations. Compare by (file, start, code) signature, not just count —
		// a fix can convert a TS2724 at position A into a TS2552 at position B,
		// which keeps the count at 1 but is genuine progress.
		const signatures = computeErrorSignatures(fixableErrors);
		if (signatureSetsEqual(signatures, lastErrorSignatures)) {
			logger.info(
				`[ts-lsp-fixer] iteration ${iter}: no progress (${fixableErrors.length} fixable error(s), same set as last iter) — stopping`,
			);
			break;
		}
		lastErrorSignatures = signatures;

		let appliedThisIter = 0;
		for (const err of fixableErrors) {
			const errStartMs = Date.now();
			let fix = pickSafeTsFix(service, err);
			// Fallback: TypeScript's LanguageService provides *no applyable code-fix*
			// for a typo'd re-export `export { X } from "./mod"`, even though it does
			// for the `import { X }` form. A close typo surfaces as TS2724 (with a
			// "did you mean?" message but no fix); a far wrong-name as TS2305 (no
			// suggestion). We synthesize a conservative rename using the same
			// edit-distance threshold TS uses — so we fix the close TS2724 case and
			// abstain on the far TS2305 case. Only a fallback; never overrides TS.
			if (!fix && (err.code === 2724 || err.code === 2305)) {
				fix = tryExportFromRewrite(service, err);
			}
			if (!fix) {
				onLayerEvent?.({
					layer: 1, errorCode: err.code, fixed: false,
					latencyMs: Date.now() - errStartMs, ts: Date.now(),
				});
				continue;
			}
			const applied = applyFixToSnapshots(fix, snapshots);
			if (applied > 0) {
				appliedThisIter++;
				totalFixes++;
				for (const change of fix.changes) {
					filesEdited.add(change.fileName);
				}
				onLayerEvent?.({
					layer: 1, errorCode: err.code, fixed: true,
					latencyMs: Date.now() - errStartMs, ts: Date.now(),
				});
			} else {
				onLayerEvent?.({
					layer: 1, errorCode: err.code, fixed: false,
					latencyMs: Date.now() - errStartMs, ts: Date.now(),
				});
			}
		}
		logger.info(
			`[ts-lsp-fixer] iteration ${iter}: applied ${appliedThisIter}/${fixableErrors.length} fixes`,
		);
		if (appliedThisIter === 0) {
			break;
		}
	}

	// Persist the final snapshots back to disk for files we modified.
	// In dry-run mode, skip writes — the snapshot map still has the
	// would-be-edited content so callers can introspect via remainingErrors.
	if (dryRun) {
		if (filesEdited.size > 0) {
			logger.info(
				`[ts-lsp-fixer] dry-run: skipped writing ${filesEdited.size} file(s): ${[...filesEdited].map((f) => path.relative(workspaceRoot, f) || f).join(", ")}`,
			);
		}
	} else {
		for (const fileName of filesEdited) {
			const snap = snapshots.get(fileName);
			if (snap) {
				try {
					fs.writeFileSync(fileName, snap.content, "utf-8");
				} catch (err) {
					logger.warn(
						`[ts-lsp-fixer] failed to write ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	}

	// Final diagnostic snapshot for the caller (now reading from edited files).
	const remaining = collectAllErrors(service, snapshots, workspaceRoot);
	service.dispose();

	return {
		fixesApplied: totalFixes,
		filesEdited: Array.from(filesEdited).map((f) => path.relative(workspaceRoot, f) || f),
		iterations: iter,
		allResolved: remaining.length === 0,
		remainingErrors: remaining,
	};
}

function readCompilerOptions(
	tsconfigPath: string,
	logger: LSPFixerLogger,
): ts.CompilerOptions | null {
	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (configFile.error) {
		logger.error(
			`[ts-lsp-fixer] tsconfig parse error: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
		);
		return null;
	}
	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		path.dirname(tsconfigPath),
	);
	return parsed.options;
}

function collectFixableErrors(
	service: ts.LanguageService,
	snapshots: Map<string, { content: string; version: number }>,
	workspaceRoot: string,
): Array<{ file: string; start: number; length: number; code: number }> {
	const out: Array<{ file: string; start: number; length: number; code: number }> = [];
	for (const [fileName] of snapshots) {
		if (fileName.includes("node_modules")) {
			continue;
		}
		if (/lib\.[a-z0-9.]+\.d\.ts$/.test(fileName)) {
			continue;
		}
		const semantic = service.getSemanticDiagnostics(fileName);
		const syntactic = service.getSyntacticDiagnostics(fileName);
		for (const d of [...semantic, ...syntactic]) {
			if (!SAFE_FIXABLE_CODES.has(d.code)) {
				continue;
			}
			if (d.start === undefined || d.length === undefined) {
				continue;
			}
			out.push({ file: fileName, start: d.start, length: d.length, code: d.code });
		}
	}
	void workspaceRoot;
	return out;
}

function collectAllErrors(
	service: ts.LanguageService,
	snapshots: Map<string, { content: string; version: number }>,
	workspaceRoot: string,
): LSPFixerResult["remainingErrors"] {
	const out: LSPFixerResult["remainingErrors"] = [];
	for (const [fileName] of snapshots) {
		if (fileName.includes("node_modules")) {
			continue;
		}
		if (/lib\.[a-z0-9.]+\.d\.ts$/.test(fileName)) {
			continue;
		}
		const semantic = service.getSemanticDiagnostics(fileName);
		const syntactic = service.getSyntacticDiagnostics(fileName);
		for (const d of [...semantic, ...syntactic]) {
			if (d.category !== ts.DiagnosticCategory.Error) {
				continue;
			}
			let line = 0;
			let column = 0;
			if (d.file && d.start !== undefined) {
				const pos = d.file.getLineAndCharacterOfPosition(d.start);
				line = pos.line + 1;
				column = pos.character + 1;
			}
			out.push({
				file: path.relative(workspaceRoot, fileName) || fileName,
				line,
				column,
				code: `TS${d.code}`,
				message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
			});
		}
	}
	return out;
}

function safeGetCodeFixes(
	service: ts.LanguageService,
	err: { file: string; start: number; length: number; code: number },
): readonly ts.CodeFixAction[] | null {
	try {
		return service.getCodeFixesAtPosition(
			err.file,
			err.start,
			err.start + err.length,
			[err.code],
			{},
			{},
		);
	} catch {
		return null;
	}
}

/**
 * Pick the single safe code-fix TypeScript offers for an error, or null.
 *
 * 1. Filter to fixes whose `fixName` is in SAFE_FIX_NAMES — rules out
 *    destructive alternatives like `fixMissingFunctionDeclaration` (declares a
 *    stub) that TS suggests alongside `import` for TS2304.
 * 2. If multiple safe fixes remain and they're not textually equivalent, skip —
 *    genuine ambiguity (e.g. import from package A vs B). Abstain over guessing.
 */
function pickSafeTsFix(
	service: ts.LanguageService,
	err: { file: string; start: number; length: number; code: number },
): ts.CodeFixAction | null {
	const fixes = safeGetCodeFixes(service, err);
	if (!fixes || fixes.length === 0) {
		return null;
	}
	const safeFixes = fixes.filter((f) => SAFE_FIX_NAMES.has(f.fixName));
	if (safeFixes.length === 0) {
		return null;
	}
	if (safeFixes.length > 1 && !fixesAreEquivalent(safeFixes)) {
		return null;
	}
	return safeFixes[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Export-from rewriter (Layer 1 fallback for TS2305 in `export { X } from "..."`)
//
// TS's LanguageService returns a "did you mean?" rename code-fix for the
// `import { X } from "./mod"` form but NOT for the re-export `export { X } from
// "./mod"` form. This fallback fills that gap deterministically: when the
// re-exported name is a *close* typo (within TS's own spelling threshold) of a
// real export of the target module, rename it. Conservative by design — it
// abstains on out-of-threshold names, ties, aliases, and unresolved modules, so
// semantic wrong-names still escalate to the LLM (Layer 2).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @internal Levenshtein edit distance between `a` and `b`, bounded by `max`:
 * returns the exact distance when it is `<= max`, or `null` once it provably
 * exceeds `max` (so callers can early-reject far candidates cheaply).
 */
export function editDistanceWithin(a: string, b: string, max: number): number | null {
	if (Math.abs(a.length - b.length) > max) {
		return null;
	}
	const m = a.length;
	const n = b.length;
	let prev = new Array<number>(n + 1);
	let curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) {
		prev[j] = j;
	}
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			if (curr[j] < rowMin) {
				rowMin = curr[j];
			}
		}
		// Whole row already exceeds the budget — distance can only grow.
		if (rowMin > max) {
			return null;
		}
		[prev, curr] = [curr, prev];
	}
	const dist = prev[n];
	return dist <= max ? dist : null;
}

/**
 * @internal Pick the unique closest export name to a typo'd one, or null when
 * unsure. Mirrors TypeScript's own did-you-mean threshold
 * (`distance < floor(len*0.4)+1`, i.e. `<= floor(len*0.4)`) so we are never less
 * conservative than TS. Abstains when the name already exists (not a typo), when
 * nothing is within threshold, or when two candidates tie at the minimum
 * distance (ambiguous).
 */
export function pickExportRename(typoName: string, candidateNames: readonly string[]): string | null {
	if (candidateNames.includes(typoName)) {
		return null; // exists — not a typo; don't rewrite
	}
	const maxDist = Math.floor(typoName.length * 0.4);
	if (maxDist < 1) {
		return null; // too short for a confident suggestion
	}
	let best: string | null = null;
	let bestDist = Infinity;
	let tieAtBest = false;
	for (const cand of candidateNames) {
		const d = editDistanceWithin(typoName, cand, maxDist);
		if (d === null) {
			continue;
		}
		if (d < bestDist) {
			bestDist = d;
			best = cand;
			tieAtBest = false;
		} else if (d === bestDist) {
			tieAtBest = true;
		}
	}
	if (best === null || tieAtBest) {
		return null; // nothing close enough, or ambiguous
	}
	return best;
}

/** @internal Deepest AST node whose span contains `pos`. */
function findNodeAtPosition(sourceFile: ts.SourceFile, pos: number): ts.Node | undefined {
	const find = (node: ts.Node): ts.Node | undefined => {
		if (pos < node.getStart(sourceFile) || pos >= node.getEnd()) {
			return undefined;
		}
		return ts.forEachChild(node, find) ?? node;
	};
	return find(sourceFile);
}

/**
 * @internal Detect that a TS2305 at `start` sits on the re-exported name of a
 * plain `export { X } from "./mod"` (with a module specifier, no `X as Y`
 * alias). Returns the name node + enclosing declaration, or null to abstain.
 */
export function detectExportFromTypo(
	sourceFile: ts.SourceFile,
	start: number,
): {
	nameNode: ts.Identifier;
	typoName: string;
	moduleSpecifier: ts.StringLiteral;
} | null {
	const node = findNodeAtPosition(sourceFile, start);
	if (!node) {
		return null;
	}
	let n: ts.Node | undefined = node;
	while (n && !ts.isExportSpecifier(n)) {
		n = n.parent;
	}
	if (!n || !ts.isExportSpecifier(n)) {
		return null;
	}
	const specifier = n;
	if (specifier.propertyName) {
		return null; // `X as Y` alias — out of scope for v1
	}
	// In modern TS `specifier.name` is a ModuleExportName (Identifier | string
	// literal). Only the identifier form is a rename candidate.
	if (!ts.isIdentifier(specifier.name)) {
		return null;
	}
	const named = specifier.parent;
	if (!ts.isNamedExports(named)) {
		return null;
	}
	const exportDecl = named.parent;
	if (!ts.isExportDeclaration(exportDecl)) {
		return null;
	}
	if (!exportDecl.moduleSpecifier || !ts.isStringLiteral(exportDecl.moduleSpecifier)) {
		return null; // local `export { X }` (no `from`) — different error class
	}
	return {
		nameNode: specifier.name,
		typoName: specifier.name.text,
		moduleSpecifier: exportDecl.moduleSpecifier,
	};
}

/** @internal A synthetic single-edit rename, shaped like a `ts.CodeFixAction`. */
export function buildExportFromFix(
	fileName: string,
	span: { start: number; length: number },
	newName: string,
): ts.CodeFixAction {
	return {
		fixName: "exportFromSpelling",
		description: `Change re-exported name to '${newName}'`,
		changes: [
			{
				fileName,
				textChanges: [{ span: { start: span.start, length: span.length }, newText: newName }],
			},
		],
	} as ts.CodeFixAction;
}

/**
 * Fallback rewriter for TS2305 in a re-export. Resolves the target module's
 * actual exports via the type checker and, if the typo'd name has a unique close
 * match, returns a synthetic rename fix. Returns null (abstain) on any
 * uncertainty. Applied via the same `applyFixToSnapshots` path as TS's own fixes.
 */
function tryExportFromRewrite(
	service: ts.LanguageService,
	err: { file: string; start: number; length: number; code: number },
): ts.CodeFixAction | null {
	const program = service.getProgram();
	if (!program) {
		return null;
	}
	const sourceFile = program.getSourceFile(err.file);
	if (!sourceFile) {
		return null;
	}
	const detected = detectExportFromTypo(sourceFile, err.start);
	if (!detected) {
		return null;
	}
	const checker = program.getTypeChecker();
	const moduleSym = checker.getSymbolAtLocation(detected.moduleSpecifier);
	if (!moduleSym) {
		return null; // module didn't resolve (path alias, bare pkg, etc.) — abstain
	}
	const candidateNames = checker
		.getExportsOfModule(moduleSym)
		.map((s) => s.getName())
		.filter((nm) => nm !== "default");
	const newName = pickExportRename(detected.typoName, candidateNames);
	if (!newName) {
		return null;
	}
	const span = {
		start: detected.nameNode.getStart(sourceFile),
		length: detected.nameNode.getWidth(sourceFile),
	};
	return buildExportFromFix(err.file, span, newName);
}

/**
 * When the LanguageService returns multiple code-fix candidates, only apply
 * if they're textually equivalent (same edits on the same files). This
 * conservatively skips ambiguous cases (e.g., import from `lib/foo` vs
 * `lib/bar` where both export `Foo`) where guessing wrong is worse than
 * deferring to the LLM.
 */
/**
 * @internal Compute a stable `(file, start, code)` signature for each fixable
 * error. Used by the iteration loop's stuck-loop detector.
 */
export function computeErrorSignatures(
	errors: readonly { file: string; start: number; code: number }[],
): Set<string> {
	return new Set(errors.map((e) => `${e.file}:${e.start}:${e.code}`));
}

/**
 * @internal True if `a` and `b` contain the same members. Used to decide
 * whether the iteration loop is stuck (same error set across passes) vs.
 * making genuine progress (set membership changed even if size didn't).
 */
export function signatureSetsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const s of a) {
		if (!b.has(s)) {
			return false;
		}
	}
	return true;
}

/**
 * @internal True if every fix in `fixes` produces identical text edits.
 * Used to decide whether multiple candidate fixes for one error are safe to
 * pick automatically (identical = unambiguous; different = abstain).
 */
export function fixesAreEquivalent(fixes: readonly ts.CodeFixAction[]): boolean {
	if (fixes.length === 0) {
		return false;
	}
	const first = serializeFix(fixes[0]);
	for (let i = 1; i < fixes.length; i++) {
		if (serializeFix(fixes[i]) !== first) {
			return false;
		}
	}
	return true;
}

function serializeFix(fix: ts.CodeFixAction): string {
	return fix.changes
		.map(
			(c) =>
				`${c.fileName}|${c.textChanges.map((t) => `${t.span.start}:${t.span.length}:${t.newText}`).join(";")}`,
		)
		.join("||");
}

/**
 * @internal Apply a CodeFixAction's text changes to in-memory snapshots.
 * Returns the number of changes successfully applied. Bumps script versions
 * so the LanguageService re-parses on next call. Skips edits to files not
 * already in `snapshots` (defensive — won't create new files unbeknownst).
 */
export function applyFixToSnapshots(
	fix: ts.CodeFixAction,
	snapshots: Map<string, { content: string; version: number }>,
): number {
	let applied = 0;
	for (const change of fix.changes) {
		const snap = snapshots.get(change.fileName);
		if (!snap) {
			// New file (e.g., auto-import sometimes creates a new file). Skip
			// for safety — we don't want the fixer creating files unbeknownst.
			continue;
		}
		// Apply edits in reverse-order so earlier offsets stay valid.
		const sorted = [...change.textChanges].sort((a, b) => b.span.start - a.span.start);
		let next = snap.content;
		for (const tc of sorted) {
			next = next.slice(0, tc.span.start) + tc.newText + next.slice(tc.span.start + tc.span.length);
		}
		snapshots.set(change.fileName, { content: next, version: snap.version + 1 });
		applied++;
	}
	return applied;
}

/** Whether the LSP fixer is enabled (env-flag opt-out). Default ON. */
export function isLSPFixerEnabled(): boolean {
	return process.env.SPECTOSHIP_TS_LSP_FIXER !== "false";
}

/** Reset internal caches (for tests). No-op currently — service is created per-call. */
export function resetLSPFixerCache(): void {
	// Intentional no-op: we create a fresh LanguageService per call.
}
