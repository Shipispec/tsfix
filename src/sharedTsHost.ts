/**
 * Shared TypeScript host primitives (Phase 3c — T-3c-2).
 *
 * Layer 0 (`validatorInProcess`, a `CompilerHost` + `createProgram`) and
 * Layer 1 (`tsLanguageServiceFixer`, a `LanguageServiceHost` +
 * `createLanguageService`) historically each parsed the compiler's lib
 * `.d.ts` files independently — two (often three) cold parses of
 * `lib.dom.d.ts`, `lib.es2020.d.ts`, … per fixture. See ARCHITECTURE.md §9 and
 * the §12 open question "should detection and fixing share a single Program?".
 *
 * This module unifies that parse behind ONE process-global
 * `ts.DocumentRegistry` — TypeScript's own primitive for sharing parsed +
 * bound `SourceFile`s across compilations:
 *
 *   - Layer 0 routes its `CompilerHost.getSourceFile` for lib files through
 *     {@link acquireSharedLibSourceFile}, which `acquireDocument`s from the
 *     shared registry.
 *   - Layer 1 hands {@link getSharedDocumentRegistry} to
 *     `createLanguageService`.
 *
 * Because both consult the same registry with the same compilation-settings
 * key and a constant version for the immutable lib files, each lib file is
 * parsed exactly once and reused by both layers (and across fixtures with
 * matching settings).
 *
 * We share the parse of the *workspace's* lib files — we do not bundle a copy
 * of `typescript`, so the lib-path bet (SIGN-102) is intact.
 *
 * Opt-out: `TSFIX_SHARED_HOST=false` restores the pre-refactor behavior
 * (independent parses, fresh per-call registry). The byte-identical-diagnostics
 * regression test runs both ways and asserts equality.
 */

import * as fs from "node:fs";
import * as ts from "typescript";

const LIB_FILE_RE = /lib\.[a-z0-9.]+\.d\.ts$/;

/** True for a TypeScript bundled lib declaration file (`lib.dom.d.ts`, …). */
export function isLibFile(fileName: string): boolean {
	return LIB_FILE_RE.test(fileName);
}

/** Whether the shared-host optimization is active. Default ON. */
export function isSharedHostEnabled(): boolean {
	return process.env.TSFIX_SHARED_HOST !== "false";
}

let registry: ts.DocumentRegistry | undefined;

/**
 * The one DocumentRegistry shared by Layer 0 and Layer 1. Lazily created so a
 * process that never type-checks pays nothing.
 */
export function getSharedDocumentRegistry(): ts.DocumentRegistry {
	if (!registry) {
		registry = ts.createDocumentRegistry();
	}
	return registry;
}

/** Lib text snapshots — each lib file is read from disk at most once per process. */
const libSnapshots = new Map<string, ts.IScriptSnapshot>();

/** Constant version for lib files: they are immutable for the process lifetime. */
const LIB_VERSION = "1";

/**
 * Acquire a parsed + bound lib `SourceFile` from the shared registry for use
 * by Layer 0's `createProgram`. Returns `undefined` for non-lib files or files
 * that can't be read (the caller falls back to the default host).
 *
 * The same registry, settings-derived bucket key, path, and constant version
 * are used by Layer 1's LanguageService, so the SourceFile is parsed once and
 * shared by both layers.
 */
export function acquireSharedLibSourceFile(
	fileName: string,
	options: ts.CompilerOptions,
): ts.SourceFile | undefined {
	if (!isLibFile(fileName)) {
		return undefined;
	}
	let snapshot = libSnapshots.get(fileName);
	if (!snapshot) {
		let text: string;
		try {
			text = fs.readFileSync(fileName, "utf-8");
		} catch {
			return undefined;
		}
		snapshot = ts.ScriptSnapshot.fromString(text);
		libSnapshots.set(fileName, snapshot);
	}
	return getSharedDocumentRegistry().acquireDocument(
		fileName,
		options,
		snapshot,
		LIB_VERSION,
		ts.ScriptKind.TS,
	);
}

/**
 * Version string for a Layer 1 script file in the shared registry.
 *
 * Lib files use a constant version (immutable, shared with Layer 0). All other
 * files are content-addressed: the version changes iff the content changes, so
 * the *persistent* shared registry can never hand back a stale parse of a file
 * whose content changed between passes, while identical content across passes
 * is still reused. `editVersion` (the in-pass snapshot version) is folded in so
 * that an in-memory edit always bumps the version even in the astronomically
 * unlikely event of a hash collision.
 */
export function sharedScriptVersion(
	fileName: string,
	content: string,
	editVersion: number,
): string {
	if (isLibFile(fileName)) {
		return LIB_VERSION;
	}
	return `${editVersion}:${fnv1a(content)}`;
}

/** Small, fast, dependency-free string hash (FNV-1a, 32-bit). */
function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/** Reset all shared parse state. Tests + the opt-out regression path. */
export function resetSharedTsHost(): void {
	registry = undefined;
	libSnapshots.clear();
}
