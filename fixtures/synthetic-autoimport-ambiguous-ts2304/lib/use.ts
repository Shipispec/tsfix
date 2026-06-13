// TS2304: 'Foo' is unimported, and BOTH ./a and ./b export a 'Foo'. The auto-
// import has two equally-valid candidates, so Layer 1 MUST abstain (picking one
// could import the wrong symbol) and leave the error for Layer 2. Report-only:
// this pins the abstain — if the fixer ever guessed a candidate, this fixture
// would stop meeting contract.
export const x = Foo;
