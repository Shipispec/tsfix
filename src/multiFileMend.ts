/**
 * Multi-file LLM mend (Layer 3) — prompt builder (Phase 4 / T-4-3).
 *
 * Layer 2 (`mendAgent.ts`) repairs ONE file at a time. That is sufficient when
 * each error's fix is local. It provably is NOT sufficient when a single symbol
 * is constrained by several files at once: `fixtures/forcing-multifile-ripple`
 * proves (T-4-2) that greedy per-file fixing oscillates forever, because the
 * locally-obvious fix for file A necessarily re-breaks file B.
 *
 * Layer 3 breaks the cycle by giving the model EVERY affected file in one
 * prompt, so it can coordinate a single set of edits that satisfies all
 * constraints simultaneously. The set of affected files is computed
 * deterministically — no model involved — by `computeBlastRadius` (T-4-1):
 * `findReferences` over the symbol behind each surviving error.
 *
 * This module is the deterministic half (SIGN-107): the prompt builder here and
 * the multi-file apply + wiring in T-4-4. The LLM call itself is mocked in every
 * test; the real paid validation is the manual T-4-7.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MendContext } from "./index.js";
import {
	computeBlastRadius,
	type BlastRadiusResult,
	type SymbolBlastRadius,
} from "./blastRadius.js";
import { getTypeContext } from "./typeContext.js";
import {
	SYSTEM_INSTRUCTIONS,
	defaultLLMCall,
	type LLMCall,
	type LLMProvider,
} from "./mendAgent.js";
import {
	applyEditBlocks,
	parseEditBlocks,
	type ApplyResult,
	type EditBlock,
} from "./applyEditBlock.js";

/**
 * Multi-file framing prepended to the shared single-file instructions. The
 * SEARCH/REPLACE format + anti-pattern rules are identical to Layer 2 (reused
 * from `SYSTEM_INSTRUCTIONS`); only the coordination requirement differs.
 */
const MULTI_FILE_PREAMBLE = `You are resolving TypeScript compiler errors that span MULTIPLE files at once.

The errors below cannot be fixed one file at a time: the same symbol is constrained by several files simultaneously, so a fix that satisfies one file in isolation re-breaks another. You are given EVERY file in the blast radius of the failing symbol(s). Edit ALL the files needed in ONE coordinated set of SEARCH/REPLACE blocks so that the whole set type-checks together.

Each SEARCH/REPLACE block names its own workspace-relative file path on the first line, so a single response may edit several different files. Think about the shared symbol globally before emitting any block.`;

export interface MultiFileMendPrompt {
	/** Cacheable system block: instructions + blast radius + every affected file. */
	systemBlock: string;
	/** Per-iteration user block: the surviving diagnostics across all files. */
	userBlock: string;
	/** The deterministic blast radius the prompt was folded from (T-4-1). */
	blastRadius: BlastRadiusResult;
	/** Workspace-relative paths of every file included in the prompt, sorted. */
	affectedFiles: string[];
}

function workspaceRelative(workspaceRoot: string, p: string): string {
	return path.isAbsolute(p) ? path.relative(workspaceRoot, p) : p;
}

/** The set of files Layer 3 must show the model: the blast radius declaration +
 *  reference files, unioned with the files the surviving errors live in. */
function collectAffectedFiles(
	workspaceRoot: string,
	blastRadius: BlastRadiusResult,
	context: MendContext,
): string[] {
	const files = new Set<string>();
	for (const sym of blastRadius.symbols) {
		files.add(sym.declarationFile);
		for (const ref of sym.references) files.add(ref.file);
	}
	// Always include the files the errors live in — even if blast-radius
	// resolution found no cross-file symbol, the model still needs the erroring
	// source to fix it.
	for (const diag of context.diagnostics) {
		if (diag.category !== "error") continue;
		files.add(workspaceRelative(workspaceRoot, diag.file));
	}
	return Array.from(files).sort((a, b) => a.localeCompare(b));
}

/** Render one symbol's reference set as a deterministic, model-readable list. */
function formatBlastRadiusEntry(sym: SymbolBlastRadius): string {
	const sites = sym.references
		.map((r) => `  - ${r.file}(${r.line},${r.col})`)
		.join("\n");
	return `symbol: ${sym.symbol}  (declared in ${sym.declarationFile})\n${sites}`;
}

/** Numbered, fenced full content of one workspace file. */
function formatFileSection(workspaceRoot: string, wsRel: string): string {
	const absPath = path.isAbsolute(wsRel) ? wsRel : path.join(workspaceRoot, wsRel);
	let content: string;
	try {
		content = fs.readFileSync(absPath, "utf-8");
	} catch {
		content = "(file unreadable)";
	}
	return `### file: ${wsRel}\n\`\`\`ts\n${content.replace(/\n$/, "")}\n\`\`\``;
}

/** Deduped type-context declarations resolved through the TS Language Service
 *  for each surviving error — same mechanism Layer 2 uses, folded across files. */
