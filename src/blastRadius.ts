/**
 * Deterministic blast-radius computation (Phase 4 — T-4-1).
 *
 * Layer 3's multi-file mend needs to know, for every error that survived
 * Layers 0/1, the FULL set of places across the workspace that touch the
 * symbol behind that error. A locally-obvious single-file fix can ripple:
 * renaming/retyping a symbol in its declaration file breaks every importer.
 * To give the LLM one coherent multi-file prompt (T-4-3) we first compute the
 * blast radius deterministically — no model involved.
 *
 * The mechanism is TypeScript's own cross-file reference finder: resolve each
 * surviving diagnostic to the user-land symbol it concerns (the same
 * TypeChecker walk `typeContext.ts` uses), then call
 * `LanguageService.findReferences()` at that symbol's declaration to gather
 * every reference site spanning the project.
 *
 * Properties:
 *   - Pure + deterministic: no LLM, no disk writes, single pass.
 *   - Reuses the shared `ts.DocumentRegistry` (`sharedTsHost.ts`) so the lib
 *     `.d.ts` files Layers 0/1 already parsed are not re-parsed (SIGN-102 — we
 *     load the *workspace's* typescript via the lib-path workaround, never a
 *     bundled copy).
 *   - Independently useful: could back a future `--blast-radius` diagnostic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import type { Diagnostic } from "./index.js";
import {
	getSharedDocumentRegistry,
	isLibFile,
	isSharedHostEnabled,
	sharedScriptVersion,
} from "./sharedTsHost.js";

export interface BlastRadiusOptions {
	/** Absolute path to the workspace (must contain tsconfig.json). */
	workspaceRoot: string;
	/** Diagnostics that survived Layers 0/1 (from `runInProcessTsc` or compatible). */
	diagnostics: readonly Diagnostic[];
}

/** A single reference site, workspace-relative with 1-indexed line/col. */
export interface BlastRadiusReference {
	file: string;
	line: number;
	col: number;
}

/** The cross-file reach of one error symbol. */
export interface SymbolBlastRadius {
	/** The resolved symbol name (e.g. `User`). */
	symbol: string;
	/** Workspace-relative file declaring the symbol. */
	declarationFile: string;
	/** Every reference to the symbol across the workspace (includes the
	 *  declaration site). Deduplicated by (file, line, col), sorted. */
	references: BlastRadiusReference[];
}

export interface BlastRadiusResult {
	/** One entry per distinct error symbol, deduped across the input diagnostics. */
	symbols: SymbolBlastRadius[];
}

interface Snapshot {
	content: string;
}

