import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The capture script is plain ESM (.mjs). We import its functions directly and
// drive `captureFixture` with an injected diagnostics source + a fixed clock,
// so the smoke test exercises the full capture flow on a sample broken
// workspace WITHOUT building dist/ or loading TypeScript — fast + deterministic.
import {
	captureFixture,
	contentHash,
	fixtureDirName,
	formatTimestamp,
	listSourceFiles,
	stripPackageJson,
} from "./capture-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

let workspace: string;
let fixturesRoot: string;

// A canned baseline so we don't need a real TS toolchain in the smoke test.
const FAKE_DIAGS = [
	{ file: "src/broken.ts", line: 1, column: 7, code: "2304", message: "Cannot find name 'foo'.", category: "error" },
	{ file: "src/broken.ts", line: 2, column: 1, code: "2552", message: "Cannot find name 'consol'.", category: "error" },
];
const fakeGather = async () => ({
	errorsBefore: 2,
	lspFixesApplied: 1,
	remainingByCode: { "2304": 1, "2552": 1 },
	remainingByFile: { "src/broken.ts": 2 },
	diagnostics: FAKE_DIAGS,
});

const FIXED = new Date(Date.UTC(2026, 5, 10, 12, 30, 45)); // 2026-06-10 12:30:45 UTC

function makeBrokenWorkspace(): string {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-capture-test-"));
	fs.writeFileSync(
		path.join(ws, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }, null, 2),
	);
	fs.writeFileSync(
		path.join(ws, "package.json"),
		JSON.stringify({
			name: "demo-app",
			version: "1.2.3",
			type: "module",
			scripts: { build: "tsc", test: "vitest" },
			dependencies: { zod: "^3.0.0" },
			devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0" },
		}),
	);
	fs.writeFileSync(path.join(ws, "package-lock.json"), JSON.stringify({ name: "demo-app", lockfileVersion: 3 }));
	fs.mkdirSync(path.join(ws, "src"));
	fs.writeFileSync(path.join(ws, "src", "broken.ts"), "export const x = foo;\nconsol.log(x);\n");
	// noise that must be skipped
	fs.mkdirSync(path.join(ws, "node_modules"));
	fs.writeFileSync(path.join(ws, "node_modules", "ignored.ts"), "export const ignored = 1;\n");
	return ws;
}

beforeEach(() => {
	workspace = makeBrokenWorkspace();
	fixturesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-capture-fixtures-"));
});

afterEach(() => {
	for (const d of [workspace, fixturesRoot]) {
		if (d) fs.rmSync(d, { recursive: true, force: true });
	}
});

describe("capture-fixture — helpers", () => {
	it("formatTimestamp emits UTC YYYYMMDD-HHMMSS", () => {
		expect(formatTimestamp(FIXED)).toBe("20260610-123045");
	});

	it("contentHash is deterministic + content-addressed (8 hex chars)", () => {
		const sources = listSourceFiles(workspace);
		const h1 = contentHash(workspace, sources);
		expect(h1).toMatch(/^[0-9a-f]{8}$/);
		expect(contentHash(workspace, sources)).toBe(h1); // stable
		// changing source content changes the hash
		fs.writeFileSync(path.join(workspace, "src", "broken.ts"), "export const y = 2;\n");
		expect(contentHash(workspace, listSourceFiles(workspace))).not.toBe(h1);
	});

	it("listSourceFiles skips node_modules", () => {
		const sources = listSourceFiles(workspace);
		expect(sources).toContain(path.join("src", "broken.ts"));
		expect(sources.some((s) => s.includes("node_modules"))).toBe(false);
	});

	it("stripPackageJson keeps deps, drops scripts + devDependencies", () => {
		const stripped = stripPackageJson(path.join(workspace, "package.json")) as Record<string, unknown>;
		expect(stripped.dependencies).toEqual({ zod: "^3.0.0" });
		expect(stripped.type).toBe("module");
		expect(stripped.scripts).toBeUndefined();
		expect(stripped.devDependencies).toBeUndefined();
		expect(stripped.name).toBe("captured-demo-app");
	});
});

describe("capture-fixture — captureFixture (strategy (a))", () => {
	it("writes a real-<timestamp>-<hash> fixture with all required artifacts", async () => {
		const result = await captureFixture({
			workspaceAbs: workspace,
			root: path.resolve(here, ".."),
			fixturesRoot,
			description: "demo capture",
			sharedDeps: false,
			commitLocked: true,
			gatherDiagnostics: fakeGather,
			now: () => FIXED,
		});

		const expectedHash = contentHash(workspace, listSourceFiles(workspace));
		expect(result.dirName).toBe(fixtureDirName(FIXED, expectedHash));
		expect(result.dirName).toMatch(/^real-20260610-123045-[0-9a-f]{8}$/);

		const dir = result.fixtureDir;
		// required artifacts
		for (const f of ["tsconfig.json", "package.json", "expected.json", "diagnostics.json", "setup.sh", "README.md", "package-lock.json"]) {
			expect(fs.existsSync(path.join(dir, f)), `missing ${f}`).toBe(true);
		}
		// broken source preserved with structure
		expect(fs.existsSync(path.join(dir, "src", "broken.ts"))).toBe(true);

		// expected.json: mustPass:false default + measured errorsBefore
		const expected = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf-8"));
		expect(expected.mustPass).toBe(false);
		expect(expected.errorsBefore).toBe(2);
		expect(expected.errorsAfterMax).toBe(2); // lenient at capture time
		expect(expected.description).toBe("demo capture");
		// must NOT carry Layer-2 routing markers (would leave the free benchmark)
		expect(expected.costUsdMax).toBeUndefined();
		expect(expected.expectedErrorCode).toBeUndefined();

		// diagnostics.json: the broken snapshot's Diagnostic[]
		const diags = JSON.parse(fs.readFileSync(path.join(dir, "diagnostics.json"), "utf-8"));
		expect(diags).toEqual(FAKE_DIAGS);

		// setup.sh: npm ci on demand, executable
		const setup = fs.readFileSync(path.join(dir, "setup.sh"), "utf-8");
		expect(setup).toContain("npm ci");
		expect(setup).toContain("--ignore-scripts");
		expect(fs.statSync(path.join(dir, "setup.sh")).mode & 0o111).toBeTruthy();

		// strategy (a): no node_modules symlink committed
		expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(false);
	});

	it("--shared-deps symlinks node_modules and skips setup.sh", async () => {
		const result = await captureFixture({
			workspaceAbs: workspace,
			fixturesRoot,
			sharedDeps: true,
			gatherDiagnostics: fakeGather,
			now: () => FIXED,
		});
		const link = path.join(result.fixtureDir, "node_modules");
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(path.join(result.fixtureDir, "setup.sh"))).toBe(false);
	});

	it("rejects a workspace without tsconfig.json", async () => {
		const noTsconfig = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-capture-bad-"));
		try {
			await expect(
				captureFixture({ workspaceAbs: noTsconfig, fixturesRoot, gatherDiagnostics: fakeGather, now: () => FIXED }),
			).rejects.toThrow(/tsconfig\.json/);
		} finally {
			fs.rmSync(noTsconfig, { recursive: true, force: true });
		}
	});
});
