// SO #50817280: TS2365 — comparing string from input.value to a number.
// https://stackoverflow.com/questions/50817280
export function totalCheck(): boolean {
	const a = (document.getElementById("amount") as HTMLInputElement).value;
	const t = parseFloat("10") + parseFloat("20");
	if (a <= t) {
		return false;
	}
	return true;
}
