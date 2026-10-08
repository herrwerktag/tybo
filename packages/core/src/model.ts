import type { Point } from "./connectors.js";
import { screenToWorld, type Viewport } from "./viewport.js";

export type PropertyKind = "text" | "options" | "reference";

export const PROPERTY_KINDS: readonly PropertyKind[] = ["text", "options", "reference"];

export interface ReferenceDef {
	/** The entity types whose entities can be picked (e.g. both Event and State can trigger an Activity). */
	typeIds: string[];
	/** Whether several entities can be picked instead of one. */
	multiple: boolean;
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
	return { typeIds, multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" };
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

/** Colors for drawings: the type colors plus dark grey (for strong lines and text). */
export const DRAWING_COLORS: readonly { name: string; value: string }[] = [
	...TYPE_COLORS,
	{ name: "Dark", value: "#4a4a4a" },
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

/**
 * One step of a board in story mode: which of the board's cards and drawings it shows (they keep one position on all
 * pages), with its own pan/zoom and a description placed over the canvas.
 */
export interface StoryPage {
	id: string;
	/** The step name. */
	name: string;
	/** Markdown; empty means none is shown. */
	description: string;
	/** The description's top left corner in world coordinates: it sits on the canvas like a card. */
	descriptionPosition: Point;
	/** The description box's size in world units, the same in the editor and the viewer. */
	descriptionSize: { width: number; height: number };
	viewport: Viewport;
	cardIds: string[];
	drawingIds: string[];
	/** Cards the page shows faded, out of focus: some of its `cardIds`. */
	dimmedCardIds: string[];
}

/** Where a page's description goes unless it was moved: this far (screen px) from the top left of the page's
 * view, clear of the drawing tools. */
export const DESCRIPTION_OFFSET: Point = { x: 72, y: 16 };

export const DEFAULT_DESCRIPTION_SIZE = { width: 384, height: 120 } as const;
export const MIN_DESCRIPTION_SIZE = { width: 160, height: 48 } as const;

/** The grid point nearest to where a description is at DESCRIPTION_OFFSET in `viewport`: in view, top left. */
export function descriptionInView(viewport: Viewport): Point {
	const { x, y } = screenToWorld(viewport, DESCRIPTION_OFFSET.x, DESCRIPTION_OFFSET.y);
	return { x: snapToGrid(x), y: snapToGrid(y) };
}

/** A named canvas with its own cards and pan/zoom. In story mode, it is shown step by step, like a presentation. */
export interface Board {
	id: string;
	name: string;
	/** Later cards are drawn on top. */
	cards: CanvasCard[];
	/** The pan/zoom of the board; in story mode, its pages have their own. */
	viewport: Viewport;
	/** Shapes, lines, text and pen strokes, drawn behind the cards; later ones on top. */
	drawings: Drawing[];
	/** Whether the board is shown step by step (its pages); off, it shows everything at once. */
	story: boolean;
	/** The steps of story mode, in order: never empty while it's on, and kept while it's off. */
	pages: StoryPage[];
}

export type TextSize = "s" | "m" | "l";
export const TEXT_SIZES: readonly TextSize[] = ["s", "m", "l"];

/** A rectangle, ellipse or free text box; all can hold text. */
export interface BoxDrawing {
	id: string;
	kind: "rect" | "ellipse" | "text";
	x: number;
	y: number;
	width: number;
	height: number;
	/** A value from DRAWING_COLORS. */
	color: string;
	text: string;
	textSize: TextSize;
}

/** How a pen stroke looks: a thin fine liner, the regular pen, or a wide, see-through highlighter (flat or round tip). */
export type PenStyle = "fineliner" | "pen" | "highlighter" | "roundHighlighter";
export const PEN_STYLES: readonly PenStyle[] = ["fineliner", "pen", "highlighter", "roundHighlighter"];

/** A line or arrow (two points) or a freehand pen stroke. */
export interface PathDrawing {
	id: string;
	kind: "line" | "arrow" | "pen";
	points: Point[];
	/** A value from DRAWING_COLORS. */
	color: string;
	/** Pen strokes only. */
	penStyle?: PenStyle;
}

/** A picture pasted or dropped onto the board; it keeps its aspect ratio when resized. */
export interface ImageDrawing {
	id: string;
	kind: "image";
	x: number;
	y: number;
	width: number;
	height: number;
	/** The picture itself, as a data URL (`data:image/…`). */
	src: string;
}

/**
 * A drawing from the library placed on a board. It holds no copy: it always shows the library drawing as it is now,
 * fitted into its box (keeping its aspect ratio), so changing the library drawing changes every place it's used.
 */
export interface SymbolDrawing {
	id: string;
	kind: "symbol";
	/** The LibraryDrawing shown. */
	libraryId: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export type Drawing = BoxDrawing | PathDrawing | ImageDrawing | SymbolDrawing;

/** Rectangles, ellipses and text boxes (as opposed to lines, arrows, pen strokes, images and library drawings). */
export function isBox(drawing: Drawing): drawing is BoxDrawing {
	return drawing.kind === "rect" || drawing.kind === "ellipse" || drawing.kind === "text";
}

export function isImage(drawing: Drawing): drawing is ImageDrawing {
	return drawing.kind === "image";
}

export function isSymbol(drawing: Drawing): drawing is SymbolDrawing {
	return drawing.kind === "symbol";
}

/** Drawings with a position and size: boxes, images and library drawings (as opposed to lines, arrows and pen strokes). */
export function hasRect(drawing: Drawing): drawing is BoxDrawing | ImageDrawing | SymbolDrawing {
	return isBox(drawing) || isImage(drawing) || isSymbol(drawing);
}

export type NewDrawing =
	| Omit<BoxDrawing, "id">
	| Omit<PathDrawing, "id">
	| Omit<ImageDrawing, "id">
	| Omit<SymbolDrawing, "id">;

/**
 * A named drawing of its own, kept in the workspace's library and placed on boards from there (as SymbolDrawings).
 * It's made of the same shapes, lines, text, pen strokes and images as a board's drawings — never of other library
 * drawings, so one can't end up containing itself.
 */
export interface LibraryDrawing {
	id: string;
	name: string;
	/** For finding it in the library; trimmed, without duplicates. */
	tags: string[];
	/** Later ones on top; their coordinates are the drawing's own (only their bounds matter where it's placed). */
	drawings: Drawing[];
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

export const DEFAULT_CARD_SIZE = { width: 240, height: 168 } as const;
export const MIN_CARD_SIZE = { width: 160, height: 80 } as const;

/** Spacing of the board's grid, in world units: cards are placed and sized on it. */
export const GRID_SIZE = 24;

/** The nearest grid line to `value`. */
export function snapToGrid(value: number): number {
	return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

export interface AppData {
	types: EntityType[];
	entities: Entity[];
	/** Never empty. */
	boards: Board[];
	/** Drawings to place on boards, in the order they were made. */
	library: LibraryDrawing[];
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
export function inverseReferences(data: Pick<AppData, "types" | "entities">, entity: Entity): InverseReference[] {
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
	data: Pick<AppData, "types" | "entities">,
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
	data: Pick<AppData, "types" | "entities">,
	entity: Entity,
	entityNames: ReadonlyMap<string, string>,
): CardRow[] {
	const type = data.types.find((t) => t.id === entity.typeId);
	const own = (type?.properties ?? []).map((prop): CardRow => {
		const value = entity.values[prop.id];
		const raw = value === null || value === undefined ? [] : typeof value === "string" ? [value] : value;
		const entityIds = prop.kind === "reference" ? raw.filter((id) => entityNames.has(id)) : [];
		return {
			label: prop.name,
			kind: prop.kind,
			values: prop.kind === "reference" ? entityIds.map((id) => entityNames.get(id)!) : raw,
			entityIds,
		};
	});
	return [...own, ...inverseCardRows(data, entity, entityNames)];
}

/** Lower case without accents, so "uber" matches "Über". */
function searchKey(value: string): string {
	return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

/** Entities whose name contains `query` (ignoring case and accents), optionally only of one type. */
export function filterEntities<T extends Pick<Entity, "name" | "typeId">>(
	entities: readonly T[],
	{ query, typeId }: { query: string; typeId: string | null },
): T[] {
	const key = searchKey(query.trim());
	return entities.filter((e) => (typeId === null || e.typeId === typeId) && searchKey(e.name).includes(key));
}

/** Library drawings whose name or one of whose tags contains `query` (ignoring case and accents). */
export function filterLibrary<T extends Pick<LibraryDrawing, "name" | "tags">>(items: readonly T[], query: string): T[] {
	const key = searchKey(query.trim());
	return items.filter((item) => [item.name, ...item.tags].some((value) => searchKey(value).includes(key)));
}

/** Returns a copy of the list with the item at `from` moved to index `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
	const result = [...items];
	const [item] = result.splice(from, 1);
	if (item !== undefined) result.splice(Math.max(0, Math.min(to, result.length)), 0, item);
	return result;
}

/** Maps each entity id to its type id, so reference values can be checked. */
export function entityTypeMap(data: AppData): Map<string, string> {
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
