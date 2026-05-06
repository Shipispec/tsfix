// Stand-in for Next.js's auto-generated next-env.d.ts. The real file
// references next/types and next/image-types which we don't ship here
// — only the side-effect of telling tsc that .css imports are legal.
declare module "*.css" {
	const css: string;
	export default css;
}
