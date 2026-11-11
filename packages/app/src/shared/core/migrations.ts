import { ULID_ENCODING } from "./ulid.js";

/**
 * The history of the saved data's format: its version now, and the steps from each earlier one. It only ever grows,
 * a step at a time (the features' parts come and go without touching it).
 */

/** The format of the saved data. When it changes, raise this and add the step from the old version to MIGRATIONS —
 * and a step to the database schema (shared/api: schema.ts and sqlite.ts) that brings the stored rows to the new format
 * and sets `workspaces.data_version` to it. Saves write only the units that changed, so stored data never catches
 * up by itself: without that step, unchanged units stay in the old format under a version that says otherwise. The
 * API's tests fail as long as the step is missing. */
export const DATA_VERSION = 14;

/** A 53-bit string hash, so several seeds give enough independent bits for a ULID's 130. */
function cyrb53(text: string, seed: number): number {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * The id a format-9 option gets, derived from the property's and its label: deterministic, so imported data
 * and stored rows — wherever the step runs — agree on it. A valid ULID (see `isUlid` in ulid.ts).
 */
export function legacyOptionId(propertyId: string, label: string): string {
	const key = `${propertyId}\u0000${label}`;
	let id = "";
	for (let seed = 0; id.length < 26; seed++) {
		let hash = cyrb53(key, seed);
		for (let i = 0; i < 10 && id.length < 26; i++) {
			// 32 characters take 5 bits each; the first of a ULID only reaches 0–7 (3 bits).
			const bits = id.length === 0 ? 8 : 32;
			id += ULID_ENCODING[hash % bits];
			hash = Math.floor(hash / bits);
		}
	}
	return id;
}

/** The options of a format-9 property (a list of label strings) with their ids: string items only, a label twice there once. */
export function optionsWithIds(propertyId: string, raw: unknown): { id: string; label: string }[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	return raw.flatMap((item) => {
		if (typeof item !== "string" || seen.has(item)) return [];
		seen.add(item);
		return [{ id: legacyOptionId(propertyId, item), label: item }];
	});
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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
	// Version 10 gives options ids; entities hold the option's id instead of its text.
	9: (data) => {
		const optionsOf = new Map<string, { id: string; label: string }[]>();
		const types = (Array.isArray(data.types) ? data.types : []).map((type) => {
			if (!isRecord(type) || !Array.isArray(type.properties)) return type;
			let changed = false;
			const properties = type.properties.map((property) => {
				if (!isRecord(property) || property.kind !== "options" || typeof property.id !== "string" || !Array.isArray(property.options)) return property;
				const options = optionsWithIds(property.id, property.options);
				optionsOf.set(property.id, options);
				changed = true;
				return { ...property, options };
			});
			return changed ? { ...type, properties } : type;
		});
		const entities = (Array.isArray(data.entities) ? data.entities : []).map((entity) => {
			if (!isRecord(entity) || !isRecord(entity.values)) return entity;
			let changed = false;
			const values = Object.fromEntries(
				Object.entries(entity.values).flatMap(([propertyId, value]) => {
					const options = optionsOf.get(propertyId);
					if (!options) return [[propertyId, value]];
					changed = true;
					const option = options.find((o) => o.label === value);
					return option ? [[propertyId, option.id]] : [];
				}),
			);
			return changed ? { ...entity, values } : entity;
		});
		return { ...data, types, entities };
	},
	// Version 11 adds traits and analyses of a trait; normalize() gives data without them none, and its analyses
	// are of a type.
	10: (data) => data,
	// Version 12 gives a trait's reference roles conditions; normalize() reads a role without one as having none.
	11: (data) => data,
	// Version 13 makes each grouping level of an analysis its path and whether it hides the rows it leads nowhere from;
	// a path before shows them all.
	12: (data) => {
		if (!Array.isArray(data.analyses)) return data;
		const analyses = data.analyses.map((analysis) =>
			isRecord(analysis) && Array.isArray(analysis.groups)
				? { ...analysis, groups: analysis.groups.map((path) => (Array.isArray(path) ? { path, hideEmpty: false } : path)) }
				: analysis,
		);
		return { ...data, analyses };
	},
	// Version 14 adds the model's help: the workspace's guide, a type's description and guide, a property's
	// description — none of them there before.
	13: (data) => {
		const types = (Array.isArray(data.types) ? data.types : []).map((type) => {
			if (!isRecord(type)) return type;
			const properties = Array.isArray(type.properties)
				? type.properties.map((property) => (isRecord(property) ? { description: "", ...property } : property))
				: type.properties;
			return { description: "", guide: "", ...type, properties };
		});
		return { guide: "", ...data, types };
	},
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

/** The data as it's saved and exported: marked with the format version. */
export function toSaved(data: object): SavedData {
	return { version: DATA_VERSION, ...data };
}
