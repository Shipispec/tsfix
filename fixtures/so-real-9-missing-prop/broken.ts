// SO #56626749: TS2741 — object literal missing `isEqual` method required
// by the User class type. Fix: instantiate `new User(...)`.
// https://stackoverflow.com/questions/56626749
export class User {
	constructor(public firstName: string, public lastName: string) {}
	isEqual(other: User): boolean {
		return other === this;
	}
}

export class UserService {
	private users: User[] = [
		{ firstName: "William", lastName: "Jones" },
		{ firstName: "John", lastName: "Doe" },
	];
}
