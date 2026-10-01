import { isUlid, ulid } from "./ulid.js";
import type { Point } from "./connectors.js";
import { clampZoom, defaultViewport, type Viewport } from "./viewport.js";
import {
	DEFAULT_CARD_SIZE,
	MIN_CARD_SIZE,
	CARD_DISPLAYS,
	LINE_ARROWS,
	PROPERTY_KINDS,
	effectiveCardDisplay,
	entityTypeMap,
	migrateValues,
	nextTypeColor,
	type AppData,
	TEXT_SIZES,
	type Board,
	type BoxDrawing,
	type CanvasCard,
	type Drawing,
	type NewDrawing,
	type PathDrawing,
	type TextSize,
	type DraftProperty,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyValue,
} from "./model.js";

export type Store = ReturnType<typeof createStore>;

function newBoard(name: string): Board {
	return { id: crypto.randomUUID(), name, cards: [], viewport: defaultViewport(), drawings: [] };
}

function emptyData(): AppData {
	return { types: [], entities: [], boards: [newBoard("Board 1")] };
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isPoint = (p: unknown): p is Point => isNumber((p as Point | null)?.x) && isNumber((p as Point | null)?.y);

/** A well-formed drawing, or null. Boards saved before drawings existed have none. */
function normalizeDrawing(raw: unknown): Drawing | null {
	const d = raw as Partial<BoxDrawing> & Partial<Omit<PathDrawing, "kind">> & { kind?: unknown };
	if (typeof d?.id !== "string" || typeof d.color !== "string") return null;
	if (d.kind === "rect" || d.kind === "ellipse" || d.kind === "text") {
		if (![d.x, d.y, d.width, d.height].every(isNumber)) return null;
		return {
			id: d.id,
			kind: d.kind,
			x: d.x!,
			y: d.y!,
			width: d.width!,
			height: d.height!,
			color: d.color,
			text: typeof d.text === "string" ? d.text : "",
			textSize: TEXT_SIZES.includes(d.textSize as TextSize) ? (d.textSize as TextSize) : "m",
		};
	}
	if (d.kind === "line" || d.kind === "arrow" || d.kind === "pen") {
		const points = Array.isArray(d.points) ? d.points.filter(isPoint).map((p) => ({ x: p.x, y: p.y })) : [];
		if (points.length < 2 || (d.kind !== "pen" && points.length !== 2)) return null;
		return { id: d.id, kind: d.kind, points, color: d.color };
	}
	return null;
}

/** Keeps only well-formed cards and viewport; anything else falls back to defaults. Cards and boards saved without an id get one. */
function normalizeBoard(board: Partial<Board> | undefined, fallbackName: string): Board {
	const cards = Array.isArray(board?.cards)
		? board.cards
				.filter(
					(c: Partial<CanvasCard>) =>
						typeof c.entityId === "string" && isNumber(c.x) && isNumber(c.y) && isNumber(c.width) && isNumber(c.height),
				)
				.map((c: CanvasCard) => ({ ...c, id: typeof c.id === "string" ? c.id : crypto.randomUUID() }))
		: [];
	const v = board?.viewport;
	const viewport = v && isNumber(v.x) && isNumber(v.y) && isNumber(v.zoom) ? { ...v, zoom: clampZoom(v.zoom) } : defaultViewport();
	return {
		id: typeof board?.id === "string" ? board.id : crypto.randomUUID(),
		name: typeof board?.name === "string" && board.name.trim() !== "" ? board.name : fallbackName,
		cards,
		viewport,
		drawings: Array.isArray(board?.drawings) ? board.drawings.flatMap((d) => normalizeDrawing(d) ?? []) : [],
	};
}

/** Reads the boards, including the single `canvas` saved by the version before boards existed. */
function normalizeBoards(data: AppData & { canvas?: Partial<Board> }): Board[] {
	const raw: Partial<Board>[] = Array.isArray(data.boards) ? data.boards : data.canvas ? [data.canvas] : [];
	const boards = raw.map((b, i) => normalizeBoard(b, `Board ${i + 1}`));
	return boards.length > 0 ? boards : [newBoard("Board 1")];
}

/** Re-validates every entity's values against its type's current properties, e.g. dropping references to deleted entities. */
function reconcile(data: AppData): AppData {
	const entityTypes = entityTypeMap(data);
	const typesById = new Map(data.types.map((t) => [t.id, t]));
	return {
		...data,
		entities: data.entities.map((e) => ({
			...e,
			values: migrateValues(e.values, typesById.get(e.typeId)?.properties ?? [], entityTypes),
		})),
		boards: data.boards.map((b) => ({ ...b, cards: b.cards.filter((c) => entityTypes.has(c.entityId)) })),
	};
}

/** Fills in fields that data saved by earlier versions may lack (e.g. number/boolean/date kinds, non-string values, entity names, ULIDs). */
/** Reads `cardDisplay`, or converts the `showOnCard` checkbox saved by the previous version. */
function cardDisplayFor(prop: PropertyDef, showOnCard: unknown): PropertyDef["cardDisplay"] {
	if (CARD_DISPLAYS.includes(prop.cardDisplay)) return effectiveCardDisplay(prop);
	return showOnCard === false ? "hidden" : "list";
}

const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether `value` has the shape of saved data (types and entities lists), so loading can make use of it. */
export function looksLikeAppData(value: unknown): value is Record<string, unknown> & Pick<AppData, "types" | "entities"> {
	return isObject(value) && Array.isArray(value.types) && Array.isArray(value.entities);
}

/**
 * Drops types and properties without a string id and name, and entities without a type id, one by one, so a
 * single malformed item never costs the rest. Missing property lists and values become empty.
 */
function keepWellFormed(data: AppData): AppData {
	return {
		...data,
		types: data.types.flatMap((type: unknown) => {
			if (!isObject(type) || typeof type.id !== "string" || typeof type.name !== "string") return [];
			const properties = Array.isArray(type.properties)
				? type.properties.filter((p: unknown) => isObject(p) && typeof p.id === "string" && typeof p.name === "string")
				: [];
			return [{ ...(type as unknown as EntityType), properties }];
		}),
		entities: data.entities.flatMap((entity: unknown) => {
			if (!isObject(entity) || typeof entity.typeId !== "string") return [];
			return [{ ...(entity as unknown as Entity), values: isObject(entity.values) ? (entity.values as Entity["values"]) : {} }];
		}),
	};
}

/** Types, their properties and entities: if loading leaves fewer than were saved, some saved data was dropped. */
function itemCount(data: AppData): number {
	const properties = data.types.reduce((n, t) => n + (Array.isArray(t?.properties) ? t.properties.length : 0), 0);
	return data.types.length + properties + data.entities.length;
}

/** What went wrong reading the saved data; the UI shows it as a warning. */
export type LoadProblem =
	/** Nothing (`unreadable`) or not everything could be read; the saved text was copied to `backupKey` first. */
	| { code: "unreadable" | "partlyUnreadable"; backupKey: string }
	/** Not everything could be read, and the saved text couldn't be copied aside: saving is paused to keep it. */
	| { code: "notBackedUp" };

function normalize(data: AppData): AppData {
	// Types saved before colors existed get the next free palette colors, in order.
	const usedColors = data.types.map((t) => t.color).filter(isColor);
	const colorFor = (color: unknown) => {
		if (isColor(color)) return color;
		const next = nextTypeColor(usedColors);
		usedColors.push(next);
		return next;
	};
	return {
		boards: normalizeBoards(data),
		types: data.types.map((type) => ({
			...type,
			color: colorFor(type.color),
			contentTemplate: typeof type.contentTemplate === "string" ? type.contentTemplate : "",
			properties: type.properties.map(({ showOnCard, ...prop }: PropertyDef & { showOnCard?: unknown }) => ({
				...prop,
				kind: PROPERTY_KINDS.includes(prop.kind) ? prop.kind : "text",
				options: Array.isArray(prop.options) ? prop.options : [],
				reference: prop.reference
					? {
							...prop.reference,
							arrow: LINE_ARROWS.includes(prop.reference.arrow) ? prop.reference.arrow : "to",
							lineLabel: typeof prop.reference.lineLabel === "string" ? prop.reference.lineLabel : "",
							inverseLabel: typeof prop.reference.inverseLabel === "string" ? prop.reference.inverseLabel : "",
						}
					: null,
				cardDisplay: cardDisplayFor(prop, showOnCard),
			})),
		})),
		entities: data.entities.map((entity) => {
			const values = Object.fromEntries(
				Object.entries(entity.values).map(([key, value]): [string, PropertyValue] => [
					key,
					value === null || value === undefined ? null : Array.isArray(value) ? value.map(String) : String(value),
				]),
			);
			const propIds = data.types.find((t) => t.id === entity.typeId)?.properties.map((p) => p.id) ?? [];
			const name =
				typeof entity.name === "string"
					? entity.name
					: (propIds.map((id) => values[id]).find((v) => typeof v === "string") ?? "Untitled");
			const content = typeof entity.content === "string" ? entity.content : "";
			const description = typeof entity.description === "string" ? entity.description : "";
			return { ...entity, id: isUlid(entity.id) ? entity.id : ulid(), name, content, description, values };
		}),
	};
}

function toPropertyDefs(properties: DraftProperty[]): PropertyDef[] {
	return properties.map((p) => ({
		id: p.id ?? crypto.randomUUID(),
		name: p.name.trim(),
		kind: p.kind,
		options: p.kind === "options" ? p.options.map((o) => o.trim()) : [],
		reference:
			p.kind === "reference" && p.reference
				? { ...p.reference, lineLabel: p.reference.lineLabel.trim(), inverseLabel: p.reference.inverseLabel.trim() }
				: null,
		cardDisplay: effectiveCardDisplay(p),
	}));
}

export function createStore(storage: Pick<Storage, "getItem" | "setItem">, key = "entities-app") {
	let { data, problem: loadProblem } = load();
	let saveFailed = false;
	const problemListeners: (() => void)[] = [];

	function load(): { data: AppData; problem: LoadProblem | null } {
		let raw: string | null;
		try {
			raw = storage.getItem(key);
		} catch {
			// Storage blocked: nothing to protect; failed saves are reported.
			return { data: emptyData(), problem: null };
		}
		if (raw === null) return { data: emptyData(), problem: null };
		try {
			const parsed: unknown = JSON.parse(raw);
			if (looksLikeAppData(parsed)) {
				const kept = keepWellFormed(parsed as unknown as AppData);
				const loaded = reconcile(normalize(kept));
				const complete = itemCount(kept) === itemCount(parsed as unknown as AppData);
				return { data: loaded, problem: complete ? null : backUp(raw, "partlyUnreadable") };
			}
		} catch {
			// Not JSON, or too broken to load at all: start fresh.
		}
		return { data: emptyData(), problem: backUp(raw, "unreadable") };
	}

	/** Copies the saved text aside before a save can overwrite it. */
	function backUp(raw: string, code: "unreadable" | "partlyUnreadable"): LoadProblem {
		const backupKey = `${key}:backup:${new Date().toISOString()}`;
		try {
			storage.setItem(backupKey, raw);
			return { code, backupKey };
		} catch {
			return { code: "notBackedUp" };
		}
	}

	function save(): void {
		if (loadProblem?.code === "notBackedUp") return; // keep the saved original until it's backed up
		let failed = false;
		try {
			storage.setItem(key, JSON.stringify(data));
		} catch {
			// Storage full or blocked: keep working in memory, and say so.
			failed = true;
		}
		if (failed !== saveFailed) {
			saveFailed = failed;
			for (const listener of problemListeners) listener();
		}
	}

	function updateBoard(boardId: string, fn: (board: Board) => Board): void {
		data = { ...data, boards: data.boards.map((b) => (b.id === boardId ? fn(b) : b)) };
		save();
	}

	/** Applies fn to the board holding the drawing. */
	function updateDrawingBoard(drawingId: string, fn: (board: Board) => Board): void {
		const board = data.boards.find((b) => b.drawings.some((d) => d.id === drawingId));
		if (board) updateBoard(board.id, fn);
	}

	/** Applies fn to the board holding the card (card ids are unique across boards). */
	function updateCardBoard(cardId: string, fn: (board: Board, card: CanvasCard) => Board): void {
		for (const board of data.boards) {
			const card = board.cards.find((c) => c.id === cardId);
			if (card) return updateBoard(board.id, (b) => fn(b, card));
		}
	}

	return {
		get data(): AppData {
			return data;
		},

		/** Problems reading the saved data, and whether the last save failed (changes are then only in memory). */
		get problems(): { load: LoadProblem | null; saveFailed: boolean } {
			return { load: loadProblem, saveFailed };
		},

		/** The saved text that couldn't be read in full (from its backup, or still under the store's own key); else null. */
		originalText(): string | null {
			if (!loadProblem) return null;
			try {
				return storage.getItem("backupKey" in loadProblem ? loadProblem.backupKey : key);
			} catch {
				return null;
			}
		},

		/** Calls `listener` whenever `problems.saveFailed` changes. */
		onProblemsChange(listener: () => void): void {
			problemListeners.push(listener);
		},

		/** Without a color, the type gets the first palette color no other type uses. */
		addType(
			name: string,
			properties: DraftProperty[],
			contentTemplate: string,
			color = nextTypeColor(data.types.map((t) => t.color)),
		): EntityType {
			const type: EntityType = {
				id: crypto.randomUUID(),
				name: name.trim(),
				properties: toPropertyDefs(properties),
				contentTemplate,
				color,
			};
			data = { ...data, types: [...data.types, type] };
			save();
			return type;
		},

		/** Existing entities keep their content when the template changes. Without a color, the type keeps its own. */
		updateType(typeId: string, name: string, properties: DraftProperty[], contentTemplate: string, color?: string): void {
			const current = data.types.find((t) => t.id === typeId);
			const updated: EntityType = {
				id: typeId,
				name: name.trim(),
				properties: toPropertyDefs(properties),
				contentTemplate,
				color: color ?? current?.color ?? nextTypeColor(data.types.map((t) => t.color)),
			};
			data = reconcile({ ...data, types: data.types.map((t) => (t.id === typeId ? updated : t)) });
			save();
		},

		deleteType(typeId: string): void {
			data = reconcile({
				...data,
				types: data.types.filter((t) => t.id !== typeId),
				entities: data.entities.filter((e) => e.typeId !== typeId),
			});
			save();
		},

		addEntity(
			typeId: string,
			name: string,
			content: string,
			values: Record<string, PropertyValue>,
			description = "",
		): Entity {
			const entity: Entity = { id: ulid(), typeId, name: name.trim(), content, description, values };
			data = { ...data, entities: [...data.entities, entity] };
			save();
			return entity;
		},

		/** Without a description, the entity keeps its current one. */
		updateEntity(
			entityId: string,
			name: string,
			content: string,
			values: Record<string, PropertyValue>,
			description?: string,
		): void {
			data = {
				...data,
				entities: data.entities.map((e) =>
					e.id === entityId ? { ...e, name: name.trim(), content, description: description ?? e.description, values } : e,
				),
			};
			save();
		},

		deleteEntity(entityId: string): void {
			data = reconcile({ ...data, entities: data.entities.filter((e) => e.id !== entityId) });
			save();
		},

		addBoard(name: string): Board {
			const board = newBoard(name.trim() || `Board ${data.boards.length + 1}`);
			data = { ...data, boards: [...data.boards, board] };
			save();
			return board;
		},

		renameBoard(boardId: string, name: string): void {
			if (name.trim() === "") return;
			updateBoard(boardId, (b) => ({ ...b, name: name.trim() }));
		},

		/** Deletes a board and its cards (never the entities). The last board can't be deleted. */
		deleteBoard(boardId: string): void {
			if (data.boards.length <= 1) return;
			data = { ...data, boards: data.boards.filter((b) => b.id !== boardId) };
			save();
		},

		/** Adds a new card for the entity at (x, y), on top of the board's other cards. */
		addCard(boardId: string, entityId: string, x: number, y: number): CanvasCard {
			const card: CanvasCard = { id: crypto.randomUUID(), entityId, x, y, ...DEFAULT_CARD_SIZE };
			updateBoard(boardId, (b) => ({ ...b, cards: [...b.cards, card] }));
			return card;
		},

		/** Moves a card to (x, y) and brings it to the front. */
		moveCard(cardId: string, x: number, y: number): void {
			updateCardBoard(cardId, (b, card) => ({
				...b,
				cards: [...b.cards.filter((c) => c.id !== cardId), { ...card, x, y }],
			}));
		},

		resizeCard(cardId: string, width: number, height: number): void {
			const size = { width: Math.max(MIN_CARD_SIZE.width, width), height: Math.max(MIN_CARD_SIZE.height, height) };
			updateCardBoard(cardId, (b) => ({ ...b, cards: b.cards.map((c) => (c.id === cardId ? { ...c, ...size } : c)) }));
		},

		/** Takes the card off its board; the entity itself stays. */
		removeCard(cardId: string): void {
			updateCardBoard(cardId, (b) => ({ ...b, cards: b.cards.filter((c) => c.id !== cardId) }));
		},

		addDrawing(boardId: string, drawing: NewDrawing): Drawing {
			const added = { ...drawing, id: crypto.randomUUID() } as Drawing;
			updateBoard(boardId, (b) => ({ ...b, drawings: [...b.drawings, added] }));
			return added;
		},

		/** Replaces the drawing with the same id (on whichever board it is). */
		replaceDrawing(drawing: Drawing): void {
			updateDrawingBoard(drawing.id, (b) => ({ ...b, drawings: b.drawings.map((d) => (d.id === drawing.id ? drawing : d)) }));
		},

		removeDrawing(drawingId: string): void {
			updateDrawingBoard(drawingId, (b) => ({ ...b, drawings: b.drawings.filter((d) => d.id !== drawingId) }));
		},

		setViewport(boardId: string, viewport: Viewport): void {
			updateBoard(boardId, (b) => ({ ...b, viewport: { ...viewport, zoom: clampZoom(viewport.zoom) } }));
		},

		/** How many property values (across all entities) point to this entity. */
		referencesTo(entityId: string): number {
			let count = 0;
			for (const entity of data.entities) {
				for (const value of Object.values(entity.values)) {
					if (value === entityId || (Array.isArray(value) && value.includes(entityId))) count++;
				}
			}
			return count;
		},

		/** "Type.property" names of other types' reference properties that point to this type. */
		typeReferrers(typeId: string): string[] {
			return data.types
				.filter((t) => t.id !== typeId)
				.flatMap((t) =>
					t.properties.filter((p) => p.reference?.typeId === typeId).map((p) => `${t.name}.${p.name}`),
				);
		},
	};
}
