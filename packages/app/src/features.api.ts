import type { AppData } from "./legacy/core/model.js";
import { DRAWING_STORAGE } from "./legacy/api/units.js";
import { ENTITY_STORAGE, TYPE_STORAGE } from "./features/data/api.js";
import type { UnitStorage } from "./shared/api/index.js";
import { ANALYSIS_STORAGE } from "./features/analyses/api.js";
import { BOARD_STORAGE, CARD_STORAGE } from "./features/boards/api.js";

/**
 * The features' parts of the storage, in one place: a feature joins with a line here, and leaves without a trace
 * by its line going. (Its tables stay in the schema's migrations, which only ever grow.)
 */

/** How each kind of unit is kept, parents before the children naming them — the order they are read, put
 * together and written in. */
export const UNIT_STORAGES: readonly UnitStorage<any, any, AppData>[] = [TYPE_STORAGE, ENTITY_STORAGE, ANALYSIS_STORAGE, BOARD_STORAGE, CARD_STORAGE, DRAWING_STORAGE];

/** How the kind named is kept, or undefined for a kind there is none of. */
export function storageOf(kind: string): UnitStorage | undefined {
	return UNIT_STORAGES.find((storage) => storage.unit.kind === kind);
}

/** The app's data put together of every kind's rows, parents first. */
export function assembleAppData(rows: readonly unknown[]): AppData {
	return UNIT_STORAGES.reduce((data, storage, index) => storage.assemble(data, rows[index]), {} as AppData);
}

/** The app's kinds of unit, in the order of their storages. */
export const STORED_KINDS = UNIT_STORAGES.map(({ unit }) => unit);
