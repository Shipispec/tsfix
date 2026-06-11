/**
 * T-4-2 — the PROVE gate for Phase 4 / Layer 3 (SIGN-106).
 *
 * Before any multi-file mend is built, we must DEMONSTRATE that per-file
 * iteration cannot converge on the forcing fixture. Prior synthetic ripple
 * fixtures (synthetic-multifile-ripple) converge: each iteration's locally
 * obvious fix surfaces the next error and the diagnostic set monotonically
 * shrinks to zero. `fixtures/forcing-multifile-ripple` is built to defeat that.
 *
 * The fixture's `shared.ts` declares one type `Value` that two consumers
 * constrain to INCOMPATIBLE types:
 *   - consumer-num.ts does `value * 2`        → TS2362 unless `Value = number`
 *   - consumer-str.ts does `value.toUpperCase()` → TS2339 unless `Value = string`
 *
 * A greedy single-file fixer responds to each error by retyping the shared
 * declaration toward whichever consumer is currently erroring — the
 * locally-obvious fix. This test drives that fixer with WHOLE-WORKSPACE
 * re-validation (the semantics tsc actually reports for the project) and proves
 * the diagnostic-signature set walks a 2-cycle, never reaching zero. That is the
 * forcing function: only a coordinated multi-file mend (Layer 3), seeing both
 * consumers at once, can converge.
 *
 * No LLM is involved (SIGN-104) — the "mock single-file fixer" is a pure,
 * deterministic edit. We drive through `runInProcessTsc` (not hand-built
 * diagnostics) so the error codes and the oscillation are real.
 *
 * NOTE on `runMendLoop`'s file-scoping: `runMendLoop` filters re-validation to
 * `filesInScope`, computed ONCE from the initial diagnostics — here just
 * `consumer-num.ts`. With that scoping it would not even SEE the error migrate
 * to `consumer-str.ts` and would falsely report `fixed` while the project is
 * still broken. That blind spot is a SECOND, independent reason per-file
 * iteration fails here; the whole-workspace view below is the honest, stronger
 * proof of non-convergence (the project genuinely never reaches zero errors).
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFullStack, type Diagnostic, type LayerEvent, type MendContext } from "./index.js";
import { resetInProcessTscCache, runInProcessTsc } from "./validatorInProcess.js";
import { resetSharedTsHost } from "./sharedTsHost.js";
import { buildMultiFileMendPrompt } from "./multiFileMend.js";
import type { LLMCall } from "./mendAgent.js";

const require = createRequire(import.meta.url);
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const FIXTURE_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"forcing-multifile-ripple",
);
const FILES = ["lib/shared.ts", "lib/consumer-num.ts", "lib/consumer-str.ts"];

/** Copy the committed fixture into a writable temp workspace (the fixture is
 *  the single source of truth; the loop must mutate files, so we work on a
 *  copy with a symlinked workspace typescript — SIGN-102, no bundling). */
function setupWorkspace(): string {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tsmend-forcing-"));
	fs.mkdirSync(path.join(ws, "node_modules"), { recursive: true });
	const realTs = path.dirname(require.resolve("typescript/package.json"));
	fs.symlinkSync(realTs, path.join(ws, "node_modules", "typescript"));
	fs.copyFileSync(
		path.join(FIXTURE_DIR, "tsconfig.json"),
		path.join(ws, "tsconfig.json"),
	);
	fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
	for (const f of FILES) {
		fs.copyFileSync(path.join(FIXTURE_DIR, f), path.join(ws, f));
	}
	return ws;
}

function refresh(ws: string): Diagnostic[] {
	resetInProcessTscCache();
	const result = runInProcessTsc({
		workspaceRoot: ws,
		generatedFiles: FILES,
		logger: noopLogger,
	});
	return result.diagnostics.filter((d: Diagnostic) => d.category === "error");
}

