import type { AppData } from "./shared/core/index.js";
import { ENTITY_STORAGE, TYPE_STORAGE } from "./features/data/api.js";
import { postgresStorageOf, sqliteStorageOf, storedUnits, type UnitStorage } from "./shared/api/index.js";
import { ANALYSIS_STORAGE } from "./features/analyses/api.js";
import { BOARD_STORAGE, CARD_STORAGE } from "./features/boards/api.js";
import { DRAWING_STORAGE } from "./features/drawings/api.js";

/**
 * The features' parts of the storage, in one place: a feature joins with a line here, and leaves without a trace
 * by its line going. (Its tables stay in the schema's migrations, which only ever grow.)
 */

/** How each kind of unit is kept, parents before the children naming them — the order they are read, put
 * together and written in. The same kinds in the same order as `UNIT_KINDS` (see `features.api.test.ts`). */
export const UNIT_STORAGES: readonly UnitStorage<any, any, AppData>[] = [TYPE_STORAGE, ENTITY_STORAGE, ANALYSIS_STORAGE, BOARD_STORAGE, CARD_STORAGE, DRAWING_STORAGE];

/** The app's kinds of unit as the storage keeps them (see `StoredUnits`). */
export const STORED_UNITS = storedUnits(UNIT_STORAGES);

/** The app's data in Postgres at `url` (see `postgresStorageOf`). */
export const postgresStorage = (url: string) => postgresStorageOf(url, STORED_UNITS);

/** The app's data in a SQLite file at `path` (see `sqliteStorageOf`). */
export const sqliteStorage = (path: string) => sqliteStorageOf(path, STORED_UNITS);
