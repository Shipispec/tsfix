import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValidationLoop } from "./index.js";

// Behavioral test for the --dry-run flag (added in 0.1.1).
// In dry-run mode, the LSP fixer must:
//   - Compute the same fixes it would normally apply
//   - Report them via lspFixer.fixesApplied + filesEdited
//   - NOT mutate any file on disk
// Without this, the CLI's footgun (running tsfix against a fixture
// silently fixes the broken code) cannot be safely worked around.

const noopLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

describe("runValidationLoop — dryRun option", () => {
	let workspace: string;
	const brokenSource =
		"// typo: 'consol' should be 'console'\n" +
		"export function shout(s: string): void { consol.log(s); }\n";

	beforeEach(() => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-dryrun-"));
		fs.writeFileSync(
			path.join(workspace, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2020",
					strict: true,
					noEmit: true,
					module: "esnext",
					moduleResolution: "bundler",
				},
				include: ["**/*.ts"],
			}),
		);
		fs.mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
		const realTsDir = path.dirname(require.resolve("typescript/package.json"));
		fs.symlinkSync(realTsDir, path.join(workspace, "node_modules", "typescript"));
		fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
		fs.writeFileSync(path.join(workspace, "src", "broken.ts"), brokenSource);
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	function readBroken(): string {
		return fs.readFileSync(path.join(workspace, "src", "broken.ts"), "utf-8");
	}

	it("dryRun: false (default) writes fixes to disk", () => {
		const result = runValidationLoop({
			workspaceRoot: workspace,
			targetFiles: ["src/broken.ts"],
			logger: noopLogger,
		});

		expect(result.errorsBefore).toBeGreaterThan(0);
		expect(result.lspFixer.fixesApplied).toBeGreaterThan(0);
		expect(result.lspFixer.filesEdited.length).toBeGreaterThan(0);
		// Disk WAS mutated.
		expect(readBroken()).toContain("console.log");
		expect(readBroken()).not.toContain("consol.log");
	});

	it("dryRun: true reports the fix count but does NOT write to disk", () => {
		const result = runValidationLoop({
			workspaceRoot: workspace,
			targetFiles: ["src/broken.ts"],
			dryRun: true,
			logger: noopLogger,
		});

		expect(result.errorsBefore).toBeGreaterThan(0);
		// Fixer ran in memory and reported what it WOULD do.
		expect(result.lspFixer.fixesApplied).toBeGreaterThan(0);
		expect(result.lspFixer.filesEdited.length).toBeGreaterThan(0);
		// Disk was NOT mutated — the typo is still there.
		expect(readBroken()).toContain("consol.log");
		expect(readBroken()).not.toContain("console.log");
	});

	it("dryRun on a clean workspace returns errorsBefore: 0 and does no work", () => {
		fs.writeFileSync(
			path.join(workspace, "src", "broken.ts"),
			"export function ok(): void { console.log('hi'); }\n",
		);

		const result = runValidationLoop({
			workspaceRoot: workspace,
			targetFiles: ["src/broken.ts"],
			dryRun: true,
			logger: noopLogger,
		});

		expect(result.errorsBefore).toBe(0);
		expect(result.lspFixer.fixesApplied).toBe(0);
		expect(result.passed).toBe(true);
	});
});
