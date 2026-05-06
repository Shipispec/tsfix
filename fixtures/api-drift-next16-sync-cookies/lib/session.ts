// LLM trained on Next ≤15 docs writes synchronous cookies() / headers()
// access. In Next 16 these return Promise — calling .get() directly is
// TS2339 'Property get does not exist on Promise<...>'. Two errors here
// (one per call site). Mend layer / packageGotchas prompt rule must
// teach the LLM to await.

import { cookies, headers } from "next/headers";

export function getSessionId(): string | undefined {
	return cookies().get("session")?.value;
}

export function getUserAgent(): string | null {
	return headers().get("user-agent");
}