/** runMendLoop's exact signature shape: (file, line, column, code). */
function signatureSet(diags: Diagnostic[]): Set<string> {
	return new Set(diags.map((d) => `${d.file}:${d.line}:${d.column}:${d.code}`));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

/**
 * The mock single-file fixer: the locally-obvious response to the current
 * dominant error, editing exactly ONE file (`shared.ts`). It does not look at
 * the other consumer — that is the whole point of a per-file fixer.
 *   - TS2362 (consumer-num: arithmetic on non-number) → retype `Value` number.
 *   - TS2339 (consumer-str: no `.toUpperCase` on number) → retype `Value` string.
 * Returns false if no edit applied (would indicate the fixer stalled).
 */
function applyLocalFix(ws: string, diags: Diagnostic[]): boolean {
	const codes = new Set(diags.map((d) => d.code));
	const sharedPath = path.join(ws, "lib/shared.ts");
	const src = fs.readFileSync(sharedPath, "utf-8");
	let next = src;
	if (codes.has("TS2362")) {
		next = src.replace(/export type Value = (?:string|number);/, "export type Value = number;");
	} else if (codes.has("TS2339")) {
		next = src.replace(/export type Value = (?:string|number);/, "export type Value = string;");
	}
	if (next === src) return false;
	fs.writeFileSync(sharedPath, next);
	return true;
}

describe("forcing-multifile-ripple — per-file iteration cannot converge (T-4-2)", () => {
	let ws: string;

	beforeEach(() => {
		ws = setupWorkspace();
		resetSharedTsHost();
	});

	afterEach(() => {
		fs.rmSync(ws, { recursive: true, force: true });
		resetSharedTsHost();
	});

	it("the fixture starts with exactly one error (TS2362 in consumer-num)", () => {
		const baseline = refresh(ws);
		expect(baseline.length).toBe(1);
		expect(baseline[0].code).toBe("TS2362");
		expect(baseline[0].file).toContain("consumer-num.ts");
	});

	it("greedy single-file fixing oscillates and never reaches zero errors", () => {
		const MAX = 6; // 3 full cycles — plenty to expose the period-2 oscillation
		const signatures: string[] = [];
		const errorCounts: number[] = [];
		const sigSets: Set<string>[] = [];

		let diags = refresh(ws);
		for (let i = 0; i < MAX; i++) {
			const set = signatureSet(diags);
			sigSets.push(set);
			signatures.push([...set].sort().join(","));
			errorCounts.push(diags.length);

			const changed = applyLocalFix(ws, diags);
			expect(changed, `iteration ${i}: the local fixer should make an edit`).toBe(true);

			diags = refresh(ws);
		}

		// --- The proof: the project NEVER reaches zero errors. ---
		expect(errorCounts.every((n) => n > 0)).toBe(true);
		expect(diags.length).toBeGreaterThan(0);

		// --- It is an oscillation, not slow progress: exactly two alternating
		//     states, each with a single error, swapping consumer every step. ---
		const distinct = new Set(signatures);
		expect(distinct.size).toBe(2);
		for (let i = 0; i < MAX; i++) {
			if (i % 2 === 0) {
				expect(signatures[i]).toMatch(/consumer-num\.ts.*TS2362/);
			} else {
				expect(signatures[i]).toMatch(/consumer-str\.ts.*TS2339/);
			}
		}

		// --- Map directly onto runMendLoop's stop conditions: none can fire
		//     "fixed" / "noProgress" / "regressed", so it exhausts its budget
		//     with stopReason "maxIterations" — i.e. it cannot converge. ---
		for (let i = 1; i < sigSets.length; i++) {
			expect(sigSets[i].size, "never empty → 'fixed' never fires").toBeGreaterThan(0);
			expect(
				setsEqual(sigSets[i], sigSets[i - 1]),
				"consecutive sets differ → 'noProgress' never fires",
			).toBe(false);
			expect(
				sigSets[i].size > sigSets[i - 1].size,
				"set never grows → 'regressed' never fires",
			).toBe(false);
		}
	});
});

describe("buildMultiFileMendPrompt — folds the blast radius into one prompt (T-4-3)", () => {
	let ws: string;

	beforeEach(() => {
		ws = setupWorkspace();
		resetSharedTsHost();
	});

	afterEach(() => {
		fs.rmSync(ws, { recursive: true, force: true });
		resetSharedTsHost();
	});

	function contextFor(ws: string, diags: Diagnostic[]): MendContext {
		const erroredFiles = Array.from(
			new Set(diags.map((d) => path.join(ws, d.file))),
		);
		return { workspaceRoot: ws, diagnostics: diags, erroredFiles };
	}

	it("includes every blast-radius file and reference site for the forcing fixture", () => {
		const diags = refresh(ws);
		expect(diags.length).toBeGreaterThan(0);

		const prompt = buildMultiFileMendPrompt(contextFor(ws, diags));

		// The blast radius must resolve to the contested `value` symbol spanning
		// all three files — the whole reason a single-file mend can't converge.
		expect(prompt.blastRadius.symbols.length).toBe(1);
		expect(prompt.blastRadius.symbols[0].symbol).toBe("value");

		// Every file in the blast radius is an affected file the prompt carries.
		for (const f of FILES) {
			expect(prompt.affectedFiles).toContain(f);
		}

		// The system block embeds each affected file's path AND its content.
		for (const f of FILES) {
			expect(prompt.systemBlock).toContain(`### file: ${f}`);
		}
		expect(prompt.systemBlock).toContain("export type Value");
		expect(prompt.systemBlock).toContain("value.toUpperCase()");
		expect(prompt.systemBlock).toContain("value * 2");

		// Every reference site the blast radius found is listed verbatim — derived
		// from the result itself so the assertion can't drift from the computation.
		const sites = new Set<string>();
		for (const sym of prompt.blastRadius.symbols) {
			for (const ref of sym.references) {
				sites.add(`${ref.file}(${ref.line},${ref.col})`);
			}
		}
		expect(sites.size).toBeGreaterThanOrEqual(5);
		for (const site of sites) {
			expect(prompt.systemBlock).toContain(site);
		}

		// Reference files span more than one consumer — proving the prompt sees
		// BOTH sides of the contradiction (consumer-num AND consumer-str).
		const refFiles = new Set(
			prompt.blastRadius.symbols.flatMap((s) => s.references.map((r) => r.file)),
		);
		expect(refFiles).toContain("lib/consumer-num.ts");
		expect(refFiles).toContain("lib/consumer-str.ts");
		expect(refFiles).toContain("lib/shared.ts");

		// The user block carries the surviving diagnostic(s) for this iteration.
		expect(prompt.userBlock).toContain("TS2362");
		expect(prompt.userBlock).toContain("lib/consumer-num.ts");
		// And it asks for ONE coordinated multi-file edit set.
		expect(prompt.userBlock).toMatch(/SEARCH\/REPLACE/);
	});

	it("still includes the erroring file when no cross-file symbol resolves", () => {
		// A purely local primitive mismatch: blast radius is empty, but the prompt
		// must still hand the model the file the error lives in.
		const localWs = setupWorkspace();
		try {
			fs.writeFileSync(
				path.join(localWs, "lib/shared.ts"),
				"export type Value = string;\nexport declare const value: Value;\nexport const bad: number = 'nope';\n",
			);
			resetSharedTsHost();
			const diags = refresh(localWs).filter((d) => d.code === "TS2322");
			expect(diags.length).toBe(1);

			const prompt = buildMultiFileMendPrompt(contextFor(localWs, diags));
			expect(prompt.affectedFiles).toContain("lib/shared.ts");
			expect(prompt.systemBlock).toContain("### file: lib/shared.ts");
			expect(prompt.userBlock).toContain("TS2322");
		} finally {
			fs.rmSync(localWs, { recursive: true, force: true });
		}
	});
});

function searchReplaceBlock(file: string, search: string, replace: string): string {
	return [file, "<<<<<<< SEARCH", search, "=======", replace, ">>>>>>> REPLACE"].join("\n");
}

/**
 * Layer-3 mock LLM. Layer 2 (single-file prompt) abstains — the forcing fixture
 * has no convergent single-file fix — so the loop falls through to Layer 3.
 * Layer 3 (multi-file prompt, recognised by the MULTI_FILE_PREAMBLE) returns a
 * COORDINATED two-file edit: retype the shared `Value` to `number` and convert
 * at the string use-site. That satisfies BOTH consumers at once, which no
 * single-file edit can do.
 */
const coordinatedLayer3LLM: LLMCall = vi.fn(async ({ systemBlock }) => {
	if (systemBlock.includes("span MULTIPLE files")) {
		return {
			text: [
				searchReplaceBlock("lib/shared.ts", "export type Value = string;", "export type Value = number;"),
				searchReplaceBlock("lib/consumer-str.ts", "value.toUpperCase()", "String(value).toUpperCase()"),
			].join("\n\n"),
			inputTokens: 400,
			outputTokens: 120,
		};
	}
	// Layer 2 single-file pass: no usable edit → loop exits with errors.
	return { text: "No single-file edit can resolve this.", inputTokens: 50, outputTokens: 10 };
});

describe("runFullStack wiring — Layer 3 multi-file mend (T-4-4)", () => {
	let ws: string;

	beforeEach(() => {
		ws = setupWorkspace();
		resetSharedTsHost();
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(ws, { recursive: true, force: true });
		resetSharedTsHost();
	});

	it("enableLayer3 + mocked Layer-3 LLM resolves the forcing fixture to 0 errors", async () => {
		const events: LayerEvent[] = [];
		const r = await runFullStack({
			workspaceRoot: ws,
			targetFiles: FILES,
			llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "k", maxIterations: 1 },
			enableLayer3: true,
			onLayerEvent: (e) => events.push(e),
			_callLLM: coordinatedLayer3LLM,
		});

		// The whole point: a single coordinated multi-file call drove the
		// otherwise-non-convergent fixture to zero errors.
		expect(r.passed).toBe(true);
		expect(r.errorsAfterAllLayers).toBe(0);
		expect(r.layer2).not.toBeNull();
		expect(r.layer2!.stopReason).toBe("multiFileFixed");
		expect(r.layer2!.layer3).toBeDefined();
		expect(r.layer2!.layer3!.apply.applied).toBe(2); // both files edited

		// Exactly one Layer-3 event, marked fixed.
		const layer3Events = events.filter((e) => e.layer === 3);
		expect(layer3Events.length).toBe(1);
		expect(layer3Events[0].fixed).toBe(true);

		// The coordinated edit really landed on disk in BOTH files.
		expect(fs.readFileSync(path.join(ws, "lib/shared.ts"), "utf-8")).toContain("Value = number");
		expect(fs.readFileSync(path.join(ws, "lib/consumer-str.ts"), "utf-8")).toContain("String(value)");
	});

	it("Layer 3 OFF by default: never fires, leaving the fixture unresolved (regression)", async () => {
		const events: LayerEvent[] = [];
		const r = await runFullStack({
			workspaceRoot: ws,
			targetFiles: FILES,
			llm: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "k", maxIterations: 1 },
			// enableLayer3 omitted → default OFF.
			onLayerEvent: (e) => events.push(e),
			_callLLM: coordinatedLayer3LLM,
		});

		// Without Layer 3 the forcing fixture cannot be fixed — identical to
		// pre-T-4-4 behavior (Layer 2 single-file loop only).
		expect(r.passed).toBe(false);
		expect(r.errorsAfterAllLayers).toBeGreaterThan(0);
		expect(r.layer2!.layer3).toBeUndefined();
		expect(r.layer2!.stopReason).not.toBe("multiFileFixed");

		// No Layer-3 event, and the LLM was never handed the multi-file prompt.
		expect(events.some((e) => e.layer === 3)).toBe(false);
		const calls = (coordinatedLayer3LLM as unknown as { mock: { calls: Array<[{ systemBlock: string }]> } }).mock.calls;
		expect(calls.every(([arg]) => !arg.systemBlock.includes("span MULTIPLE files"))).toBe(true);

		// Files left untouched (no coordinated edit applied).
		expect(fs.readFileSync(path.join(ws, "lib/shared.ts"), "utf-8")).toContain("Value = string");
	});
});
