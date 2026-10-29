/**
 * The app's data proper: entity types with their properties, and entities with their values. Its part of the app's
 * data is `types` and `entities` (see `EntityData`); the boards and the other features build on it.
 */

/** The types and the entities, as the app's data holds them. */
export interface EntityData {
	types: EntityType[];
	entities: Entity[];
}

declare module "../../../shared/core/data.js" {
	interface AppData extends EntityData {}
}

export type PropertyKind = "text" | "options" | "reference";

export const PROPERTY_KINDS: readonly PropertyKind[] = ["text", "options", "reference"];

export interface ReferenceDef {
	/** The entity types whose entities can be picked (e.g. both Event and State can trigger an Activity). */
	typeIds: string[];
	/** Whether several entities can be picked instead of one. */
	multiple: boolean;
	/**
	 * Whether an entity should reference at least one entity through it. Not enforced when saving (entities are often
	 * made before what they reference); entities without one are pointed out instead (see missingRequired).
	 */
	required: boolean;
	/** Where the arrowhead goes when drawn as a line: at the referenced card, at this card, or nowhere. */
	arrow: LineArrow;
	/** Text on the line; empty means the property name. */
	lineLabel: string;
	/**
	 * Label for the reverse direction, shown on the referenced entities (e.g. "responsible for" on a Role,
	 * for Activity.responsible). Empty means the reverse direction isn't shown.
	 */
	inverseLabel: string;
}

export type LineArrow = "to" | "from" | "none";

export const LINE_ARROWS: readonly LineArrow[] = ["to", "from", "none"];

export function newReference(typeIds: string[]): ReferenceDef {
	return { typeIds, multiple: false, required: false, arrow: "to", lineLabel: "", inverseLabel: "" };
}

export interface PropertyDef {
	id: string;
	name: string;
	kind: PropertyKind;
	/** The allowed values of an `options` property; empty for `text`. */
	options: string[];
	/** The target of a `reference` property; null for other kinds. */
	reference: ReferenceDef | null;
	/** How the value appears on the entity's canvas cards. */
	cardDisplay: CardDisplay;
}

/**
 * `list`: in the card's label/value list. `line`: references only, drawn as a connector to the
 * target's card (listed instead while that card isn't on the board). `hidden`: not on cards.
 */
export type CardDisplay = "list" | "line" | "hidden";

export const CARD_DISPLAYS: readonly CardDisplay[] = ["list", "line", "hidden"];

/** `line` only applies to references; other kinds fall back to `list`. */
export function effectiveCardDisplay(prop: Pick<PropertyDef, "kind" | "cardDisplay">): CardDisplay {
	return prop.cardDisplay === "line" && prop.kind !== "reference" ? "list" : prop.cardDisplay;
}

/** A property as edited in the type form: existing properties keep their id, new ones have none. */
export type DraftProperty = Omit<PropertyDef, "id"> & { id?: string };

export interface EntityType {
	id: string;
	name: string;
	properties: PropertyDef[];
	/** Default text for the `content` of new entities of this type; empty means none. */
	contentTemplate: string;
	/** Hex color, e.g. for the top bar of the type's cards on the canvas. */
	color: string;
}

/** Soft, clearly distinct colors that dark text stays readable on. */
export const TYPE_COLORS: readonly { name: string; value: string }[] = [
	{ name: "Red", value: "#f9c9c9" },
	{ name: "Orange", value: "#fbd9b0" },
	{ name: "Yellow", value: "#f6e8a6" },
	{ name: "Green", value: "#c8ebbf" },
	{ name: "Teal", value: "#b9e4df" },
	{ name: "Blue", value: "#c4dafa" },
	{ name: "Violet", value: "#d6ccf7" },
	{ name: "Pink", value: "#f4c6e3" },
	{ name: "Gray", value: "#dcdcdc" },
];

/** The first palette color not in use; once all are taken, colors repeat in palette order. */
export function nextTypeColor(usedColors: readonly string[]): string {
	const used = new Set(usedColors.map((c) => c.toLowerCase()));
	const free = TYPE_COLORS.find((c) => !used.has(c.value));
	return (free ?? TYPE_COLORS[usedColors.length % TYPE_COLORS.length]!).value;
}

/** Text, an option, one referenced entity id, or several referenced entity ids (never an empty list). */
export type PropertyValue = string | string[] | null;

/** Property names reserved for the built-in entity fields. */
export const RESERVED_PROPERTY_NAMES: readonly string[] = ["id", "name", "content", "description"];

export interface Entity {
	/** ULID, assigned when the entity is created. */
	id: string;
	typeId: string;
	/** Display name. */
	name: string;
	/** Free multiline text, shown on the entity's cards. */
	content: string;
	/** Longer text with detailed information, shown in the canvas details panel (not on cards). */
	description: string;
	/** Sets the entity belongs to, for filtering (e.g. one project's entities); trimmed, without duplicates. */
	tags: string[];
	/** Keyed by PropertyDef.id. */
	values: Record<string, PropertyValue>;
}

