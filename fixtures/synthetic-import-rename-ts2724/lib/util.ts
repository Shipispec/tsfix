export function formatDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function parseDate(s: string): Date {
	return new Date(s);
}
