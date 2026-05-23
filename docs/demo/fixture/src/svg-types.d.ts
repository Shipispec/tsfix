// vite-plugin-svgr v4+: SVG-as-React-component only matches `*.svg?react`.
// The plain `*.svg` ambient now resolves to the asset URL (string), not a component.
declare module "*.svg?react" {
	const Component: (props: { width?: number; height?: number }) => unknown;
	export default Component;
}
declare module "*.svg" {
	const src: string;
	export default src;
}