/** Build a read-only LanguageService over the whole project. */
function buildService(
	workspaceRoot: string,
	parsed: ts.ParsedCommandLine,
): { service: ts.LanguageService; snapshots: Map<string, Snapshot> } | null {
	const snapshots = new Map<string, Snapshot>();
	// Seed EVERY project file so `findReferences` can search the whole
	// workspace, not just the files an error happens to live in.
	for (const f of parsed.fileNames) {
		try {
			snapshots.set(f, { content: fs.readFileSync(f, "utf-8") });
		} catch {
			// Unreadable file — skip; it just won't be searched.
		}
	}

	// Lib-path workaround — same bet as validatorInProcess / tsLanguageServiceFixer:
	// point the host at the WORKSPACE's typescript lib dir (no bundling, SIGN-102).
	const workspaceLibDir = path.join(workspaceRoot, "node_modules", "typescript", "lib");
	const hasWorkspaceLib = fs.existsSync(workspaceLibDir);

	const sharedHost = isSharedHostEnabled();

	const host: ts.LanguageServiceHost = {
		getScriptFileNames: () => Array.from(snapshots.keys()),
		getScriptVersion: (fileName) => {
			const snap = snapshots.get(fileName);
			if (!sharedHost) {
				return "1";
			}
			if (!snap) {
				return isLibFile(fileName) ? "1" : "0";
			}
			// Content-address non-lib files so the persistent shared registry can
			// never hand back a stale parse (see sharedTsHost.ts).
			return sharedScriptVersion(fileName, snap.content, 1);
		},
		getScriptSnapshot: (fileName) => {
			const cached = snapshots.get(fileName);
			if (cached) {
				return ts.ScriptSnapshot.fromString(cached.content);
			}
			if (!fs.existsSync(fileName)) {
				return undefined;
			}
			try {
				const content = fs.readFileSync(fileName, "utf-8");
				snapshots.set(fileName, { content });
				return ts.ScriptSnapshot.fromString(content);
			} catch {
				return undefined;
			}
		},
		getCurrentDirectory: () => workspaceRoot,
		getCompilationSettings: () => parsed.options,
		getDefaultLibFileName: (options) => {
			if (hasWorkspaceLib) {
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

	let service: ts.LanguageService;
	try {
		service = ts.createLanguageService(
			host,
			sharedHost ? getSharedDocumentRegistry() : ts.createDocumentRegistry(),
		);
	} catch {
		return null;
	}
	return { service, snapshots };
}

/** Deepest descendant whose span contains `position`. */
function getNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node {
	let result: ts.Node = sourceFile;
	function walk(node: ts.Node): void {
		ts.forEachChild(node, (child) => {
			if (position >= child.getStart(sourceFile) && position < child.getEnd()) {
				result = child;
				walk(child);
				return true;
			}
			return false;
		});
	}
	walk(sourceFile);
	return result;
}

/**
 * Resolve the error node to the user-land symbol it concerns and locate that
 * symbol's declaration name. Mirrors `typeContext.ts`'s walk-up: bounded at 4
 * hops, with the TS2339 escape (the interesting type lives on the LEFT operand
 * of a property access, a sibling not an ancestor). All TypeChecker calls are
 * guarded — `getTypeAtLocation` can throw deep in TS internals on unresolvable
 * nodes (rename cascades, branded types).
 */
function resolveSymbolDeclaration(
	checker: ts.TypeChecker,
	startNode: ts.Node,
): { declNameNode: ts.Node; symbolName: string } | undefined {
	const tryResolve = (n: ts.Node) => {
		let type: ts.Type;
		try {
			type = checker.getTypeAtLocation(n);
		} catch {
			return undefined;
		}
		let symbol: ts.Symbol | undefined;
		let declarations: ts.Declaration[] | undefined;
		try {
			symbol = type.getSymbol() ?? type.aliasSymbol;
			declarations = symbol?.getDeclarations();
		} catch {
			return undefined;
		}
		if (!declarations || declarations.length === 0) return undefined;
		const nonLib = declarations.find((d) => !isLibFile(d.getSourceFile().fileName));
		if (!nonLib) return undefined;
		// Prefer the declaration's name identifier as the findReferences anchor —
		// references resolve against the name, not the whole declaration span.
		const named = nonLib as ts.Declaration & { name?: ts.Node };
		const declNameNode = named.name ?? nonLib;
		return { declNameNode, symbolName: symbol?.getName() ?? "(unnamed)" };
	};

	let node: ts.Node | undefined = startNode;
	for (let i = 0; i < 4 && node; i++) {
		const direct = tryResolve(node);
		if (direct) return direct;
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			const sibling = tryResolve(node.expression);
			if (sibling) return sibling;
		}
		node = node.parent;
	}
	return undefined;
}

/**
 * Resolve the VALUE-level symbol an error identifier denotes (the variable,
 * function, or import binding itself — not its type). This is the anchor that
 * catches value-flow ripples the type walk misses: in the forcing fixture
 * `value * 2` errors with TS2362 whose type is the primitive `string`, so
 * `resolveSymbolDeclaration` finds no user-land *type*. But the `value` const
 * is a user symbol whose references span every consumer — exactly the
 * cross-file reach a multi-file mend must see.
 *
 * Narrow on purpose: only fires when the error node is itself an Identifier, so
 * it never adds noise for errors that point at object literals / expressions
 * (e.g. TS2741 points at the declaration name, handled by the type walk). Alias
 * import bindings are resolved to their real declaration so two consumers'
 * imports of the same symbol collapse to one blast-radius entry.
 */
function resolveValueSymbol(
	checker: ts.TypeChecker,
	errorNode: ts.Node,
): { declFileAbs: string; declPos: number; symbolName: string } | undefined {
	if (!ts.isIdentifier(errorNode)) return undefined;
	let symbol: ts.Symbol | undefined;
	try {
		symbol = checker.getSymbolAtLocation(errorNode);
	} catch {
		return undefined;
	}
	if (!symbol) return undefined;
	if (symbol.flags & ts.SymbolFlags.Alias) {
		try {
			symbol = checker.getAliasedSymbol(symbol);
		} catch {
			// Not actually aliased / unresolvable — keep the local binding.
		}
	}
	let declarations: ts.Declaration[] | undefined;
	try {
		declarations = symbol.getDeclarations();
	} catch {
		return undefined;
	}
	if (!declarations || declarations.length === 0) return undefined;
	const nonLib = declarations.find((d) => !isLibFile(d.getSourceFile().fileName));
	if (!nonLib) return undefined;
	const named = nonLib as ts.Declaration & { name?: ts.Node };
	const declNameNode = named.name ?? nonLib;
	const sf = declNameNode.getSourceFile();
	return {
		declFileAbs: sf.fileName,
		declPos: declNameNode.getStart(sf),
		symbolName: symbol.getName() ?? "(unnamed)",
	};
}

/** Gather every reference to the symbol anchored at (fileAbs, pos), workspace-
 *  relative + 1-indexed, deduped by (file,line,col) and sorted. */
function collectReferences(
	service: ts.LanguageService,
	program: ts.Program,
	workspaceRoot: string,
	fileAbs: string,
	pos: number,
): BlastRadiusReference[] {
	let referenced: readonly ts.ReferencedSymbol[] | undefined;
	try {
		referenced = service.findReferences(fileAbs, pos);
	} catch {
		referenced = undefined;
	}
	const refSet = new Map<string, BlastRadiusReference>();
	for (const rs of referenced ?? []) {
		for (const entry of rs.references) {
			const refSf = program.getSourceFile(entry.fileName);
			if (!refSf) continue;
			const lc = refSf.getLineAndCharacterOfPosition(entry.textSpan.start);
			const ref: BlastRadiusReference = {
				file: path.relative(workspaceRoot, entry.fileName) || entry.fileName,
				line: lc.line + 1,
				col: lc.character + 1,
			};
			refSet.set(`${ref.file}:${ref.line}:${ref.col}`, ref);
		}
	}
	return Array.from(refSet.values()).sort(
		(a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col,
	);
}

/** Count distinct files in a reference set. */
function distinctFiles(refs: readonly BlastRadiusReference[]): number {
	return new Set(refs.map((r) => r.file)).size;
}

/**
 * Compute the cross-file blast radius for each surviving diagnostic's symbol.
 *
 * For every diagnostic we resolve the symbol behind the error, then ask the
 * LanguageService for every reference to that symbol across the workspace.
 * Symbols are deduped (two diagnostics on the same type yield one entry), and
 * references are deduped and sorted for deterministic output.
 */
export function computeBlastRadius(opts: BlastRadiusOptions): BlastRadiusResult {
	const { workspaceRoot, diagnostics } = opts;

	const tsconfigPath = path.join(workspaceRoot, "tsconfig.json");
	if (!fs.existsSync(tsconfigPath)) return { symbols: [] };

	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
	if (configFile.error) return { symbols: [] };
	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		path.dirname(tsconfigPath),
	);

	const built = buildService(workspaceRoot, parsed);
	if (!built) return { symbols: [] };
	const { service } = built;

	try {
		const program = service.getProgram();
		if (!program) return { symbols: [] };
		const checker = program.getTypeChecker();

		const bySymbol = new Map<string, SymbolBlastRadius>();

		for (const diag of diagnostics) {
			const fileAbs = path.isAbsolute(diag.file)
				? diag.file
				: path.join(workspaceRoot, diag.file);
			const sourceFile = program.getSourceFile(fileAbs);
			if (!sourceFile) continue;

			let position: number;
			try {
				position = ts.getPositionOfLineAndCharacter(
					sourceFile,
					diag.line - 1,
					diag.column - 1,
				);
			} catch {
				continue;
			}

			const errorNode = getNodeAtPosition(sourceFile, position);

			// (1) Type-level anchor — the declaring type behind the error (e.g. an
			//     interface). Spans every file that names that type.
			const typeResolved = resolveSymbolDeclaration(checker, errorNode);
			if (typeResolved) {
				const { declNameNode, symbolName } = typeResolved;
				const declSourceFile = declNameNode.getSourceFile();
				const declFileAbs = declSourceFile.fileName;
				const namePos = declNameNode.getStart(declSourceFile);
				// Dedupe by declaration site — two errors on the same symbol collapse.
				const key = `${declFileAbs}:${namePos}`;
				if (!bySymbol.has(key)) {
					bySymbol.set(key, {
						symbol: symbolName,
						declarationFile: path.relative(workspaceRoot, declFileAbs) || declFileAbs,
						references: collectReferences(service, program, workspaceRoot, declFileAbs, namePos),
					});
				}
			}

			// (2) Value-level anchor — the variable / import binding the error
			//     identifier denotes. Catches value-flow ripples the type walk
			//     misses (e.g. `value * 2` on a primitive type). Only kept when its
			//     references genuinely span MORE THAN ONE file: a single-file symbol
			//     needs no multi-file coordination, so it is not a blast radius.
			const valueResolved = resolveValueSymbol(checker, errorNode);
			if (valueResolved) {
				const { declFileAbs, declPos, symbolName } = valueResolved;
				const key = `${declFileAbs}:${declPos}`;
				if (!bySymbol.has(key)) {
					const references = collectReferences(
						service,
						program,
						workspaceRoot,
						declFileAbs,
						declPos,
					);
					if (distinctFiles(references) > 1) {
						bySymbol.set(key, {
							symbol: symbolName,
							declarationFile: path.relative(workspaceRoot, declFileAbs) || declFileAbs,
							references,
						});
					}
				}
			}
		}

		const symbols = Array.from(bySymbol.values()).sort((a, b) =>
			a.declarationFile.localeCompare(b.declarationFile) || a.symbol.localeCompare(b.symbol),
		);
		return { symbols };
	} finally {
		service.dispose();
	}
}
