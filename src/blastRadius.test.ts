import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcessTsc } from "./validatorInProcess.js";
import type { Diagnostic } from "./index.js";
import { computeBlastRadius } from "./blastRadius.js";
import { resetSharedTsHost } from "./sharedTsHost.js";

// Driving through `runInProcessTsc` (rather than synthesizing diagnostics by
// hand) keeps line/column numbers honest — they come from the same code path
// the runtime emits, so a refactor of either side can't silently desync.

const require = createRequire(import.meta.url);
const noopLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

function setupWorkspace(): string {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tsmend-blastradius-"));
	fs.mkdirSync(path.join(ws, "node_modules"), { recursive: true });
	const realTs = path.dirname(require.resolve("typescript/package.json"));
	fs.symlinkSync(realTs, path.join(ws, "node_modules", "typescript"));
	fs.writeFileSync(
		path.join(ws, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				target: "ES2020",
				module: "esnext",
				moduleResolution: "bundler",
				strict: true,
				noEmit: true,
				esModuleInterop: true,
				skipLibCheck: true,
			},
			include: ["**/*.ts"],
		}),
	);
	return ws;
}

describe("computeBlastRadius", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = setupWorkspace();
		resetSharedTsHost();
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
		resetSharedTsHost();
	});

	it("collects the full cross-file reference set for a multi-file symbol", () => {
		// `User` is declared in one file and referenced from three others. One
		// usage is broken (missing a required property → TS2741). The blast
		// radius of that single error must span EVERY file touching `User`.
		fs.writeFileSync(
			path.join(workspace, "user.ts"),
			"export interface User {\n  id: string;\n  name: string;\n}\n",
		);
		fs.writeFileSync(
			path.join(workspace, "a.ts"),
			'import type { User } from "./user.js";\n' +
				'export const a: User = { id: "1", name: "alice" };\n',
		);
		fs.writeFileSync(
			path.join(workspace, "b.ts"),
			'import type { User } from "./user.js";\n' +
				"export function pick(u: User): string {\n  return u.name;\n}\n",
		);
		// The broken usage: missing `name` → TS2741.
		fs.writeFileSync(
			path.join(workspace, "c.ts"),
			'import type { User } from "./user.js";\n' +
				'export const c: User = { id: "3" };\n',
		);

		const tsc = runInProcessTsc({
			workspaceRoot: workspace,
			generatedFiles: ["a.ts", "b.ts", "c.ts"],
			logger: noopLogger,
		});
		const diag = tsc.diagnostics.find((d: Diagnostic) => d.code === "TS2741");
		expect(diag, "expected a TS2741 diagnostic from the missing property").toBeDefined();

		const result = computeBlastRadius({
			workspaceRoot: workspace,
			diagnostics: [diag!],
		});

		expect(result.symbols.length).toBe(1);
		const radius = result.symbols[0];
		expect(radius.symbol).toBe("User");
		expect(radius.declarationFile).toContain("user.ts");

		// Every file that touches `User` must appear in the reference set —
		// the declaration plus all three importers.
		const refFiles = new Set(radius.references.map((r) => r.file));
		expect(refFiles).toContain("user.ts");
		expect(refFiles).toContain("a.ts");
		expect(refFiles).toContain("b.ts");
		expect(refFiles).toContain("c.ts");

		// References carry 1-indexed positions and are sorted deterministically.
		for (const ref of radius.references) {
			expect(ref.line).toBeGreaterThan(0);
			expect(ref.col).toBeGreaterThan(0);
		}
		const sorted = [...radius.references].sort(
			(x, y) => x.file.localeCompare(y.file) || x.line - y.line || x.col - y.col,
		);
		expect(radius.references).toEqual(sorted);
	});

	it("dedupes to one entry when two diagnostics concern the same symbol", () => {
		fs.writeFileSync(
			path.join(workspace, "user.ts"),
			"export interface User {\n  id: string;\n  name: string;\n}\n",
		);
		fs.writeFileSync(
			path.join(workspace, "c.ts"),
			'import type { User } from "./user.js";\n' +
				'export const c: User = { id: "3" };\n',
		);
		fs.writeFileSync(
			path.join(workspace, "d.ts"),
			'import type { User } from "./user.js";\n' +
				'export const d: User = { id: "4" };\n',
		);

		const tsc = runInProcessTsc({
			workspaceRoot: workspace,
			generatedFiles: ["c.ts", "d.ts"],
			logger: noopLogger,
		});
		const diags = tsc.diagnostics.filter((d: Diagnostic) => d.code === "TS2741");
		expect(diags.length).toBeGreaterThanOrEqual(2);

		const result = computeBlastRadius({ workspaceRoot: workspace, diagnostics: diags });
		// Both errors resolve to `User` → a single deduped blast-radius entry.
		expect(result.symbols.length).toBe(1);
		expect(result.symbols[0].symbol).toBe("User");
	});

	it("returns an empty blast radius when the error resolves to no user-land symbol", () => {
		// A primitive type-mismatch: every type involved (number, string) is a
		// lib type, so there is no user-land symbol to span — zero references.
		fs.writeFileSync(
			path.join(workspace, "broken.ts"),
			"export const x: number = 'hello';\n",
		);
		const tsc = runInProcessTsc({
			workspaceRoot: workspace,
			generatedFiles: ["broken.ts"],
			logger: noopLogger,
		});
		const diag = tsc.diagnostics.find((d: Diagnostic) => d.category === "error");
		expect(diag).toBeDefined();

		const result = computeBlastRadius({
			workspaceRoot: workspace,
			diagnostics: [diag!],
		});
		expect(result.symbols).toEqual([]);
	});
});
