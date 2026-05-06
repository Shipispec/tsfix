export function add(a: number, b: number): number {
	return a + b;
}

export async function fetchData(url: string): Promise<string> {
	const response = await fetch(url);
	return response.text();
}

export function ensureNonEmpty(s: string): string {
	if (s.length === 0) {
		throw new Error("string must be non-empty");
	}
	return s;
}
