/**
 * The app's data: what a workspace holds. Each feature adds its part with `declare module` on this interface, e.g.
 * the types and entities (data feature), the boards, the analyses.
 */
export interface AppData {}

/**
 * A feature's own part of the app's data: one field of it, the list of the feature's units (e.g. `analyses`).
 * The store reads, completes and keeps it without knowing the feature; the feature adds the field to the data's
 * type itself (`declare module` on `AppData`).
 */
export interface DataPart {
	key: string;
	/** The part as the app holds it, of what was saved there — well-formed, the empty list when nothing is. */
	normalize(raw: unknown): unknown[];
}

/** The parts of saved data as the storage holds them: each a list, an empty one where there's none. */
export function storedParts(parts: readonly DataPart[], data: Record<string, unknown>): Record<string, unknown[]> {
	return Object.fromEntries(parts.map(({ key }) => [key, Array.isArray(data[key]) ? (data[key] as unknown[]) : []]));
}

/** The parts of saved data as the app holds them (see `normalize`). */
export function normalizedParts(parts: readonly DataPart[], data: Record<string, unknown>): Record<string, unknown[]> {
	return Object.fromEntries(parts.map(({ key, normalize }) => [key, normalize(data[key])]));
}