/** Turns comma-separated input into tags: trimmed, without empty ones and duplicates (ignoring case). */
export function parseTags(input: string): string[] {
	const seen = new Set<string>();
	return input.split(",").flatMap((raw) => {
		const tag = raw.trim();
		const key = tag.toLocaleLowerCase();
		if (tag === "" || seen.has(key)) return [];
		seen.add(key);
		return [tag];
	});
}

/**
 * A way two entities can be linked, seen from one of them: through one of its own reference properties
 * (`forward`, it holds the reference), or through a property of another type that can reference it (`inverse`,
 * the other entity holds it).
 */
export interface Relation {
	prop: PropertyDef;
	direction: "forward" | "inverse";
	/** The type of the entity at the other end. */
	typeId: string;
}

/** Whether the reference property can take one more entity: it allows several, or it's still empty. */
export function canTakeMore(prop: PropertyDef, value: PropertyValue | undefined): boolean {
	return prop.reference?.multiple === true || referencedIds(prop, value).length === 0;
}

/** The required reference properties of `entity`'s type that reference nothing yet, in property order. */
export function missingRequired(type: Pick<EntityType, "properties"> | undefined, entity: Entity): PropertyDef[] {
	return (type?.properties ?? []).filter(
		(prop) => prop.reference?.required === true && referencedIds(prop, entity.values[prop.id]).length === 0,
	);
}

/**
 * The relations `entity` can get one more entity through, in type and property order: its own references that can
 * take one more (to each of their target types), then every reference of any type that can point at it.
 */
export function relationsOf(types: readonly EntityType[], entity: Entity): Relation[] {
	const own = types.find((t) => t.id === entity.typeId)?.properties ?? [];
	const forward = own.flatMap((prop) =>
		prop.kind === "reference" && canTakeMore(prop, entity.values[prop.id])
			? (prop.reference?.typeIds ?? []).map((typeId): Relation => ({ prop, direction: "forward", typeId }))
			: [],
	);
	const inverse = types.flatMap((type) =>
		type.properties.flatMap((prop): Relation[] =>
			prop.kind === "reference" && prop.reference?.typeIds.includes(entity.typeId) ? [{ prop, direction: "inverse", typeId: type.id }] : [],
		),
	);
	return [...forward, ...inverse];
}

/** The existing entities `entity` can be linked to through `relation`: of the other type, not linked yet, and
 * (inverse) whose property can take one more. */
export function linkCandidates(entities: readonly Entity[], entity: Entity, relation: Relation): Entity[] {
	const { prop } = relation;
	const linked = referencedIds(prop, entity.values[prop.id]);
	return entities.filter(
		(e) =>
			e.id !== entity.id &&
			e.typeId === relation.typeId &&
			(relation.direction === "forward"
				? !linked.includes(e.id)
				: !referencedIds(prop, e.values[prop.id]).includes(entity.id) && canTakeMore(prop, e.values[prop.id])),
	);
}

/** One label/value row on a canvas card. */
export interface CardRow {
	label: string;
	kind: PropertyKind;
	/** Text, the chosen option, or the names of the referenced entities. */
	values: string[];
	/** For references: the entity ids, in the same order as `values`; empty for other kinds. */
	entityIds: string[];
}

/** The ids of the entities a property value references (empty for other kinds or no value). */
export function referencedIds(prop: PropertyDef, value: PropertyValue | undefined): string[] {
	if (prop.kind !== "reference" || value === null || value === undefined) return [];
	return typeof value === "string" ? [value] : value;
}

/**
 * The rows a card shows, in property order: `list` properties with a value, plus the targets of `line`
 * properties that `isLinked` says can't be drawn as a line (their card isn't on the board).
 */
export function cardRows(
	type: EntityType,
	entity: Entity,
	entityNames: ReadonlyMap<string, string>,
	isLinked: (entityId: string) => boolean = () => false,
): CardRow[] {
	return type.properties.flatMap((prop) => {
		const value = entity.values[prop.id];
		const display = effectiveCardDisplay(prop);
		if (display === "hidden" || value === null || value === undefined) return [];
		let raw = typeof value === "string" ? [value] : value;
		if (display === "line") raw = raw.filter((id) => !isLinked(id));
		const entityIds = prop.kind === "reference" ? raw.filter((id) => entityNames.has(id)) : [];
		const values = prop.kind === "reference" ? entityIds.map((id) => entityNames.get(id)!) : raw;
		if (values.length === 0) return [];
		return [{ label: prop.name, kind: prop.kind, values, entityIds }];
	});
}

