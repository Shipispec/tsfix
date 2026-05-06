// Next.js App Router-style page with TS2552 typo + a path alias import.
// `@/lib/util` exercises tsconfig "paths" resolution.
import { describe } from "@/lib/util";

export default function Page(): JSX.Element {
	consol.log("rendered page");
	return <main>{describe("Next page")}</main>;
}
