/**
 * Bounded mend loop with no-progress detection.
 *
 *   1. Run tsc (`runInProcessTsc` from tsfix) to capture baseline diagnostics.
 *   2. If clean → return immediately with `stopReason: "noErrors"`.
 *   3. For up to `maxIterations`:
 *        a. Build a per-iteration MendContext scoped to the current errors.
 *        b. Call `mendSingleFile` (LLM → SEARCH/REPLACE → apply).
 *        c. Re-run tsc.
 *        d. Compare error-signature set:
 *             - empty             → "fixed"
 *             - same as previous  → "noProgress" (LLM made no useful change)
 *             - larger            → "regressed" (LLM made it worse)
 *             - shrunk / changed  → continue
 *   4. Hit maxIterations → `stopReason: "maxIterations"`.
 *
 * The signature is `(file, line, column, code)` — same shape tsfix's Layer 0
 * fixer uses internally. We don't import that helper because it's an
 * `@internal` export of tsfix; reimplementing here is ~10 lines.
 *
 * dryRun: runs a single iteration with mendSingleFile in dry-run mode, then
 * returns. We can't iterate without writing to disk because re-validation
 * needs the actual file changes.
 */

import * as path from "node:path";
import type { Diagnostic, LayerEvent, MendContext } from "./index.js";
import { resetInProcessTscCache, runInProcessTsc } from "./validatorInProcess.js";
import { mendSingleFile, type LLMCall, type LLMProvider, type MendSingleFileResult } from "./mendAgent.js";
import { multiFileMend, type MultiFileMendResult } from "./multiFileMend.js";
import { stubAndContinue, type AppliedStub } from "./stubAndContinue.js";
import { detectLibraryMigrations } from "./libraryMigrations.js";

export interface RunMendLoopOptions {
	context: MendContext;
	llm: {
		provider: LLMProvider;
		model: string;
		apiKey: string;
	};
	/** Hard cap on LLM calls. Default 3. */
	maxIterations?: number;
	/** Single dry-run pass — call LLM, parse, but don't write to disk. Default false. */
	dryRun?: boolean;
	/**
	 * After the Layer 2 single-file loop exits with leftover errors, run ONE
	 * Layer 3 multi-file mend: a single coordinated LLM call spanning the
	 * blast radius (`findReferences`) of the surviving errors. Opt-in.
	 * Default false. Ignored when `dryRun: true`. Sits between Layer 2 and
	 * Layer 4 — if it clears every error, Layer 4 stubbing won't run.
	 */
	enableLayer3?: boolean;
	/**
	 * When the loop exits with leftover errors (stopReason !== "fixed"),
	 * apply Layer 4 stub-and-continue: insert `// @ts-expect-error - tsfix: ...`
	 * comments above each unresolved error site so tsc exits 0. Opt-in.
	 * Default false. Ignored when `dryRun: true`.
	 */
	stubOnFailure?: boolean;
	/**
	 * Per-iteration / per-stub telemetry callback. Layer 2 emits one event per
	 * iteration with the dominant error code (`fixed: true` if the iteration
	 * cleared all errors); Layer 4 emits one event per stubbed `(line, code)`
	 * pair. Both forwarded to the same callback. Optional.
	 */
	onLayerEvent?: (event: LayerEvent) => void;
	/** @internal — LLM call override for tests. */
	_callLLM?: LLMCall;
}

export interface MendLoopIteration {
	index: number;
	diagnosticsBefore: number;
	diagnosticsAfter: number;
	patchesApplied: number;
	patchesFailed: number;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
	/** Raw LLM response for this iteration — useful for debugging failed patches. */
	rawResponse: string;
}

export type StopReason =
	| "noErrors"
	| "fixed"
	| "noProgress"
	| "regressed"
	| "maxIterations"
	| "multiFileFixed"
	| "stubbed";