/** Entities pointing at `entity` through one reference property that has an inverse label. */
export interface InverseReference {
	label: string;
	/** The property doing the referencing, on `sourceTypeId`. */
	prop: PropertyDef;
	sourceTypeId: string;
	/** The referencing entities, in entity order. */
	entityIds: string[];
}

/** Reference properties (of any type) that target `targetTypeId` and have an inverse label, in type and property order. */
export function inverseRelations(
	types: readonly EntityType[],
	targetTypeId: string,
): Omit<InverseReference, "entityIds">[] {
	return types.flatMap((sourceType) =>
		sourceType.properties.flatMap((prop) => {
			const label = prop.reference?.inverseLabel.trim() ?? "";
			if (prop.kind !== "reference" || label === "" || !prop.reference?.typeIds.includes(targetTypeId)) return [];
			return [{ label, prop, sourceTypeId: sourceType.id }];
		}),
	);
}

/**
 * The reverse side of references: for each inverse relation targeting `entity`'s type, the entities whose value
 * includes `entity` (relations without any are left out). Computed from the stored references, never stored itself.
 */
export function inverseReferences(data: EntityData, entity: Entity): InverseReference[] {
	return inverseRelations(data.types, entity.typeId).flatMap((relation) => {
		const entityIds = data.entities
			.filter(
				(e) =>
					e.typeId === relation.sourceTypeId && referencedIds(relation.prop, e.values[relation.prop.id]).includes(entity.id),
			)
			.map((e) => e.id);
		return entityIds.length > 0 ? [{ ...relation, entityIds }] : [];
	});
}

/**
 * Card rows for the reverse side of references. Like forward `line` references, entities already connected to
 * this card by a line (`isLinked` says their card is on the board) are left out.
 */
export function inverseCardRows(
	data: EntityData,
	entity: Entity,
	entityNames: ReadonlyMap<string, string>,
	isLinked: (entityId: string) => boolean = () => false,
): CardRow[] {
	return inverseReferences(data, entity).flatMap(({ label, prop, entityIds }) => {
		const shown = entityIds.filter(
			(id) => entityNames.has(id) && !(effectiveCardDisplay(prop) === "line" && isLinked(id)),
		);
		if (shown.length === 0) return [];
		return [
			{
				label,
				kind: "reference" as const,
				values: shown.map((id) => entityNames.get(id)!),
				entityIds: shown,
			},
		];
	});
}

/**
 * Every property of `entity` for the details panel, in property order and including empty ones (`values` is
 * then empty), followed by the reverse side of references to it. Unlike cardRows, card display settings don't apply.
 */
export function detailRows(
	data: EntityData,
	entity: Entity,
	entityNames: ReadonlyMap<string, string>,
): CardRow[] {
	const type = data.types.find((t) => t.id === entity.typeId);
	const own = (type?.properties ?? []).map((prop) => propertyRow(prop, entity, entityNames));
	return [...own, ...inverseCardRows(data, entity, entityNames)];
}

/** One property of `entity` as a row, `values` empty when it has none; card display settings don't apply. */
export function propertyRow(prop: PropertyDef, entity: Entity, entityNames: ReadonlyMap<string, string>): CardRow {
	const value = entity.values[prop.id];
	const raw = value === null || value === undefined ? [] : typeof value === "string" ? [value] : value;
	const entityIds = prop.kind === "reference" ? raw.filter((id) => entityNames.has(id)) : [];
	return {
		label: prop.name,
		kind: prop.kind,
		values: prop.kind === "reference" ? entityIds.map((id) => entityNames.get(id)!) : raw,
		entityIds,
	};
}

/** `{{Property name}}` in a description: stands for the entity's value of that property. */
const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/** The type's own property a placeholder names (ignoring case and surrounding spaces). */
export function placeholderProperty(type: Pick<EntityType, "properties"> | undefined, name: string): PropertyDef | undefined {
	const key = name.trim().toLocaleLowerCase();
	return type?.properties.find((p) => p.name.trim().toLocaleLowerCase() === key);
}

/** `source` with each placeholder that names a property replaced by `value(prop)`; others stay as typed. */
export function fillPlaceholders(
	source: string,
	type: Pick<EntityType, "properties"> | undefined,
	value: (prop: PropertyDef) => string,
): string {
	return source.replace(PLACEHOLDER, (whole, name: string) => {
		const prop = placeholderProperty(type, name);
		return prop ? value(prop) : whole;
	});
}

