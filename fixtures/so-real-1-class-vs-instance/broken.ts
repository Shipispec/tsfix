// SO #33536116: TS2322 — assigning class itself instead of an instance.
// https://stackoverflow.com/questions/33536116
interface IFoo {
	someFunction(): void;
}
interface IBar {
	foo: IFoo;
}
class Foo implements IFoo {
	someFunction(): void {}
}
export class Bar implements IBar {
	foo: IFoo = Foo;
}
