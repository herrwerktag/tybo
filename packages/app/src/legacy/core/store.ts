import { createStoreCore, type DataFormat, type DataPort } from "../../shared/core/index.js";
import { BOARD_LISTS, changesBetween, dataOps, keepWellFormed, normalizeEntityData, normalizedFeatureData, reconcileValues, storedFeatureData } from "../../features.core.js";
import { boardOps, keepViewports, newBoard, normalizeBoards, pruneCards, storedBoards } from "../../features/boards/core.js";
import { drawingOps } from "./drawings.js";
import type { AppData } from "./model.js";

export type Store = Awaited<ReturnType<typeof createStore>>;

/** The format of the saved data. When it changes, raise this and add the step from the old version to MIGRATIONS —
 * and a step to the API's schema (apps/api: schema.ts and sqlite.ts) that brings the stored rows to the new format
 * and sets `workspaces.data_version` to it. Saves write only the units that changed, so stored data never catches
 * up by itself: without that step, unchanged units stay in the old format under a version that says otherwise. The
 * API's tests fail as long as the step is missing. */
export const DATA_VERSION = 9;

type SavedData = Record<string, unknown>;

/**
 * For each version, the step that turns data saved in it into the next version, run before the data is checked.
 * Version 0 is data saved before versions existed: normalize() still reads all of its older shapes, so its step
 * has nothing to do.
 */
export const MIGRATIONS: Readonly<Record<number, (data: SavedData) => SavedData>> = {
	0: (data) => data,
	// Version 2 adds board kinds and storyboard pages, version 3 turns them into story mode; both dropped in version 8.
	1: (data) => data,
	2: (data) => data,
	// Version 4 adds the library (dropped in version 9).
	3: (data) => data,
	// Version 5 gives boards several stories (dropped in version 8).
	4: (data) => data,
	// Version 6 shows boards in view frames; normalizeBoard() gives each board a frame of its own pan/zoom.
	5: (data) => data,
	// Version 7 adds analyses; normalize() gives data without them none.
	6: (data) => data,
	// Version 8 drops stories and the frames of their steps; normalizeBoard() no longer reads them.
	7: (data) => data,
	// Version 9 drops the library and placed library drawings; normalize() no longer reads them.
	8: (data) => data,
};

/** The version saved data says it's in; data without a (valid) version is from before versions existed. */
function savedVersion(data: SavedData): number {
	return Number.isInteger(data.version) && (data.version as number) >= 0 ? (data.version as number) : 0;
}

/** Brings saved data up to `target`, one step per version from the version it was saved in. */
export function migrate(data: SavedData, steps = MIGRATIONS, target = DATA_VERSION): SavedData {
	let migrated = data;
	for (let version = savedVersion(data); version < target; version++) migrated = steps[version]!(migrated);
	return migrated;
}

/** The data as it's saved and exported: marked with the format version. */
export function toSaved(data: AppData): SavedData {
	return { version: DATA_VERSION, ...data };
}

function emptyData(): AppData {
	return { types: [], entities: [], boards: [newBoard("Board 1", BOARD_LISTS)], ...storedFeatureData({}) };
}

/** Re-validates every entity's values against its type's current properties, e.g. dropping references to deleted entities,
 * and drops cards of deleted entities. */
function reconcile(data: AppData): AppData {
	return pruneCards(reconcileValues(data));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether `value` has the shape of saved data (types and entities lists), so loading can make use of it. */
export function looksLikeAppData(value: unknown): value is Record<string, unknown> & Pick<AppData, "types" | "entities"> {
	return isObject(value) && Array.isArray(value.types) && Array.isArray(value.entities);
}

/** The units the storage holds, as far as they can be compared with this app's — what change sets are
 * built from. */
function storedStand(data: AppData): AppData {
	return { types: data.types, entities: data.entities, boards: storedBoards(data, BOARD_LISTS), ...storedFeatureData(data) };
}

/** Fills in fields that data saved by earlier versions may lack (e.g. number/boolean/date kinds, non-string values, entity names, ULIDs). */
function normalize(data: AppData): AppData {
	return {
		boards: normalizeBoards(data, BOARD_LISTS),
		...normalizedFeatureData(data),
		...normalizeEntityData(data),
	};
}

/** Imported data as the app holds it — brought up to this format, checked and completed the way a load
 * does — or null when it isn't app data, or is from a newer version of the app than this one. */
export function prepareImport(raw: unknown): AppData | null {
	if (!looksLikeAppData(raw) || savedVersion(raw) > DATA_VERSION) return null;
	return reconcile(normalize(keepWellFormed(migrate(raw) as unknown as AppData)));
}

/** The app's saved data as the store and the workspaces read, save, compare and import it. */
export const APP_FORMAT: DataFormat<AppData> = {
	version: DATA_VERSION,
	read(raw) {
		if (!looksLikeAppData(raw)) return null;
		if (savedVersion(raw) > DATA_VERSION) {
			const understood = reconcile(normalize(keepWellFormed(raw as unknown as AppData)));
			return { data: understood, problem: { code: "newerVersion" }, stand: null };
		}
		const kept = keepWellFormed(migrate(raw) as unknown as AppData);
		return { data: reconcile(normalize(kept)), problem: null, stand: storedStand(kept) };
	},
	looksLike: looksLikeAppData,
	prepareImport,
	empty: emptyData,
	nothing: () => ({ types: [], entities: [], boards: [], ...storedFeatureData({}) }),
	toSaved,
	changesBetween,
	// Undo and redo restore everything but the boards' pan and zoom, which stay as they are now.
	restore: keepViewports,
};

/** The data of one workspace, kept in memory and saved through `port` as it changes (see `createStoreCore`), with
 * the changes the app makes to it. */
export async function createStore(port: DataPort, workspaceId: string) {
	const core = await createStoreCore(port, workspaceId, APP_FORMAT);
	return Object.assign(core, dataOps(core, pruneCards), boardOps(core, BOARD_LISTS), drawingOps(core));
}
