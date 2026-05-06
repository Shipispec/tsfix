import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverTsFiles,
	isInProcessTscEnabled,
	isLSPFixerEnabled,
	resetInProcessTscCache,
	resetLSPFixerCache,
	runInProcessTsc,
	runLSPFixerPass,
	runValidationLoop,
} from "./index.js";

describe("public API surface", () => {
	it("exports the documented functions", () => {
		expect(typeof runValidationLoop).toBe("function");
		expect(typeof runInProcessTsc).toBe("function");
		expect(typeof runLSPFixerPass).toBe("function");
		expect(typeof discoverTsFiles).toBe("function");
		expect(typeof isInProcessTscEnabled).toBe("function");
		expect(typeof isLSPFixerEnabled).toBe("function");
		expect(typeof resetInProcessTscCache).toBe("function");
		expect(typeof resetLSPFixerCache).toBe("function");
	});

	it("kill-switches default to enabled", () => {
		expect(isInProcessTscEnabled()).toBe(true);
		expect(isLSPFixerEnabled()).toBe(true);
	});
});

describe("discoverTsFiles", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "discover-test-"));
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	function touch(rel: string): void {
		const full = path.join(workspace, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, "");
	}

	it("includes .ts and .tsx files", () => {
		touch("src/a.ts");
		touch("src/b.tsx");
		expect(discoverTsFiles(workspace).sort()).toEqual(["src/a.ts", "src/b.tsx"]);
	});

	it("excludes .d.ts declaration files", () => {
		touch("src/a.ts");
		touch("src/types.d.ts");
		expect(discoverTsFiles(workspace)).toEqual(["src/a.ts"]);
	});

	it("excludes non-TS files (.js, .json, .md)", () => {
		touch("src/a.ts");
		touch("src/b.js");
		touch("package.json");
		touch("README.md");
		expect(discoverTsFiles(workspace)).toEqual(["src/a.ts"]);
	});

	it("skips node_modules / .next / dist / build / out / coverage / .git", () => {
		touch("src/keep.ts");
		for (const skip of [
			"node_modules",
			".next",
			"dist",
			"build",
			"out",
			"coverage",
			".git",
		]) {
			touch(`${skip}/skip.ts`);
		}
		expect(discoverTsFiles(workspace)).toEqual(["src/keep.ts"]);
	});

	it("walks nested directories", () => {
		touch("a.ts");
		touch("src/b.ts");
		touch("src/sub/c.ts");
		touch("src/sub/deeper/d.tsx");
		expect(discoverTsFiles(workspace).sort()).toEqual([
			"a.ts",
			"src/b.ts",
			"src/sub/c.ts",
			"src/sub/deeper/d.tsx",
		]);
	});

	it("returns an empty array for a workspace with no TS files", () => {
		touch("README.md");
		expect(discoverTsFiles(workspace)).toEqual([]);
	});

	it("returns an empty array for a non-existent workspace path", () => {
		// Defensive: walks return early on ENOENT rather than throwing.
		expect(discoverTsFiles(path.join(workspace, "does-not-exist"))).toEqual([]);
	});
});
