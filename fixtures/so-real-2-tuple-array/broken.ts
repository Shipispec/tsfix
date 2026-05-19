// SO #40807744: TS2322 — `tags: [Tag]` is a 1-tuple, not Tag[].
// https://stackoverflow.com/questions/40807744
class Tag {}
class Location {}
export class TagCloud {
	tags: [Tag];
	locations: [Location];
	constructor() {
		this.tags = new Array<Tag>();
		this.locations = new Array<Location>();
	}
}
