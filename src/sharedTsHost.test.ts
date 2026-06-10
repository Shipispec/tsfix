import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValidationLoop } from "./index.js";
import { resetInProcessTscCache } from "./validatorInProcess.js";
import {
	acquireSharedLibSourceFile,
	getSharedDocumentRegistry,
	isLibFile,
	resetSharedTsHost,
} from "./sharedTsHost.js";

// T-3c-2 regression net. The shared-host optimization unifies Layer 0's
// CompilerHost and Layer 1's LanguageService behind one DocumentRegistry so
// the compiler lib `.d.ts` files parse exactly once. These tests pin the two
// invariants that make that safe: (1) the lib parse is genuinely shared (same
// SourceFile instance), and (2) the diagnostics are byte-identical to the
// pre-refactor path (TSFIX_SHARED_HOST=false).

const noopLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

describe("sharedTsHost — single lib parse", () => {
	afterEach(() => {
		resetSharedTsHost();
	});

	it("classifies compiler lib files", () => {
		expect(isLibFile("/x/typescript/lib/lib.es2020.d.ts")).toBe(true);
		expect(isLibFile("/x/typescript/lib/lib.dom.d.ts")).toBe(true);
		expect(isLibFile("/x/src/lib.ts")).toBe(false);
		expect(isLibFile("/x/node_modules/react/index.d.ts")).toBe(false);
	});

	it("parses each lib file exactly once (same SourceFile instance reused)", () => {
		resetSharedTsHost();
		const libPath = require.resolve("typescript/lib/lib.es2020.d.ts");
		const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2020 };

		const a = acquireSharedLibSourceFile(libPath, options);
		const b = acquireSharedLibSourceFile(libPath, options);

		expect(a).toBeDefined();
		expect(a).toBe(b); // identity ⇒ parsed once, served from the shared registry
		// And the same registry instance backs subsequent acquisitions.
		const before = getSharedDocumentRegistry();
		expect(getSharedDocumentRegistry()).toBe(before);
	});

	it("returns undefined for non-lib files", () => {
		expect(acquireSharedLibSourceFile("/x/src/app.ts", {})).toBeUndefined();
	});
});

describe("sharedTsHost — byte-identical diagnostics vs pre-refactor", () => {
	let workspace: string;
	const prev = process.env.TSFIX_SHARED_HOST;

	beforeEach(() => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "shared-host-test-"));
		fs.writeFileSync(
			path.join(workspace, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2020",
					lib: ["dom", "dom.iterable", "esnext"],
					strict: true,
					esModuleInterop: true,
					skipLibCheck: true,
					noEmit: true,
					module: "esnext",
					moduleResolution: "bundler",
				},
				include: ["**/*.ts", "**/*.tsx"],
			}),
		);
		fs.mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
		const realTsDir = path.dirname(require.resolve("typescript/package.json"));
		fs.symlinkSync(realTsDir, path.join(workspace, "node_modules", "typescript"));

		const write = (rel: string, content: string): void => {
			const full = path.join(workspace, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, content);
		};
		// Clean file exercising globals (lib resolution must work).
		write(
			"src/globals.ts",
			"export const ok: Promise<number[]> = Promise.resolve([1, 2, 3]);\n",
		);
		// A TS2552 typo the LSP fixer recognizes (consol → console) plus a
		// genuinely unknown symbol that survives — both layers must agree.
		write(
			"src/typo.ts",
			["export function f(): void {", "  consol.log('hi');", "}", "", "export const z = nope;", ""].join(
				"\n",
			),
		);
	});

	afterEach(() => {
		if (prev === undefined) {
			delete process.env.TSFIX_SHARED_HOST;
		} else {
			process.env.TSFIX_SHARED_HOST = prev;
		}
		resetSharedTsHost();
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	function runDry(): ReturnType<typeof runValidationLoop> {
		resetSharedTsHost();
		resetInProcessTscCache();
		// dryRun keeps the fixtures on disk unchanged so both passes see the
		// same input; the full Layer 0 + Layer 1 path still runs.
		return runValidationLoop({
			workspaceRoot: workspace,
			targetFiles: ["src/globals.ts", "src/typo.ts"],
			dryRun: true,
			logger: noopLogger,
		});
	}

	it("produces identical diagnostics and fix counts with the shared host on vs off", () => {
		process.env.TSFIX_SHARED_HOST = "false";
		const off = runDry();

		delete process.env.TSFIX_SHARED_HOST; // default ON
		const on = runDry();

		expect(on.diagnostics).toEqual(off.diagnostics);
		expect(on.errorsBefore).toEqual(off.errorsBefore);
		expect(on.lspFixer.fixesApplied).toEqual(off.lspFixer.fixesApplied);
		expect(on.lspFixer.filesEdited).toEqual(off.lspFixer.filesEdited);
		expect(on.remainingByCode).toEqual(off.remainingByCode);
		// Sanity: the workspace really did have errors and the fixer engaged.
		expect(off.errorsBefore).toBeGreaterThan(0);
	});
});
