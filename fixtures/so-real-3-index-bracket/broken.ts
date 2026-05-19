// SO #38324949: TS2339 — index signatures require bracket access.
// https://stackoverflow.com/questions/38324949
interface Images {
	[key: string]: string;
}
export function getMainImageUrl(images: Images): string {
	return images.main;
}
