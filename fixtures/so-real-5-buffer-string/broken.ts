// SO #46190511: TS2345 — passing Buffer to JSON.parse which expects string.
// https://stackoverflow.com/questions/46190511
// Minimal repro: type a value as Buffer and pass to JSON.parse.
declare const incoming: { content: Buffer };
export function handleMessage(): void {
	const data = JSON.parse(incoming.content);
	void data;
}
