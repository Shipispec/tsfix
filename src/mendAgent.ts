/**
 * Single-file LLM mend (Layer 2).
 *
 * Builds a prompt of:
 *   - System block: instructions + the erroring file's full content + type
 *     context resolved through the TS Language Service for each diagnostic.
 *   - User block: the diagnostics themselves (changes per iteration; cheap).
 *
 * Sends to Anthropic via Vercel AI SDK, parses the SEARCH/REPLACE response,
 * applies via `applyEditBlocks`. Multi-file scope is Layer 3 (deferred to
 * tsmend v0.2).
 *
 * Prompt-cache breakpoint placement is intentionally simple in v0.1.0 — we
 * pass the whole system block as one cached unit. Future tuning belongs in
 * `runMendLoop` once we have benchmark data on hit rates.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { MendContext } from "./index.js";
import { getTypeContext } from "./typeContext.js";
import {
	formatLibraryMigrationsBlock,
	formatLibraryMigrationsTaskDescription,
} from "./libraryMigrations.js";
import {
	applyEditBlocks,
	parseEditBlocks,
	type ApplyResult,
	type EditBlock,
} from "./applyEditBlock.js";

/**
 * Provider identifier. Each corresponds to one `@ai-sdk/<provider>` adapter
 * in the Vercel AI SDK. Adding a provider requires (1) the corresponding
 * `@ai-sdk/X` dep in package.json, (2) a case in `buildLanguageModel`, and
 * (3) the appropriate API-key env-var name documented in the CLI.
 */
export type LLMProvider = "anthropic" | "openai" | "google";