export interface RunMendLoopResult {
	iterations: MendLoopIteration[];
	diagnosticsBefore: Diagnostic[];
	diagnosticsAfter: Diagnostic[];
	passed: boolean;
	stopReason: StopReason;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalLatencyMs: number;
	/**
	 * Layer 4 stubs applied after the LLM loop terminated with leftover
	 * errors. Present only when `stubOnFailure: true` was set. Empty array
	 * means stubOnFailure ran but nothing was eligible (e.g. all errors
	 * were in .d.ts files).
	 */
	stubs?: AppliedStub[];
	/**
	 * Layer 3 multi-file mend result. Present only when `enableLayer3: true`
	 * was set AND the Layer 2 loop left errors for it to act on.
	 */
	layer3?: MultiFileMendResult;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

function errorSignature(d: Diagnostic): string {
	return `${d.file}:${d.line}:${d.column}:${d.code}`;
}

function signatureSet(diags: Diagnostic[]): Set<string> {
	const out = new Set<string>();
	for (const d of diags) {
		if (d.category === "error") out.add(errorSignature(d));
	}
	return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

function refreshDiagnostics(workspaceRoot: string, files: string[]): Diagnostic[] {
	resetInProcessTscCache();
	const result = runInProcessTsc({
		workspaceRoot,
		generatedFiles: files,
		logger: noopLogger,
	});
	return result.diagnostics.filter((d: Diagnostic) => d.category === "error");
}

/**
 * "TS2304" → 2304. Returns 0 if the code doesn't match the expected shape
 * (defensive — we'd rather emit a bogus event than crash the loop).
 */
function parseTsCode(code: string): number {
	const m = /^TS(\d+)$/.exec(code);
	return m ? parseInt(m[1], 10) : 0;
}

/**
 * Pick the most-frequent error code in a diagnostic set. Used as the
 * representative code for a per-iteration `LayerEvent`. If multiple codes
 * tie, returns the first one encountered.
 */
function dominantErrorCode(diags: Diagnostic[]): number {
	const counts = new Map<string, number>();
	for (const d of diags) {
		counts.set(d.code, (counts.get(d.code) ?? 0) + 1);
	}
	let bestCode = "";
	let bestCount = 0;
	for (const [code, count] of counts) {
		if (count > bestCount) {
			bestCount = count;
			bestCode = code;
		}
	}
	return parseTsCode(bestCode);
}

export async function runMendLoop(opts: RunMendLoopOptions): Promise<RunMendLoopResult> {
	const {
		context: rawContext, llm, maxIterations = 3, dryRun = false,
		enableLayer3 = false, stubOnFailure = false, onLayerEvent, _callLLM,
	} = opts;
	const startMs = Date.now();

	// Auto-populate libraryMigrations from the workspace's package.json if the
	// caller didn't set it. To opt out: pass `libraryMigrations: []` explicitly.
	const context: MendContext =
		rawContext.libraryMigrations === undefined
			? { ...rawContext, libraryMigrations: detectLibraryMigrations(rawContext.workspaceRoot) }
			: rawContext;

	const diagnosticsBefore = context.diagnostics.filter((d) => d.category === "error");

	if (diagnosticsBefore.length === 0) {
		return {
			iterations: [],
			diagnosticsBefore,
			diagnosticsAfter: [],
			passed: true,
			stopReason: "noErrors",
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalLatencyMs: Date.now() - startMs,
		};
	}

	const filesInScope = Array.from(new Set(context.diagnostics.map((d) => d.file)));

	const iterations: MendLoopIteration[] = [];
	let currentDiags = diagnosticsBefore;
	let prevSig = signatureSet(currentDiags);
	let stopReason: StopReason = "maxIterations";
	let totalInputTokens = 0;
	let totalOutputTokens = 0;

	for (let i = 0; i < maxIterations; i++) {
		const erroredFiles = Array.from(new Set(currentDiags.map((d) => d.file)));
		const iterContext: MendContext = {
			...context,
			diagnostics: currentDiags,
			erroredFiles,
		};

		const mend: MendSingleFileResult = await mendSingleFile({
			context: iterContext,
			llm,
			dryRun,
			_callLLM,
		});

		totalInputTokens += mend.inputTokens;
		totalOutputTokens += mend.outputTokens;

		const newDiags = dryRun
			? currentDiags // can't re-validate without disk writes
			: refreshDiagnostics(context.workspaceRoot, filesInScope);
		const newSig = signatureSet(newDiags);

		iterations.push({
			index: i,
			diagnosticsBefore: currentDiags.length,
			diagnosticsAfter: newDiags.length,
			patchesApplied: mend.apply.applied,
			patchesFailed: mend.apply.failures.length,
			inputTokens: mend.inputTokens,
			outputTokens: mend.outputTokens,
			latencyMs: mend.latencyMs,
			rawResponse: mend.rawResponse,
		});

		// One LayerEvent per iteration. `errorCode` is the most-frequent code
		// in the iteration's input; `fixed: true` when the iteration cleared
		// every diagnostic in scope (callers wanting per-error granularity
		// should sum + diff iterations themselves).
		// costUsd is intentionally omitted — caller knows the model + can
		// compute cost from `iterations[].inputTokens` + outputTokens. We
		// don't want to bake pricing into runMendLoop.
		onLayerEvent?.({
			layer: 2,
			errorCode: dominantErrorCode(currentDiags),
			fixed: newDiags.length === 0,
			latencyMs: mend.latencyMs,
			ts: Date.now(),
		});

		if (dryRun) {
			currentDiags = newDiags;
			stopReason = "maxIterations";
			break;
		}

		if (newDiags.length === 0) {
			stopReason = "fixed";
			currentDiags = newDiags;
			break;
		}
		if (newSig.size > prevSig.size) {
			stopReason = "regressed";
			currentDiags = newDiags;
			break;
		}
		if (setsEqual(newSig, prevSig)) {
			stopReason = "noProgress";
			currentDiags = newDiags;
			break;
		}

		currentDiags = newDiags;
		prevSig = newSig;
	}

	// Files to re-validate over after higher layers run. Layer 2 only ever
	// touches `filesInScope`; Layer 3 spans the blast radius, so it widens
	// this set with every affected file — otherwise a scoped re-check would go
	// blind to an error the multi-file edit migrated to another file.
	const revalidationFiles = new Set(filesInScope);

	// Layer 3 — multi-file coordinated mend. ONE LLM call over the blast
	// radius of the surviving errors. Runs only when Layer 2 left errors, the
	// caller opted in, and we're not in dryRun. Sits before Layer 4 so a
	// successful multi-file fix preempts stubbing.
	let layer3: MultiFileMendResult | undefined;
	if (enableLayer3 && !dryRun && currentDiags.length > 0) {
		const layer3Context: MendContext = {
			...context,
			diagnostics: currentDiags,
			erroredFiles: Array.from(new Set(currentDiags.map((d) => d.file))),
		};
		const mend = await multiFileMend({ context: layer3Context, llm, _callLLM });
		totalInputTokens += mend.inputTokens;
		totalOutputTokens += mend.outputTokens;
		layer3 = mend;

		for (const f of mend.affectedFiles) {
			revalidationFiles.add(path.isAbsolute(f) ? f : path.join(context.workspaceRoot, f));
		}
		const postL3 = refreshDiagnostics(context.workspaceRoot, Array.from(revalidationFiles));

		onLayerEvent?.({
			layer: 3,
			errorCode: dominantErrorCode(currentDiags),
			fixed: postL3.length === 0,
			latencyMs: mend.latencyMs,
			ts: Date.now(),
		});

		if (postL3.length === 0) {
			stopReason = "multiFileFixed";
		}
		currentDiags = postL3;
	}

	// Layer 4 — stub-and-continue. Only runs when the LLM loop didn't
	// reach `fixed` AND the caller opted in AND we're not in dryRun.
	let stubs: AppliedStub[] | undefined;
	if (stubOnFailure && !dryRun && currentDiags.length > 0) {
		const stubResult = stubAndContinue({
			workspaceRoot: context.workspaceRoot,
			diagnostics: currentDiags,
		});
		stubs = stubResult.stubsApplied;
		// Emit one LayerEvent per (stub × errorCode). A stub silences any
		// errors on its line; coalesced multi-error lines emit N events.
		if (onLayerEvent) {
			const stubTs = Date.now();
			for (const stub of stubResult.stubsApplied) {
				for (const code of stub.codes) {
					onLayerEvent({
						layer: 4,
						errorCode: parseTsCode(code),
						fixed: true,
						latencyMs: 0,
						ts: stubTs,
					});
				}
			}
		}
		// Re-validate so diagnosticsAfter reflects the post-stub state. Use the
		// (possibly Layer-3-widened) scope so stubbed errors outside the original
		// file set are accounted for.
		const postStubDiags = refreshDiagnostics(context.workspaceRoot, Array.from(revalidationFiles));
		if (postStubDiags.length === 0) {
			stopReason = "stubbed";
		}
		currentDiags = postStubDiags;
	}

	return {
		iterations,
		diagnosticsBefore,
		diagnosticsAfter: currentDiags,
		passed: currentDiags.length === 0,
		stopReason,
		totalInputTokens,
		totalOutputTokens,
		totalLatencyMs: Date.now() - startMs,
		...(stubs !== undefined ? { stubs } : {}),
		...(layer3 !== undefined ? { layer3 } : {}),
	};
}
