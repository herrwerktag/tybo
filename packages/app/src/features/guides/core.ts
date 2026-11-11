import type { AppData, DataPart, StoreCore, UnitKind } from "../../shared/core/index.js";

/**
 * The workspace's guide: one Markdown text saying how the workspace is worked with — its method, how its types play
 * together, an example. Its part of the app's data is `guide`; it is a unit of its own, so writing it writes no
 * type, and it has its own entries in the history. (What a type or a property is for is told with them, see the
 * data feature.)
 */
declare module "../../shared/core/data.js" {
	interface AppData {
		/** The workspace's guide (Markdown); empty when there is none. */
		guide: string;
	}
}

/** The guide as a unit of the saved data: the only one of its kind, there as long as it has a text. */
export interface GuideUnit {
	id: typeof GUIDE_ID;
	text: string;
}

/** The id of the guide's unit — one per workspace. */
export const GUIDE_ID = "guide";

/** A store of data holding a guide. */
export type GuideStore = StoreCore<AppData>;

/** A guide as it is kept: as written, nothing when there is only white space. */
const guideText = (raw: unknown): string => (typeof raw === "string" && raw.trim() !== "" ? raw : "");

/** The guide's part of the app's data. */
export const GUIDE_PART: DataPart = { key: "guide", normalize: guideText, stored: guideText };

/** The guide is one unit: there with its text, gone without. */
export const GUIDE_UNIT: UnitKind<AppData, GuideUnit> = {
	kind: "guide",
	lists: (data) => [{ items: guideText(data.guide) === "" ? [] : [{ id: GUIDE_ID, text: data.guide }] }],
	withList: (data, items) => ({ ...data, guide: guideText(items[0]?.text) }),
};

/** Replaces the workspace's guide; an empty text takes it away. */
export function setGuide(store: GuideStore, text: string): void {
	store.change({ ...store.data, guide: guideText(text) });
}
