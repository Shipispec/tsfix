import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUILT_IN_LIBRARY_MIGRATIONS,
	detectLibraryMigrations,
	formatLibraryMigrationsBlock,
	formatLibraryMigrationsTaskDescription,
} from "./libraryMigrations.js";

function makeWorkspaceWithPkg(pkg: Record<string, unknown>): string {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-libmig-"));
	fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify(pkg, null, 2));
	return ws;
}

describe("detectLibraryMigrations", () => {
	let workspace: string;
	afterEach(() => {
		if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("returns [] when workspace has no package.json", () => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-libmig-nopkg-"));
		expect(detectLibraryMigrations(workspace)).toEqual([]);
	});

	it("returns [] when package.json has no matching deps", () => {
		workspace = makeWorkspaceWithPkg({
			dependencies: { lodash: "^4.0.0" },
			devDependencies: { typescript: "^5.0.0" },
		});
		expect(detectLibraryMigrations(workspace)).toEqual([]);
	});

	it("matches vite-plugin-svgr v4+ with caret spec", () => {
		workspace = makeWorkspaceWithPkg({
			devDependencies: { "vite-plugin-svgr": "^4.0.0" },
		});
		const hints = detectLibraryMigrations(workspace);
		expect(hints).toHaveLength(1);
		expect(hints[0].name).toBe("vite-plugin-svgr@^4.0.0");
		expect(hints[0].hint).toContain("?react");
	});

	it("does NOT match vite-plugin-svgr v3 (below minMajor)", () => {
		workspace = makeWorkspaceWithPkg({
			devDependencies: { "vite-plugin-svgr": "^3.0.0" },
		});
		expect(detectLibraryMigrations(workspace)).toEqual([]);
	});

	it("matches multiple deps independently", () => {
		workspace = makeWorkspaceWithPkg({
			dependencies: {
				next: "15.2.4",
				"vite-plugin-svgr": "^4.0.1",
				"drizzle-orm": "0.40.1",
			},
		});
		const hints = detectLibraryMigrations(workspace);
		const names = hints.map((h) => h.name.split("@")[0]);
		expect(names).toEqual(expect.arrayContaining(["next", "vite-plugin-svgr", "drizzle-orm"]));
		expect(hints.length).toBeGreaterThanOrEqual(3);
	});

	it("respects maxMajor (AI SDK v3.x, NOT v5+)", () => {
		const ws3 = makeWorkspaceWithPkg({ dependencies: { ai: "3.4.9" } });
		const hintsV3 = detectLibraryMigrations(ws3);
		expect(hintsV3.map((h) => h.name)).toContain("ai@3.4.9");
		fs.rmSync(ws3, { recursive: true, force: true });

		workspace = makeWorkspaceWithPkg({ dependencies: { ai: "5.0.0" } });
		expect(detectLibraryMigrations(workspace).find((h) => h.name.startsWith("ai@"))).toBeUndefined();
	});

	it("does not throw on malformed package.json", () => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tsfix-libmig-bad-"));
		fs.writeFileSync(path.join(workspace, "package.json"), "{ not valid json");
		expect(() => detectLibraryMigrations(workspace)).not.toThrow();
		expect(detectLibraryMigrations(workspace)).toEqual([]);
	});

	it("accepts a custom registry (for tests/extensibility)", () => {
		workspace = makeWorkspaceWithPkg({ dependencies: { "my-lib": "^2.0.0" } });
		const custom = [
			{
				match: { name: "my-lib", minMajor: 2 },
				hint: "custom hint",
			},
		];
		const hints = detectLibraryMigrations(workspace, custom);
		expect(hints).toEqual([{ name: "my-lib@^2.0.0", hint: "custom hint" }]);
	});
});

describe("formatLibraryMigrationsBlock", () => {
	it("returns empty string when hints array is empty", () => {
		expect(formatLibraryMigrationsBlock([])).toBe("");
	});

	it("emits a header + bullet per hint, with the runtime-semantics warning", () => {
		const block = formatLibraryMigrationsBlock([
			{ name: "vite-plugin-svgr@^4.0.0", hint: "use ?react" },
		]);
		expect(block).toContain("### library-migrations");
		expect(block).toContain("[vite-plugin-svgr@^4.0.0]");
		expect(block).toContain("use ?react");
		expect(block).toContain("runtime");
	});
});

describe("formatLibraryMigrationsTaskDescription", () => {
	it("returns undefined for empty hints", () => {
		expect(formatLibraryMigrationsTaskDescription([])).toBeUndefined();
	});

	it("returns a Library migration: <names> headline", () => {
		expect(
			formatLibraryMigrationsTaskDescription([
				{ name: "vite-plugin-svgr@^4.0.0", hint: "x" },
				{ name: "next@15.2.4", hint: "y" },
			]),
		).toBe("Library migration: vite-plugin-svgr@^4.0.0, next@15.2.4");
	});
});

describe("BUILT_IN_LIBRARY_MIGRATIONS", () => {
	it("is non-empty (registry has actual content)", () => {
		expect(BUILT_IN_LIBRARY_MIGRATIONS.length).toBeGreaterThan(0);
	});

	it("every entry has a name match + hint (schema sanity)", () => {
		for (const entry of BUILT_IN_LIBRARY_MIGRATIONS) {
			expect(entry.match.name.length).toBeGreaterThan(0);
			expect(entry.hint.length).toBeGreaterThan(50);
		}
	});
});
