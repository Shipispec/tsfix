// Minimal stub of next/headers for testing the Next.js 16 async API.
// In Next 16, cookies() and headers() return Promise — the synchronous
// fallback was removed. The real package's .d.ts has the same signature;
// we stub it here so the fixture doesn't need a real next install.

declare module "next/headers" {
	export interface ReadonlyRequestCookies {
		get(name: string): { name: string; value: string } | undefined;
	}
	export interface ReadonlyHeaders {
		get(name: string): string | null;
	}
	export function cookies(): Promise<ReadonlyRequestCookies>;
	export function headers(): Promise<ReadonlyHeaders>;
}
