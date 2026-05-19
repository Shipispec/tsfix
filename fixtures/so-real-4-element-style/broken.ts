// SO #58773652: TS2339 — `Element` doesn't have `.style`, but HTMLElement does.
// https://stackoverflow.com/questions/58773652
export function fixSpacing(): void {
	const test = Array.from(document.getElementsByClassName("mat-form-field-infix"));
	test.forEach((element) => {
		element.style.padding = "10px";
		element.style.borderTop = "0";
	});
}
