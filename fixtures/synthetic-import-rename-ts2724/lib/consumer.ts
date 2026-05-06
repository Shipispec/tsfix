// 'paseDate' is a TS2724: ./util has no exported member 'paseDate',
// did you mean 'parseDate'. LSP fixer should rename the import.

import { formatDate, paseDate } from "./util";

export function roundtrip(s: string): string {
	const d = paseDate(s);
	return formatDate(d);
}
