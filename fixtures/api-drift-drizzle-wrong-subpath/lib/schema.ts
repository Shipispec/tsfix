// LLM imports `pgTable` and `integer` from 'drizzle-orm' but they live
// in 'drizzle-orm/pg-core'. Two TS2305 errors. The LSP fixer's
// auto-import code-action MIGHT propose adding the correct import from
// 'drizzle-orm/pg-core' — interesting probe. Documents what happens.

import { pgTable, integer, text, eq } from "drizzle-orm";

export const users = pgTable("users", {
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
});

export const isUserOne = eq(1, 1);
