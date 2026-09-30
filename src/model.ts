import type { Viewport } from "./viewport.js";

export type PropertyKind = "text" | "options" | "reference";

export const PROPERTY_KINDS: readonly PropertyKind[] = ["text", "options", "reference"];

export interface ReferenceDef {
	/** The entity type whose entities can be picked. */
	typeId: string;
	/** Whether several entities can be picked instead of one. */
	multiple: boolean;
}

export interface PropertyDef {
	id: string;
	name: string;
	kind: PropertyKind;
	/** The allowed values of an `options` property; empty for `text`. */
	options: string[];
	/** The target of a `reference` property; null for other kinds. */
	reference: ReferenceDef | null;
}

/** A property as edited in the type form: existing properties keep their id, new ones have none. */
export type DraftProperty = Omit<PropertyDef, "id"> & { id?: string };

export interface EntityType {
	id: string;
	name: string;
	properties: PropertyDef[];
	/** Default text for the `content` of new entities of this type; empty means none. */
	contentTemplate: string;
}

/** Text, an option, one referenced entity id, or several referenced entity ids (never an empty list). */
export type PropertyValue = string | string[] | null;

/** Property names reserved for the built-in entity fields. */
export const RESERVED_PROPERTY_NAMES: readonly string[] = ["id", "name", "content"];

export interface Entity {
	/** ULID, assigned when the entity is created. */
	id: string;
	typeId: string;
	/** Display name. */
	name: string;
	/** Free multiline text. */
	content: string;
	/** Keyed by PropertyDef.id. */
	values: Record<string, PropertyValue>;
}

/** An entity placed on the canvas, in world coordinates. An entity can have several cards. */
export interface CanvasCard {
	id: string;
	entityId: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A named canvas with its own cards and pan/zoom. */
export interface Board {
	id: string;
	name: string;
	/** Later cards are drawn on top. */
	cards: CanvasCard[];
	viewport: Viewport;
}

export const DEFAULT_CARD_SIZE = { width: 240, height: 160 } as const;
export const MIN_CARD_SIZE = { width: 160, height: 80 } as const;

export interface AppData {
	types: EntityType[];
	entities: Entity[];
	/** Never empty. */
	boards: Board[];
}

/** Maps each entity id to its type id, so reference values can be checked. */
export function entityTypeMap(data: AppData): Map<string, string> {
	return new Map(data.entities.map((e) => [e.id, e.typeId]));
}

/**
 * Turns form input or a stored value into a valid value for the property; empty or invalid input becomes null.
 * References keep only ids of existing entities of the target type (per `entityTypes`, entity id → type id).
 */
export function parseValue(
	prop: Pick<PropertyDef, "kind" | "options" | "reference">,
	raw: string | readonly string[],
	entityTypes: ReadonlyMap<string, string> = new Map(),
): PropertyValue {
	if (prop.kind === "reference") {
		const target = prop.reference?.typeId;
		const ids = [...new Set(typeof raw === "string" ? [raw] : raw)].filter((id) => entityTypes.get(id) === target);
		if (prop.reference?.multiple) return ids.length > 0 ? ids : null;
		return ids[0] ?? null;
	}
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	if (prop.kind === "options") return prop.options.includes(trimmed) ? trimmed : null;
	return trimmed;
}

/** Returns a list of problems; an empty list means the type is valid. */
export function validateType(
	name: string,
	properties: Omit<DraftProperty, "id">[],
	typeIds: ReadonlySet<string>,
): string[] {
	const errors: string[] = [];
	if (name.trim() === "") errors.push("Type name is required.");
	const seen = new Set<string>();
	for (const prop of properties) {
		const label = prop.name.trim();
		const key = label.toLowerCase();
		if (key === "") {
			errors.push("Property names are required.");
		} else if (RESERVED_PROPERTY_NAMES.includes(key)) {
			errors.push(`"${label}" is a built-in field and can't be used as a property name.`);
		} else if (seen.has(key)) {
			errors.push(`Duplicate property name "${label}".`);
		}
		seen.add(key);

		if (prop.kind === "options") {
			const options = prop.options.map((o) => o.trim());
			if (options.length === 0) errors.push(`"${label}" needs at least one option.`);
			if (options.some((o) => o === "")) errors.push(`"${label}" has an empty option.`);
			if (new Set(options).size !== options.length) errors.push(`"${label}" has duplicate options.`);
		}
		if (prop.kind === "reference" && !typeIds.has(prop.reference?.typeId ?? "")) {
			errors.push(`"${label}" needs an entity type to reference.`);
		}
	}
	return errors;
}

/** Fits existing values to changed property definitions: drops removed properties and clears values that no longer parse. */
export function migrateValues(
	values: Record<string, PropertyValue>,
	properties: PropertyDef[],
	entityTypes: ReadonlyMap<string, string>,
): Record<string, PropertyValue> {
	const migrated: Record<string, PropertyValue> = {};
	for (const prop of properties) {
		const value = values[prop.id];
		if (value !== undefined) migrated[prop.id] = value === null ? null : parseValue(prop, value, entityTypes);
	}
	return migrated;
}
