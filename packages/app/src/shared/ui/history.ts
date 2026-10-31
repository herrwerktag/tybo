/**
 * How the history page tells of a unit: each feature describes the units of its own kinds (see `UnitDescriber`),
 * the page puts the descriptions together — what was made, changed or deleted, and which fields changed how.
 * So the page knows no feature, and a feature's units are read the way the feature reads them.
 */

/** One field of a unit, the way someone reads it: its label and its value as text. A `long` text (a
 * description, say) is never put beside its old one: its change is named, and the old text shown on request. */
export interface HistoryField {
	label: string;
	text: string;
	long?: boolean;
}

/** A unit's stand as someone reads it: its name, where it belongs (an entity's type, a card's board), the color it
 * is known by (its type's), and its fields. The name isn't a field: the page shows its change on its own. */
export interface ReadUnit {
	name: string;
	context?: string;
	color?: string;
	/** The entity type it belongs to (an entity's, a card's entity's, a type itself), to filter the history by. */
	type?: { id: string; name: string };
	fields: HistoryField[];
}

/** What a unit is part of: the data itself (types, entities), or a view of it (boards, cards, analyses). */
export type HistoryArea = "data" | "view";

/** How the history tells of the units of one kind (see features.ui.ts). */
export interface UnitDescriber<S> {
	kind: string;
	area: HistoryArea;
	/** The kind's name for `count` units, e.g. "entity" or "entities". */
	noun(count: number): string;
	/** The unit's stand (the `value` of its `UnitStand`) as read, with `store` naming what it refers to; null when
	 * it has a shape this app doesn't know. `boardId` is the board a card or drawing stands on. */
	read(value: unknown, store: S, boardId: string | null): ReadUnit | null;
	/** What a change of a unit is called when it is more than "changed" (a card that went elsewhere: moved). */
	changeVerb?(before: unknown, after: unknown): string | undefined;
	/** Whether a change is one nobody reads the unit for (a card moved or resized): the page shows it faint. */
	minor?(before: unknown, after: unknown): boolean;
}

/** A link of a feature from an entity to a page of its own (e.g. the entity's history). */
export interface EntityLink {
	label(): string;
	href(entityId: string): string;
}

/** Whether `value` is a record — what every stand the describers read has to be, at least. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
