import { describe, expect, it } from "vitest";
import { allGatingPassed, listFixtures, runFixture, type FixtureResult } from "./run-benchmark.js";

// T-3b-3 regression net. `mustPass:false` fixtures are report-only: the harness
// runs and reports them, but they must never fail the run/CI exit code. The
// seed `real-*` fixture is intentionally red (an open failure Layer 0/1 cannot
// fix yet) so it proves the report-only path end-to-end.

const SEED_FIXTURE = "real-20260610-000000-9157284c";

function fakeResult(over: Partial<FixtureResult>): FixtureResult {
	return {
		name: "x",
		expected: { mustPass: true },
		errorsBefore: 0,
		errorsAfter: 0,
		lspFixesApplied: 0,
		lspIterations: 0,
		filesEdited: [],
		remainingByCode: {},
		passed: true,
		reportOnly: false,
		failureReasons: [],
		elapsedMs: 0,
		...over,
	};
}

describe("allGatingPassed — report-only fixtures never gate", () => {
	it("ignores a failing report-only fixture", () => {
		const results = [
			fakeResult({ name: "gates-ok", passed: true, reportOnly: false }),
			fakeResult({
				name: "open-failure",
				passed: false,
				reportOnly: true,
				failureReasons: ["errorsAfter 1 > max 0"],
			}),
		];
		expect(allGatingPassed(results)).toBe(true);
	});

	it("still fails when a gating (mustPass:true) fixture fails", () => {
		const results = [
			fakeResult({ name: "gates-bad", passed: false, reportOnly: false }),
			fakeResult({ name: "open-failure", passed: false, reportOnly: true }),
		];
		expect(allGatingPassed(results)).toBe(false);
	});

	it("passes when every fixture is report-only (none gate)", () => {
		const results = [fakeResult({ passed: false, reportOnly: true })];
		expect(allGatingPassed(results)).toBe(true);
	});
});

describe("seed real-* fixture is discovered and report-only", () => {
	it("is included in the deterministic benchmark set", () => {
		expect(listFixtures()).toContain(SEED_FIXTURE);
	});

	it("runs red but is marked reportOnly (non-gating)", () => {
		const r = runFixture(SEED_FIXTURE, false);
		expect(r.reportOnly).toBe(true);
		expect(r.expected.mustPass).toBe(false);
		// The seed has no safe fix, so it stays red — and that is fine.
		expect(r.errorsAfter).toBeGreaterThan(0);
		expect(r.passed).toBe(false);
		// A single red report-only fixture does not fail the run.
		expect(allGatingPassed([r])).toBe(true);
	});
});
