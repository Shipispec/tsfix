import { describe, it, expect } from "vitest";
import type * as ts from "typescript";
import {
	applyFixToSnapshots,
	computeErrorSignatures,
	fixesAreEquivalent,
	signatureSetsEqual,
} from "./tsLanguageServiceFixer.js";

// Build a minimal CodeFixAction-shaped object for tests. Matches only the
// fields applyFixToSnapshots / fixesAreEquivalent actually read.
function makeFix(
	changes: Array<{
		fileName: string;
		textChanges: Array<{ span: { start: number; length: number }; newText: string }>;
	}>,
	fixName = "spelling",
): ts.CodeFixAction {
	return {
		fixName,
		description: `test fix: ${fixName}`,
		changes,
	} as unknown as ts.CodeFixAction;
}

describe("applyFixToSnapshots", () => {
	it("applies a single-file rename and bumps the version", () => {
		const snapshots = new Map([
			["/repo/a.ts", { content: "const foo = 1;\nconsole.log(foo);", version: 1 }],
		]);
		const fix = makeFix([
			{
				fileName: "/repo/a.ts",
				textChanges: [{ span: { start: 6, length: 3 }, newText: "bar" }],
			},
		]);

		const applied = applyFixToSnapshots(fix, snapshots);

		expect(applied).toBe(1);
		expect(snapshots.get("/repo/a.ts")).toEqual({
			content: "const bar = 1;\nconsole.log(foo);",
			version: 2,
		});
	});

	it("applies multi-edit changes in reverse offset order so earlier offsets stay valid", () => {
		// Two edits in the same file: insert "x" at offset 0 and "y" at offset 5.
		// If applied in forward order, the offset-5 edit hits the wrong character.
		const snapshots = new Map([
			["/repo/a.ts", { content: "abcde", version: 1 }],
		]);
		const fix = makeFix([
			{
				fileName: "/repo/a.ts",
				textChanges: [
					{ span: { start: 0, length: 0 }, newText: "X" },
					{ span: { start: 5, length: 0 }, newText: "Y" },
				],
			},
		]);

		applyFixToSnapshots(fix, snapshots);

		expect(snapshots.get("/repo/a.ts")?.content).toBe("XabcdeY");
	});

	it("touches every file in a multi-file change and bumps each version", () => {
		const snapshots = new Map([
			["/repo/a.ts", { content: "OLD-A", version: 3 }],
			["/repo/b.ts", { content: "OLD-B", version: 7 }],
		]);
		const fix = makeFix([
			{
				fileName: "/repo/a.ts",
				textChanges: [{ span: { start: 0, length: 5 }, newText: "NEW-A" }],
			},
			{
				fileName: "/repo/b.ts",
				textChanges: [{ span: { start: 0, length: 5 }, newText: "NEW-B" }],
			},
		]);

		const applied = applyFixToSnapshots(fix, snapshots);

		expect(applied).toBe(2);
		expect(snapshots.get("/repo/a.ts")).toEqual({ content: "NEW-A", version: 4 });
		expect(snapshots.get("/repo/b.ts")).toEqual({ content: "NEW-B", version: 8 });
	});

	it("skips files not present in snapshots (won't create new files unbeknownst)", () => {
		const snapshots = new Map([
			["/repo/known.ts", { content: "x", version: 1 }],
		]);
		const fix = makeFix([
			{
				fileName: "/repo/unknown.ts",
				textChanges: [{ span: { start: 0, length: 0 }, newText: "anything" }],
			},
		]);

		const applied = applyFixToSnapshots(fix, snapshots);

		expect(applied).toBe(0);
		expect(snapshots.has("/repo/unknown.ts")).toBe(false);
		expect(snapshots.get("/repo/known.ts")).toEqual({ content: "x", version: 1 });
	});
});

describe("fixesAreEquivalent", () => {
	const fileEdit = (newText: string) =>
		makeFix([
			{
				fileName: "/a.ts",
				textChanges: [{ span: { start: 0, length: 3 }, newText }],
			},
		]);

	it("returns true when two fixes produce identical text edits", () => {
		expect(fixesAreEquivalent([fileEdit("foo"), fileEdit("foo")])).toBe(true);
	});

	it("returns false when newText differs", () => {
		expect(fixesAreEquivalent([fileEdit("foo"), fileEdit("bar")])).toBe(false);
	});

	it("returns false when text-change positions differ", () => {
		const a = makeFix([
			{
				fileName: "/a.ts",
				textChanges: [{ span: { start: 0, length: 3 }, newText: "x" }],
			},
		]);
		const b = makeFix([
			{
				fileName: "/a.ts",
				textChanges: [{ span: { start: 5, length: 3 }, newText: "x" }],
			},
		]);
		expect(fixesAreEquivalent([a, b])).toBe(false);
	});

	it("returns false for an empty fix list (caller has nothing to apply)", () => {
		expect(fixesAreEquivalent([])).toBe(false);
	});

	it("returns true for a single fix (trivially unambiguous)", () => {
		expect(fixesAreEquivalent([fileEdit("foo")])).toBe(true);
	});
});

describe("computeErrorSignatures", () => {
	it("encodes (file, start, code) into a stable string per error", () => {
		const sigs = computeErrorSignatures([
			{ file: "/a.ts", start: 10, code: 2304 },
			{ file: "/b.ts", start: 20, code: 2552 },
		]);
		expect(sigs).toEqual(new Set(["/a.ts:10:2304", "/b.ts:20:2552"]));
	});

	it("dedupes identical (file, start, code) triples", () => {
		const sigs = computeErrorSignatures([
			{ file: "/a.ts", start: 10, code: 2304 },
			{ file: "/a.ts", start: 10, code: 2304 },
		]);
		expect(sigs.size).toBe(1);
	});
});

describe("signatureSetsEqual", () => {
	it("returns true for identical sets", () => {
		expect(signatureSetsEqual(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(true);
	});

	it("returns false when sizes differ", () => {
		expect(signatureSetsEqual(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
	});

	it("returns false when sizes match but members differ — the bug this guard catches", () => {
		// This is the TS2724→TS2552 case: count stayed at 1, but the error code
		// and position changed. Not stuck — must NOT be flagged as no-progress.
		const before = new Set(["/a.ts:10:2724"]);
		const after = new Set(["/a.ts:25:2552"]);
		expect(signatureSetsEqual(before, after)).toBe(false);
	});

	it("returns true for two empty sets (vacuous case at iteration 1)", () => {
		expect(signatureSetsEqual(new Set(), new Set())).toBe(true);
	});
});
