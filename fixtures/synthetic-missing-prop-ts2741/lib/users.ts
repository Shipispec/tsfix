// TS2741: object literal missing required property 'age'.
// The mend layer is responsible — Layer 0 cannot guess the
// right value without semantic context.

export interface User {
	name: string;
	age: number;
}

export function makeAlice(): User {
	return { name: "Alice" };
}
