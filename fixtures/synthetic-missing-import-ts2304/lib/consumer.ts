// Uses makeGreeting without importing it — TS2304 "Cannot find name 'makeGreeting'".
// The LSP fixer should auto-add: import { makeGreeting } from "./helpers";

export function shout(name: string): string {
	return makeGreeting(name).toUpperCase();
}
