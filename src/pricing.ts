/**
 * Single source of truth for LLM token pricing + cost computation.
 *
 * Consumed by the library (`src/index.ts` → `runFullStack`), the CLI
 * (`cli/run-stack.ts`), and the benchmark. Previously the table was duplicated
 * in index.ts and run-stack.ts; this module dedups them (resolves the
 * index.ts:451 TODO).
 */

import type { LLMProvider } from "./mendAgent.js";

// USD per million tokens. Pricing snapshot: 2026-05-16.
// Verified against the live pricing pages:
// - Anthropic: docs.claude.com/en/docs/about-claude/pricing
// - OpenAI:    via the LiteLLM model_prices_and_context_window.json mirror
//              (raw.githubusercontent.com/BerriAI/litellm/...) since
//              openai.com/api/pricing blocks plain HTTP fetchers
// - Google:    ai.google.dev/gemini-api/docs/pricing
// Unknown (provider, model) pairs report cost as 0 — budget cap won't trigger,
// since we can't compute spend reliably. Re-verify the table before any tagged
// release; provider pricing shifts.
export const PRICING: Record<LLMProvider, Record<string, { input: number; output: number }>> = {
	anthropic: {
		// All 4.5+ models share the same tier (the 4.5 release brought a
		// significant price drop on Opus). 4.1 retains the older Opus tier.
		"claude-haiku-4-5": { input: 1.0, output: 5.0 },
		"claude-sonnet-4-5": { input: 3.0, output: 15.0 },
		"claude-sonnet-4-6": { input: 3.0, output: 15.0 },
		"claude-opus-4-5": { input: 5.0, output: 25.0 },
		"claude-opus-4-6": { input: 5.0, output: 25.0 },
		"claude-opus-4-7": { input: 5.0, output: 25.0 },
		"claude-opus-4-1": { input: 15.0, output: 75.0 },
	},
	openai: {
		// Mini / nano tiers — well-matched to TypeScript repair (small
		// context, structured output). Default model uses one of these.
		"gpt-5-nano": { input: 0.05, output: 0.4 },
		"gpt-5-mini": { input: 0.25, output: 2.0 },
		// gpt-5 flagship + recent point releases (all $1.25 / $10).
		"gpt-5": { input: 1.25, output: 10.0 },
		"gpt-5.1": { input: 1.25, output: 10.0 },
		"gpt-5.2": { input: 1.75, output: 14.0 },
		// Reasoning models — sometimes better at semantic repair, more expensive.
		"o3-mini": { input: 1.1, output: 4.4 },
		"o4-mini": { input: 1.1, output: 4.4 },
		"o3": { input: 2.0, output: 8.0 },
	},
	google: {
		// Lite < flash < pro, matching the haiku/sonnet/opus mental model.
		"gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
		"gemini-2.5-flash": { input: 0.3, output: 2.5 },
		// Standard tier (≤200k tokens). 2.5-pro doubles to $2.50/$15.00 above
		// 200k — not modeled here since our prompts are well below that.
		"gemini-2.5-pro": { input: 1.25, output: 10.0 },
	},
};

/**
 * Cost in USD for a single (provider, model) call given token counts.
 * Returns 0 for unknown (provider, model) pairs.
 */
export function costUsd(
	provider: LLMProvider,
	model: string,
	inputTokens: number,
	outputTokens: number,
): number {
	const p = PRICING[provider]?.[model];
	if (!p) return 0;
	return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}
