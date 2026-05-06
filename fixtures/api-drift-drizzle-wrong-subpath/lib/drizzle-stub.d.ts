// Minimal stubs of drizzle-orm + drizzle-orm/pg-core. The real package
// has ~50 subpaths; LLMs frequently confuse where each helper lives.
// Operators (eq, and) are at the root; column/table builders are in
// /pg-core (or /sqlite-core, /mysql-core).

declare module "drizzle-orm" {
	export function eq<T>(a: T, b: T): unknown;
	export function and(...args: unknown[]): unknown;
	export const sql: (template: TemplateStringsArray, ...values: unknown[]) => unknown;
}

declare module "drizzle-orm/pg-core" {
	export function pgTable(name: string, columns: Record<string, unknown>): unknown;
	export function integer(name: string): { primaryKey(): unknown };
	export function text(name: string): { notNull(): unknown };
}