function collectTypeContexts(context: MendContext): string[] {
	const blocks: string[] = [];
	const seen = new Set<string>();
	for (const diag of context.diagnostics) {
		if (diag.category !== "error") continue;
		let ctx: ReturnType<typeof getTypeContext>;
		try {
			ctx = getTypeContext({ workspaceRoot: context.workspaceRoot, diagnostic: diag });
		} catch {
			continue;
		}
		if (!ctx.typeDeclaration) continue;
		const key = `${ctx.typeDeclaration.file}:${ctx.typeDeclaration.symbol}`;
		if (seen.has(key)) continue;
		seen.add(key);
		blocks.push(
			`// type: ${ctx.typeDeclaration.symbol}\n` +
				`// file: ${ctx.typeDeclaration.file}\n` +
				ctx.typeDeclaration.lines,
		);
	}
	return blocks;
}

/**
 * Fold the deterministic blast radius into a single multi-file mend prompt:
 * instructions + the blast-radius map + the full content of every affected file
 * + resolved type context. Pure: reads files, computes references, no LLM, no
 * writes.
 */
export function buildMultiFileMendPrompt(context: MendContext): MultiFileMendPrompt {
	const errorDiags = context.diagnostics.filter((d) => d.category === "error");

	const blastRadius = computeBlastRadius({
		workspaceRoot: context.workspaceRoot,
		diagnostics: errorDiags,
	});

	const affectedFiles = collectAffectedFiles(context.workspaceRoot, blastRadius, context);

	const parts: string[] = [MULTI_FILE_PREAMBLE, "", SYSTEM_INSTRUCTIONS, ""];

	if (blastRadius.symbols.length > 0) {
		parts.push("### blast-radius");
		for (const sym of blastRadius.symbols) {
			parts.push(formatBlastRadiusEntry(sym));
		}
		parts.push("");
	}

	parts.push("### affected files");
	for (const wsRel of affectedFiles) {
		parts.push(formatFileSection(context.workspaceRoot, wsRel));
	}

	const typeContexts = collectTypeContexts(context);
	if (typeContexts.length > 0) {
		parts.push("", "### type-context");
		for (const tc of typeContexts) {
			parts.push("```ts", tc, "```");
		}
	}

	if (context.taskDescription) {
		parts.push("", "### task", context.taskDescription);
	}

	const systemBlock = parts.join("\n");

	const diagLines = errorDiags.map(
		(d) => `${workspaceRelative(context.workspaceRoot, d.file)}(${d.line},${d.column}): ${d.code}: ${d.message}`,
	);
	const userBlock = `tsc reports these errors across the blast radius:\n${diagLines.join("\n")}\n\nEmit a single coordinated set of SEARCH/REPLACE blocks (across as many files as needed) to resolve ALL of them together.`;

	return { systemBlock, userBlock, blastRadius, affectedFiles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — the mend call itself (T-4-4).
//
// ONE LLM call over the blast-radius prompt above, then a coalesced multi-file
// SEARCH/REPLACE apply. The LLM is mocked in every test (SIGN-107); the real
// paid validation is the manual T-4-7. Like `mendSingleFile`, the actual
// provider call is injectable via `_callLLM` so the loop gate stays free.
// ─────────────────────────────────────────────────────────────────────────────

export interface MultiFileMendOptions {
	context: MendContext;
	llm: {
		provider: LLMProvider;
		model: string;
		apiKey: string;
	};
	/** Compute and parse patches but skip writing to disk. Default false. */
	dryRun?: boolean;
	/** @internal — LLM call override. Tests inject a fake; real callers leave it. */
	_callLLM?: LLMCall;
}

export interface MultiFileMendResult {
	rawResponse: string;
	blocks: EditBlock[];
	apply: ApplyResult;
	/**
	 * Workspace-relative files the blast-radius prompt spanned. The caller
	 * re-validates over this set (not just the originally-errored files) so it
	 * can see an error migrating to another affected file — the blind spot that
	 * makes single-file iteration non-convergent on the forcing fixture.
	 */
	affectedFiles: string[];
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
}

/**
 * Run the multi-file (Layer 3) mend: build the blast-radius prompt, make ONE
 * LLM call spanning every affected file, parse the coordinated SEARCH/REPLACE
 * response, and apply it across all files via `applyEditBlocks` (which already
 * stacks blocks per file and handles multiple files in one pass).
 */
export async function multiFileMend(
	opts: MultiFileMendOptions,
): Promise<MultiFileMendResult> {
	const { context, llm, dryRun = false, _callLLM = defaultLLMCall } = opts;

	const prompt = buildMultiFileMendPrompt(context);

	const startMs = Date.now();
	const llmResult = await _callLLM({
		systemBlock: prompt.systemBlock,
		userBlock: prompt.userBlock,
		provider: llm.provider,
		model: llm.model,
		apiKey: llm.apiKey,
	});
	const latencyMs = Date.now() - startMs;

	const rawResponse = llmResult.text;
	const blocks = parseEditBlocks(rawResponse);
	const apply = applyEditBlocks({
		workspaceRoot: context.workspaceRoot,
		blocks,
		dryRun,
	});

	return {
		rawResponse,
		blocks,
		apply,
		affectedFiles: prompt.affectedFiles,
		inputTokens: llmResult.inputTokens,
		outputTokens: llmResult.outputTokens,
		latencyMs,
	};
}
