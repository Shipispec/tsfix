import { value } from "./shared";

// Treats the shared `value` as a number. Errors (TS2362) while `Value` is
// `string`; clean only when `Value` is `number`.
export const doubled: number = value * 2;