/** Lower case without accents, so "uber" matches "Über". */
function searchKey(value: string): string {
	return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

/** Entities whose name contains `query` (ignoring case and accents), optionally only of one type or with one tag
 * (ignoring case). */
export function filterEntities<T extends Pick<Entity, "name" | "typeId" | "tags">>(
	entities: readonly T[],
	{ query, typeId, tag = null }: { query: string; typeId: string | null; tag?: string | null },
): T[] {
	const key = searchKey(query.trim());
	const tagKey = tag?.toLocaleLowerCase();
	return entities.filter(
		(e) =>
			(typeId === null || e.typeId === typeId) &&
			(tagKey === undefined || e.tags.some((t) => t.toLocaleLowerCase() === tagKey)) &&
			searchKey(e.name).includes(key),
	);
}

/** The tags in use, sorted; spelled as where they first appear (tags differing only in case count as one). */
export function entityTags(entities: readonly Pick<Entity, "tags">[]): string[] {
	return parseTags(entities.flatMap((e) => e.tags).join(",")).sort((a, b) => a.localeCompare(b));
}

/** Maps each entity id to its type id, so reference values can be checked. */
export function entityTypeMap(data: EntityData): Map<string, string> {
	return new Map(data.entities.map((e) => [e.id, e.typeId]));
}

/**
 * Turns form input or a stored value into a valid value for the property; empty or invalid input becomes null.
 * References keep only ids of existing entities of the target types (per `entityTypes`, entity id → type id).
 */
export function parseValue(
	prop: Pick<PropertyDef, "kind" | "options" | "reference">,
	raw: string | readonly string[],
	entityTypes: ReadonlyMap<string, string> = new Map(),
): PropertyValue {
	if (prop.kind === "reference") {
		const targets = prop.reference?.typeIds ?? [];
		const ids = [...new Set(typeof raw === "string" ? [raw] : raw)].filter((id) =>
			targets.includes(entityTypes.get(id) ?? ""),
		);
		if (prop.reference?.multiple) return ids.length > 0 ? ids : null;
		return ids[0] ?? null;
	}
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	if (prop.kind === "options") return prop.options.includes(trimmed) ? trimmed : null;
	return trimmed;
}

/** A problem with a type definition; the UI turns it into a message in the current language. */
export type ValidationError =
	| { code: "typeNameRequired" }
	| { code: "propertyNameRequired" }
	| { code: "reservedName" | "duplicateName"; label: string }
	| { code: "optionsRequired" | "emptyOption" | "duplicateOptions"; label: string }
	| { code: "referenceTypeRequired"; label: string };

/** Returns a list of problems; an empty list means the type is valid. */
export function validateType(
	name: string,
	properties: Omit<DraftProperty, "id">[],
	typeIds: ReadonlySet<string>,
): ValidationError[] {
	const errors: ValidationError[] = [];
	if (name.trim() === "") errors.push({ code: "typeNameRequired" });
	const seen = new Set<string>();
	for (const prop of properties) {
		const label = prop.name.trim();
		const key = label.toLowerCase();
		if (key === "") {
			errors.push({ code: "propertyNameRequired" });
		} else if (RESERVED_PROPERTY_NAMES.includes(key)) {
			errors.push({ code: "reservedName", label });
		} else if (seen.has(key)) {
			errors.push({ code: "duplicateName", label });
		}
		seen.add(key);

		if (prop.kind === "options") {
			const options = prop.options.map((o) => o.trim());
			if (options.length === 0) errors.push({ code: "optionsRequired", label });
			if (options.some((o) => o === "")) errors.push({ code: "emptyOption", label });
			if (new Set(options).size !== options.length) errors.push({ code: "duplicateOptions", label });
		}
		const targets = prop.reference?.typeIds ?? [];
		if (prop.kind === "reference" && (targets.length === 0 || !targets.every((id) => typeIds.has(id)))) {
			errors.push({ code: "referenceTypeRequired", label });
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

// How an entity looks as a card: on the boards, and in the previews elsewhere.

/** A card's size until the editor has measured what it shows (see CanvasCard). */
export const DEFAULT_CARD_SIZE = { width: 240, height: 168 } as const;

/** How narrow and how wide a card gets: short contents make it narrower, longer ones wrap at the widest (about 50
 * characters a line, easy to read). */
export const CARD_WIDTH = { min: 168, max: 384 } as const;

/** Spacing of the board's grid, in world units: cards are placed and sized on it. */
export const GRID_SIZE = 24;

/** The nearest grid line to `value`. */
export function snapToGrid(value: number): number {
	return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

/** Entity names, made unique within each type: the second "Dune" is "Dune (2)", and so on. */
export function uniqueNames(entities: readonly Entity[]): Map<string, string> {
	const seen = new Map<string, number>();
	return new Map(
		entities.map((e) => {
			const key = `${e.typeId}\u0000${e.name}`;
			const count = (seen.get(key) ?? 0) + 1;
			seen.set(key, count);
			return [e.id, count === 1 ? e.name : `${e.name} (${count})`];
		}),
	);
}
