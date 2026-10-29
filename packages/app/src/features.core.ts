import { changesOf, normalizedParts, storedParts, unitStandsOf, type Change, type DataPart, type UnitKind, type UnitStands } from "./shared/core/index.js";
import { BOARD_UNIT, CARD_UNIT, DRAWING_UNIT, ENTITY_UNIT, TYPE_UNIT } from "./legacy/core/changes.js";
import type { AppData } from "./legacy/core/model.js";
import { ANALYSES_PART, ANALYSIS_UNIT } from "./features/analyses/core.js";

export * from "./features/analyses/core.js";

/**
 * The features' parts of the core, in one place: a feature joins with a line here, and leaves without a trace
 * by its line going.
 */

/** The kinds of unit of the app's data, parents before the children naming them. */
export const UNIT_KINDS: readonly UnitKind<AppData, any>[] = [TYPE_UNIT, ENTITY_UNIT, ANALYSIS_UNIT, BOARD_UNIT, CARD_UNIT, DRAWING_UNIT];

/** The features' own parts of the app's data (see `DataPart`). */
export const DATA_PARTS: readonly DataPart[] = [ANALYSES_PART];

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