export interface MendSingleFileOptions {
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

export interface MendSingleFileResult {
	rawResponse: string;
	blocks: EditBlock[];
	apply: ApplyResult;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
}

export type LLMCall = (params: {
	systemBlock: string;
	userBlock: string;
	/**
	 * Provider name. Optional for backward compatibility — when omitted,
	 * the default impl treats it as "anthropic" (matches v0.5.0 behavior).
	 * Test injection points can ignore this field.
	 */
	provider?: LLMProvider;
	model: string;
	apiKey: string;
}) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;

/** @internal — exported so Layer 3's multi-file prompt reuses the identical
 *  SEARCH/REPLACE format + anti-pattern rules (single source of truth). */
export const SYSTEM_INSTRUCTIONS = `You are a TypeScript code-repair tool. You receive a TypeScript file with one or more compiler errors and resolve them.

Output ONLY SEARCH/REPLACE blocks. No prose, no explanations, no XML wrappers.

The first line of each block is the workspace-relative file path on its own line. Then the SEARCH/REPLACE markers around the change. Concrete example:

src/api.ts
<<<<<<< SEARCH
const x = 1;
=======
const x: number = 1;
>>>>>>> REPLACE

Rules:
- The file path is a plain line. Do not wrap it in tags, fences, or quotes.
- SEARCH text must match the file VERBATIM. Whitespace, indentation, line endings: copy exactly.
- Make SEARCH unique. If a one-line search would match multiple places in the file, include 1-2 lines of surrounding context.
- REPLACE must be valid TypeScript that resolves the diagnostic.
- Do not invent imports, types, properties, or values. Use only what the type-context section shows.
- One SEARCH/REPLACE block per logical change.
- If you cannot resolve a diagnostic with the information given, omit a block for it.

Anti-patterns — these silence the type error but break runtime semantics, lose type safety, or introduce security regressions. Do NOT emit a patch that does any of the following:

1. Type-assertion escape-hatches that hide the error rather than fix it:
   - \`x as any\` / \`x as unknown as T\` to dodge a real mismatch.
   - \`key as keyof T\` to silence a TS7053 index-signature error when \`key\` is a runtime \`string\` (not a statically-known literal). Narrow the parameter type to \`keyof T\` at the function signature instead, OR widen the object type to include an index signature, OR perform a runtime \`if (key in obj)\` guard. \`as keyof T\` keeps the call site type-passing while losing all the runtime safety the index signature gave.
   - \`!\` non-null assertions to dodge TS18047/TS2532 — narrow with a truthiness check or optional-chaining + nullish-coalesce that actually preserves the narrow on the true branch.

2. Removing or substituting a declared dependency to dodge a missing-import error. If \`package.json\` lists the package and the source uses it, RESTORE the import. Do not substitute a different library (e.g. \`bcrypt\` → \`crypto.subtle.digest\`) — that is a security regression even when tsc accepts it.

3. SQL / NoSQL / shell injection patterns:
   - String concatenation of user-controlled values into raw query strings (\`db.execute("WHERE id = " + userId)\`). Use the library's tagged-template / parameterized form (\`db.execute(sql\\\`WHERE id = \\\${userId}\\\`)\` for Drizzle; placeholders for Prisma / mysql2; etc).
   - Never use template literals to interpolate user input into a raw SQL string unless the literal is itself a parameterizing tagged template.

4. React XSS escape-hatches:
   - \`dangerouslySetInnerHTML\` to dodge a children-type error. If a component expects \`children: string\` and you have arbitrary HTML, render it as text (JSX \`{value}\` auto-escapes) or sanitize via a library (DOMPurify) and document the assumption.
   - Setting \`innerHTML\` directly on a DOM element from user input.

These anti-patterns apply only to the listed shapes. For other diagnostics, follow the regular Rules above and pick the smallest valid fix — including legitimate uses of \`as unknown as T\`, \`keyof typeof T\` (as a type annotation, not a cast), or restructuring a type union. Do not omit a block just because the fix involves an \`as\` cast or a structural change — only omit when the fix would match one of the four anti-patterns above.

When a type, union variant, or interface property has been removed or renamed, consumer code that referenced the old shape needs FULL cleanup, not partial cleanup:

- TS2322 / TS2353 (excess property in object literal): REMOVE the excess property from the literal. Do not retain it. Example: if a \`{ type: 'archived', userId, reason, at }\` object now needs \`type: 'created'\` and the \`created\` variant has no \`reason\` field, the fix is to drop \`reason\` from the object — keeping it produces a fresh TS2353. This is field deletion, not "silencing an error" — there is no error to silence; the property genuinely no longer belongs.
- Function parameters and return types that exist solely to support the removed variant (e.g. a \`reason: string\` parameter on a function that no longer needs reasons) should be dropped along with their use sites in the same SEARCH/REPLACE block.
- TS2367 (comparison with no overlap): if comparing against a removed literal, EITHER pick a still-valid literal that preserves the function's spirit, OR delete the comparison and its branch if neither makes sense. Don't leave a comparison against a now-invalid literal.

The goal is internal consistency: if you change one reference to a removed variant/property, sweep ALL references in this file in the same patch. A half-cleanup leaves new tsc errors and is worse than the original state.`;

function workspaceRelative(workspaceRoot: string, p: string): string {
	return path.isAbsolute(p) ? path.relative(workspaceRoot, p) : p;
}

/** @internal — exported for unit tests. */
export function buildSystemBlock(context: MendContext, erroredFile: string): string {
	const wsRel = workspaceRelative(context.workspaceRoot, erroredFile);
	const absPath = path.isAbsolute(erroredFile)
		? erroredFile
		: path.join(context.workspaceRoot, erroredFile);

	let fileContent: string;
	try {
		fileContent = fs.readFileSync(absPath, "utf-8");
	} catch {
		fileContent = "(file unreadable)";
	}

	const fileDiags = context.diagnostics.filter(
		(d) =>
			d.category === "error" &&
			workspaceRelative(context.workspaceRoot, d.file) === wsRel,
	);

	const typeContexts: string[] = [];
	const seen = new Set<string>();
	for (const diag of fileDiags) {
		// `getTypeContext` should be safe — typeContext.ts catches the known
		// `getTypeAtLocation` crashes — but we wrap here too because the AST
		// walk + checker plumbing has plenty of other surfaces. If one
		// diagnostic's context build fails, skip it instead of killing the
		// whole mend (one bad diag should not lose the LLM's chance to fix the
		// other errors in this file).
		let ctx: ReturnType<typeof getTypeContext>;
		try {
			ctx = getTypeContext({
				workspaceRoot: context.workspaceRoot,
				diagnostic: diag,
			});
		} catch {
			continue;
		}
		if (!ctx.typeDeclaration) continue;
		const key = `${ctx.typeDeclaration.file}:${ctx.typeDeclaration.symbol}`;
		if (seen.has(key)) continue;
		seen.add(key);
		typeContexts.push(
			`// type: ${ctx.typeDeclaration.symbol}\n` +
				`// file: ${ctx.typeDeclaration.file}\n` +
				ctx.typeDeclaration.lines,
		);
	}

	const parts: string[] = [SYSTEM_INSTRUCTIONS, ""];

	// Library-migration hints lead the prompt body. Headline framing
	// (`taskDescription = "Library migration: <names>"`) matters more than
	// burying the same text in the body — empirically, models follow tsc's
	// quick-fix when migrations are mentioned only in a buried section.
	const libMigrations = context.libraryMigrations ?? [];
	if (libMigrations.length > 0) {
		parts.push(formatLibraryMigrationsBlock(libMigrations), "");
	}

	parts.push(`### file: ${wsRel}`, "```ts", fileContent.replace(/\n$/, ""), "```");
	if (typeContexts.length > 0) {
		parts.push("", "### type-context");
		for (const tc of typeContexts) {
			parts.push("```ts", tc, "```");
		}
	}
	// If migrations are present they override taskDescription as the headline.
	const taskHeadline =
		formatLibraryMigrationsTaskDescription(libMigrations) ?? context.taskDescription;
	if (taskHeadline) {
		parts.push("", `### task`, taskHeadline);
	}
	return parts.join("\n");
}

/** @internal — exported for unit tests. */
export function buildUserBlock(context: MendContext, erroredFile: string): string {
	const wsRel = workspaceRelative(context.workspaceRoot, erroredFile);
	const fileDiags = context.diagnostics.filter(
		(d) =>
			d.category === "error" &&
			workspaceRelative(context.workspaceRoot, d.file) === wsRel,
	);
	const lines = fileDiags.map(
		(d) => `${d.file}(${d.line},${d.column}): ${d.code}: ${d.message}`,
	);
	return `tsc reports:\n${lines.join("\n")}\n\nEmit SEARCH/REPLACE blocks to resolve.`;
}

/**
 * Build a Vercel-AI-SDK `LanguageModel` for the requested provider. Each
 * `@ai-sdk/X` package exports a `createX({ apiKey })` factory that returns
 * a callable; calling it with the model name yields a `LanguageModel`
 * compatible with `generateText`.
 *
 * Why factories per call (not module-level singletons): apiKey can vary
 * per call (different callers, different keys); factories are cheap;
 * `generateText` is the hot path and dominates wall time.
 */
function buildLanguageModel(provider: LLMProvider, model: string, apiKey: string): LanguageModel {
	switch (provider) {
		case "anthropic":
			return createAnthropic({ apiKey })(model);
		case "openai":
			return createOpenAI({ apiKey })(model);
		case "google":
			return createGoogleGenerativeAI({ apiKey })(model);
		default: {
			// Exhaustiveness check — TypeScript errors here if a new provider
			// is added to the union without a corresponding case.
			const _exhaustive: never = provider;
			throw new Error(`unknown provider: ${_exhaustive}`);
		}
	}
}

/** @internal — exported so Layer 3 (`multiFileMend`) shares the identical real
 *  provider call path. Tests inject a fake `_callLLM`; real callers get this. */
export const defaultLLMCall: LLMCall = async ({ systemBlock, userBlock, provider = "anthropic", model, apiKey }) => {
	const llmModel = buildLanguageModel(provider, model, apiKey);
	// Use top-level `system:` parameter (Vercel AI SDK v6 pattern) rather than
	// putting a system role inside `messages` — the latter triggers the
	// "system messages in messages field" security warning and can be dropped
	// or rerouted on some providers.
	const result = await generateText({
		model: llmModel,
		system: systemBlock,
		messages: [{ role: "user", content: userBlock }],
	});
	return {
		text: result.text,
		inputTokens: result.usage?.inputTokens ?? 0,
		outputTokens: result.usage?.outputTokens ?? 0,
	};
};

export async function mendSingleFile(
	opts: MendSingleFileOptions,
): Promise<MendSingleFileResult> {
	const { context, llm, dryRun = false, _callLLM = defaultLLMCall } = opts;
	const erroredFile = context.erroredFiles[0];
	if (!erroredFile) {
		throw new Error("mendSingleFile: no errored files in context");
	}

	const systemBlock = buildSystemBlock(context, erroredFile);
	const userBlock = buildUserBlock(context, erroredFile);

	const startMs = Date.now();
	const llmResult = await _callLLM({
		systemBlock,
		userBlock,
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
		inputTokens: llmResult.inputTokens,
		outputTokens: llmResult.outputTokens,
		latencyMs,
	};
}
