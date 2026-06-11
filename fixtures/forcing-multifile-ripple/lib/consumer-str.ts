import { value } from "./shared";

// Treats the shared `value` as a string. Clean while `Value` is `string`;
// errors (TS2339 — no `.toUpperCase` on number) when `Value` is `number`.
export const shout: string = value.toUpperCase();
