import {
	DATA_VERSION,
	changesOf,
	createStoreCore,
	createWorkspacesOf,
	exportWorkspaceOf,
	migrate,
	normalizedParts,
	readWorkspaceFileOf,
	savedVersion,
	toSaved,
	storedParts,
	unitStandsOf,
	type ActiveWorkspacePreference,
	type AppData,
	type Change,
	type DataFormat,
	type DataPart,
	type DataPort,
	type UnitKind,
	type UnitStands,
} from "./shared/core/index.js";
import { ENTITY_UNIT, TYPE_UNIT, dataOps, keepWellFormed, normalizeEntityData, reconcileValues } from "./features/data/core.js";
import { ANALYSES_PART, ANALYSIS_UNIT } from "./features/analyses/core.js";
import { BOARD_UNIT, CARD_UNIT, boardOps, keepViewports, newBoard, normalizeBoards, pruneCards, storedBoards, type BoardList } from "./features/boards/core.js";
import { DRAWING_LIST, DRAWING_UNIT } from "./features/drawings/core.js";

export * from "./features/data/core.js";
export * from "./features/analyses/core.js";
export * from "./features/boards/core.js";
export * from "./features/drawings/core.js";

/**
 * The features' parts of the core, in one place: a feature joins with a line here, and leaves without a trace
 * by its line going. Below them the app's store and workspaces, put together of those parts.
 */

/** The kinds of unit of the app's data, parents before the children naming them. */
export const UNIT_KINDS: readonly UnitKind<AppData, any>[] = [TYPE_UNIT, ENTITY_UNIT, ANALYSIS_UNIT, BOARD_UNIT, CARD_UNIT, DRAWING_UNIT];

/** The features' own parts of the app's data (see `DataPart`). */
export const DATA_PARTS: readonly DataPart[] = [ANALYSES_PART];

/** The features' own lists on each board, next to its cards (see `BoardList`). */
export const BOARD_LISTS: readonly BoardList[] = [DRAWING_LIST];

/** What the features' parts make of the app's data. */
export type FeatureData = Omit<AppData, "types" | "entities" | "boards">;

/** The features' parts of saved data as the storage holds them: each a list, an empty one where there's none. */
export function storedFeatureData(data: object): FeatureData {
	return storedParts(DATA_PARTS, data as Record<string, unknown>) as unknown as FeatureData;
}

/** The features' parts of saved data as the app holds them, each well-formed (see `DataPart`). */
export function normalizedFeatureData(data: object): FeatureData {
	return normalizedParts(DATA_PARTS, data as Record<string, unknown>) as unknown as FeatureData;
}

/** The units of a state with their places (see `unitStandsOf`). */
export function unitStands(data: AppData): UnitStands {
	return unitStandsOf(UNIT_KINDS, data);
}

/** The units in which two states of the app's data differ (see `changesOf`). */
export function changesBetween(before: AppData, after: AppData): Change[] {
	return changesOf(UNIT_KINDS, before, after);
}


export type Store = Awaited<ReturnType<typeof createStore>>;


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
	return Object.assign(core, dataOps(core, pruneCards), boardOps(core, BOARD_LISTS));
}

/** The app's workspaces, each opened as the app's store (see `createWorkspacesOf`). */
export function createWorkspaces(port: DataPort, defaultName: (n: number) => string, preference: ActiveWorkspacePreference) {
	return createWorkspacesOf(port, APP_FORMAT, (id) => createStore(port, id), defaultName, preference);
}

export type Workspaces = Awaited<ReturnType<typeof createWorkspaces>>;

/** A workspace of the app as a JSON file (see `exportWorkspaceOf` in shared/core). */
export const exportWorkspace = (name: string, data: AppData): string => exportWorkspaceOf(APP_FORMAT, name, data);

/** Reads an exported workspace file of the app (see `readWorkspaceFileOf` in shared/core). */
export const readWorkspaceFile = (text: string) => readWorkspaceFileOf(APP_FORMAT, text);
