import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetInProcessTscCache, runInProcessTsc } from "./validatorInProcess.js";

// The reason this package overrides ts.getDefaultLibFilePath: when esbuild
// bundles us into the VS Code Extension Host, the bundled TypeScript's
// default lib path resolves to a path inside the bundle that doesn't
// actually contain lib.*.d.ts. We must use the workspace's installed
// typescript instead. These tests pin that behavior — if the override
// regresses, code that relies on globals (Promise, console, Array, JSON)
// will fail with TS2304 "Cannot find name".

const noopLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

describe("runInProcessTsc — lib-path override", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "validator-test-"));
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
		// Symlink the test's own typescript install (resolved via require) into
		// the workspace so the lib-path override has something to point at.
		fs.mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
		const realTsDir = path.dirname(require.resolve("typescript/package.json"));
		fs.symlinkSync(realTsDir, path.join(workspace, "node_modules", "typescript"));

		resetInProcessTscCache();
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	function write(rel: string, content: string): void {
		const full = path.join(workspace, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}

	it("resolves built-in globals (Promise, console, Array, JSON) without TS2304", () => {
		write(
			"src/uses-globals.ts",
			[
				"export function demo(): Promise<void> {",
				"  console.log('hi');",
				"  const arr: Array<number> = [1, 2, 3];",
				"  return Promise.resolve(JSON.parse(JSON.stringify(arr)) as void);",
				"}",
				"",
			].join("\n"),
		);

		const result = runInProcessTsc({
			workspaceRoot: workspace,
			generatedFiles: ["src/uses-globals.ts"],
			logger: noopLogger,
		});

		const errors = result.diagnostics.filter((d) => d.category === "error");
		// Codes are stringified as `"TS<n>"` by the validator's serializer.
		const ts2304 = errors.filter((d) => d.code === "TS2304");
		expect(ts2304).toEqual([]);
		// Sanity: a file using only well-known globals should produce zero errors.
		expect(errors).toEqual([]);
	});

	it("returns structured TS2304 when a name is genuinely unknown", () => {
		// Negative-test: confirms we're not just suppressing all TS2304.
		write("src/bad.ts", "export const x = totallyUndefinedSymbol;\n");

		const result = runInProcessTsc({
			workspaceRoot: workspace,
			generatedFiles: ["src/bad.ts"],
			logger: noopLogger,
		});

		const errors = result.diagnostics.filter((d) => d.category === "error");
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((d) => d.code === "TS2304")).toBe(true);
		// Diagnostic shape per InProcessTscResult: file/line/column/code/category/message.
		const e = errors[0];
		expect(e.file).toContain("bad.ts");
		expect(typeof e.line).toBe("number");
		expect(typeof e.column).toBe("number");
		expect(typeof e.code).toBe("string");
		expect(e.code).toMatch(/^TS\d+$/);
	});
});
