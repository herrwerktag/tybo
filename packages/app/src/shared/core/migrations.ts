/**
 * The history of the saved data's format: its version now, and the steps from each earlier one. It only ever grows,
 * a step at a time (the features' parts come and go without touching it).
 */

/** The format of the saved data. When it changes, raise this and add the step from the old version to MIGRATIONS —
 * and a step to the API's schema (apps/api: schema.ts and sqlite.ts) that brings the stored rows to the new format
 * and sets `workspaces.data_version` to it. Saves write only the units that changed, so stored data never catches
 * up by itself: without that step, unchanged units stay in the old format under a version that says otherwise. The
 * API's tests fail as long as the step is missing. */
export const DATA_VERSION = 9;

/** Saved data, in whatever shape some version of the app saved it. */
export type SavedData = Record<string, unknown>;

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
export function savedVersion(data: SavedData): number {
	return Number.isInteger(data.version) && (data.version as number) >= 0 ? (data.version as number) : 0;
}

/** Brings saved data up to `target`, one step per version from the version it was saved in. */
export function migrate(data: SavedData, steps = MIGRATIONS, target = DATA_VERSION): SavedData {
	let migrated = data;
	for (let version = savedVersion(data); version < target; version++) migrated = steps[version]!(migrated);
	return migrated;
}
