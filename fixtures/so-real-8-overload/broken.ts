// SO #51642830: TS2554 — function overload signature lists only 1 arg, but
// caller passes 2. Need to add a second overload signature.
// https://stackoverflow.com/questions/51642830
function randIntIncl(max: number): number;
function randIntIncl(min: number, max?: number): number {
	if (max === undefined) {
		max = min;
		min = 0;
	}
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const result = randIntIncl(1, 9999);
