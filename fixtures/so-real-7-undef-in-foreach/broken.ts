// SO #49610779: TS2532 — `input.query` narrows in the outer `if` but the
// narrowing doesn't carry into the forEach callback closure.
// https://stackoverflow.com/questions/49610779
export function testStrict(input: { query?: { [prop: string]: string } }): unknown {
	if (input.query) {
		Object.keys(input.query).forEach((key) => {
			input.query[key];
		});
	}
	return input;
}
