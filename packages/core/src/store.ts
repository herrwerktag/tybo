import { isUlid, ulid } from "./ulid.js";
import type { Point } from "./connectors.js";
import { changesBetween } from "./changes.js";
import type { DataPort } from "./ports.js";
import { clampZoom, defaultViewport, type Viewport } from "./viewport.js";
import {
	DEFAULT_CARD_SIZE,
	DEFAULT_DESCRIPTION_SIZE,
	MIN_DESCRIPTION_SIZE,
	descriptionInView,
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
	type StoryPage,
} from "./model.js";

export type Store = Awaited<ReturnType<typeof createStore>>;

/** How many changes can be undone. */
const HISTORY_LIMIT = 100;

/** The format of the saved data. When it changes, raise this and add the step from the old version to MIGRATIONS. */
export const DATA_VERSION = 3;

type SavedData = Record<string, unknown>;

/**
 * For each version, the step that turns data saved in it into the next version, run before the data is checked.
 * Version 0 is data saved before versions existed: normalize() still reads all of its older shapes, so its step
 * has nothing to do.
 */
export const MIGRATIONS: Readonly<Record<number, (data: SavedData) => SavedData>> = {
	0: (data) => data,
	// Version 2 adds board kinds and storyboard pages; normalize() makes boards without them whiteboards.
	1: (data) => data,
	// Version 3 turns the board kinds into story mode, which any board can be in: storyboards are boards in it.
	2: (data) => ({
		...data,
		boards: Array.isArray(data.boards)
			? data.boards.map((board: unknown) => {
					if (!isObject(board)) return board;
					const { kind, ...rest } = board;
					return { ...rest, story: typeof board.story === "boolean" ? board.story : kind === "storyboard" };
				})
			: data.boards,
	}),
};

/** The version saved data says it's in; data without a (valid) version is from before versions existed. */
function savedVersion(data: SavedData): number {
	return Number.isInteger(data.version) && (data.version as number) >= 0 ? (data.version as number) : 0;
}

/** Brings saved data up to `target`, one step per version from the version it was saved in. */
export function migrate(data: SavedData, steps = MIGRATIONS, target = DATA_VERSION): SavedData {
	let migrated = data;
	for (let version = savedVersion(data); version < target; version++) migrated = steps[version]!(migrated);
	return migrated;
}

/** The data as it's saved and exported: marked with the format version. */
export function toSaved(data: AppData): SavedData {
	return { version: DATA_VERSION, ...data };
}

function newPage(name: string, viewport = defaultViewport()): StoryPage {
	return {
		id: ulid(),
		name,
		description: "",
		descriptionPosition: descriptionInView(viewport),
		descriptionSize: { ...DEFAULT_DESCRIPTION_SIZE },
		viewport,
		cardIds: [],
		drawingIds: [],
		dimmedCardIds: [],
	};
}

function newBoard(name: string): Board {
	return { id: ulid(), name, cards: [], viewport: defaultViewport(), drawings: [], story: false, pages: [] };
}

/** Keeps only the ids of the cards and drawings the board still has. */
function prunePages(board: Board): Board {
	if (board.pages.length === 0) return board;
	const cardIds = new Set(board.cards.map((c) => c.id));
	const drawingIds = new Set(board.drawings.map((d) => d.id));
	return {
		...board,
		pages: board.pages.map((p) => ({
			...p,
			cardIds: p.cardIds.filter((id) => cardIds.has(id)),
			dimmedCardIds: p.dimmedCardIds.filter((id) => cardIds.has(id)),
			drawingIds: p.drawingIds.filter((id) => drawingIds.has(id)),
		})),
	};
}

/** With `pageId`, takes the card or drawing off that page only: it stays on the board (story mode never deletes).
 * Without, off the board, and with it off every page. */
function takeOff(board: Board, list: "cards" | "drawings", id: string, pageId?: string): Board {
	const key = list === "cards" ? "cardIds" : "drawingIds";
	const pages = board.pages.map((p) =>
		pageId === undefined || p.id === pageId
			? { ...p, [key]: p[key].filter((x) => x !== id), dimmedCardIds: p.dimmedCardIds.filter((x) => x !== id) }
			: p,
	);
	if (pageId !== undefined) return { ...board, pages };
	return { ...board, pages, [list]: (board[list] as { id: string }[]).filter((x) => x.id !== id) };
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

function normalizeViewport(v: Partial<Viewport> | null | undefined): Viewport {
	return v && isNumber(v.x) && isNumber(v.y) && isNumber(v.zoom) ? { x: v.x, y: v.y, zoom: clampZoom(v.zoom) } : defaultViewport();
}


/** A well-formed page, or null; its ids only name the board's own cards and drawings. */
function normalizePage(raw: unknown, cardIds: ReadonlySet<string>, drawingIds: ReadonlySet<string>, fallbackName: string): StoryPage | null {
	if (!isObject(raw) || typeof raw.id !== "string") return null;
	const ids = (value: unknown, known: ReadonlySet<string>) =>
		Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && known.has(id)))] : [];
	const position = raw.descriptionPosition as Partial<Point> | undefined;
	const viewport = normalizeViewport(raw.viewport as Partial<Viewport> | undefined);
	const size = raw.descriptionSize as { width?: unknown; height?: unknown } | undefined;
	const shown = ids(raw.cardIds, cardIds);
	return {
		id: raw.id,
		name: typeof raw.name === "string" ? raw.name : fallbackName,
		description: typeof raw.description === "string" ? raw.description : "",
		descriptionPosition: isNumber(position?.x) && isNumber(position?.y) ? { x: position.x, y: position.y } : descriptionInView(viewport),
		descriptionSize:
			isNumber(size?.width) && isNumber(size?.height)
				? { width: Math.max(MIN_DESCRIPTION_SIZE.width, size.width), height: Math.max(MIN_DESCRIPTION_SIZE.height, size.height) }
				: { ...DEFAULT_DESCRIPTION_SIZE },
		viewport,
		cardIds: shown,
		drawingIds: ids(raw.drawingIds, drawingIds),
		dimmedCardIds: ids(raw.dimmedCardIds, new Set(shown)),
	};
}

/** Keeps only well-formed cards and viewport; anything else falls back to defaults. Cards and boards saved without an id get one.
 * Boards saved without story mode aren't in it; a board in story mode always has a page. */
function normalizeBoard(board: Partial<Board> | undefined, fallbackName: string): Board {
	const cards = Array.isArray(board?.cards)
		? board.cards
				.filter(
					(c: Partial<CanvasCard>) =>
						typeof c.entityId === "string" && isNumber(c.x) && isNumber(c.y) && isNumber(c.width) && isNumber(c.height),
				)
				.map((c: CanvasCard) => ({ ...c, id: typeof c.id === "string" ? c.id : ulid() }))
		: [];
	const drawings = Array.isArray(board?.drawings) ? board.drawings.flatMap((d) => normalizeDrawing(d) ?? []) : [];
	const cardIds = new Set(cards.map((c) => c.id));
	const drawingIds = new Set(drawings.map((d) => d.id));
	const pages = Array.isArray(board?.pages)
		? board.pages.flatMap((p, i) => normalizePage(p, cardIds, drawingIds, `Step ${i + 1}`) ?? [])
		: [];
	const normalized: Board = {
		id: typeof board?.id === "string" ? board.id : ulid(),
		name: typeof board?.name === "string" && board.name.trim() !== "" ? board.name : fallbackName,
		cards,
		viewport: normalizeViewport(board?.viewport),
		drawings,
		story: board?.story === true,
		pages,
	};
	return normalized.story && pages.length === 0 ? { ...normalized, pages: [newPage("Step 1", { ...normalized.viewport })] } : normalized;
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
		boards: data.boards.map((b) => prunePages({ ...b, cards: b.cards.filter((c) => entityTypes.has(c.entityId)) })),
	};
}

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

/** What went wrong reading the saved data; the UI shows it as a warning. Either way saving is paused, so
 * nothing here can overwrite what is stored. */
export type LoadProblem =
	/** The data couldn't be loaded (the storage didn't answer, or the workspace isn't there): this starts empty. */
	| { code: "unavailable" }
	/** Saved by a newer version of the app: read as far as understood. */
	| { code: "newerVersion" };

/** The units the storage holds, as far as they can be compared with this app's — what change sets are
 * built from. Boards without their lists get empty ones (the storage keeps none of those either). */
function storedStand(data: AppData): AppData {
	const boards = Array.isArray(data.boards) ? data.boards.filter(isObject) : [];
	return {
		types: data.types,
		entities: data.entities,
		boards: boards.map((board) => ({
			...board,
			cards: Array.isArray(board.cards) ? board.cards : [],
			drawings: Array.isArray(board.drawings) ? board.drawings : [],
		})),
	};
}

/** Fills in fields that data saved by earlier versions may lack (e.g. number/boolean/date kinds, non-string values, entity names, ULIDs). */
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

/** Imported data as the app holds it — brought up to this format, checked and completed the way a load
 * does — or null when it isn't app data, or is from a newer version of the app than this one. */
export function prepareImport(raw: unknown): AppData | null {
	if (!looksLikeAppData(raw) || savedVersion(raw) > DATA_VERSION) return null;
	return reconcile(normalize(keepWellFormed(migrate(raw) as unknown as AppData)));
}

function toPropertyDefs(properties: DraftProperty[]): PropertyDef[] {
	return properties.map((p) => ({
		id: p.id ?? ulid(),
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

/** The data of one workspace, kept in memory and saved through `port` as it changes. */
export async function createStore(port: DataPort, workspaceId: string) {
	// Declared before the load below, which already sets the stand it reads: these belong to the store from
	// its very first moment.
	/** The version the workspace's data was last read or saved at, as the storage named it. */
	let seenVersion: string | null = null;
	/** The saves on their way, one after the other; a look for a newer stand waits behind them, so it can't
	 * mistake a stand this store is just about to reach with its own save for someone else's newer one. */
	let savesSettled: Promise<void> = Promise.resolve();
	/** The look for a newer stand that's on its way; a second ask joins it rather than running alongside. */
	let newerLook: Promise<boolean> | null = null;
	let { data, problem: loadProblem, stand: baseline } = await load();
	let saveFailed = false;
	let saveConflict = false;
	const problemListeners: (() => void)[] = [];
	/** Earlier versions of the data for undo (newest last), and undone ones for redo. */
	let undoStack: AppData[] = [];
	let redoStack: AppData[] = [];
	const historyListeners: (() => void)[] = [];
	/** The data as last saved, to tell changes that change nothing. */
	let savedJson = JSON.stringify(toSaved(data));

	async function load(): Promise<{
		data: AppData;
		problem: LoadProblem | null;
		/** The units the storage holds, as they were read — what the next change set is built from. Null when
		 * nothing may be saved over them (see `LoadProblem`). */
		stand: AppData | null;
	}> {
		let loaded: { data: unknown; version: string } | null;
		try {
			loaded = await port.load(workspaceId);
		} catch {
			loaded = null;
		}
		const raw = loaded?.data;
		if (!loaded || !looksLikeAppData(raw)) return { data: emptyData(), problem: { code: "unavailable" }, stand: null };
		seenVersion = loaded.version;
		if (savedVersion(raw) > DATA_VERSION) {
			const understood = reconcile(normalize(keepWellFormed(raw as unknown as AppData)));
			return { data: understood, problem: { code: "newerVersion" }, stand: null };
		}
		const kept = keepWellFormed(migrate(raw) as unknown as AppData);
		return { data: reconcile(normalize(kept)), problem: null, stand: storedStand(kept) };
	}

	function save(): void {
		savedJson = JSON.stringify(toSaved(data));
		// Nothing is saved over data that wasn't read whole (`LoadProblem`). And after a save collided with
		// someone else's, keep this stand in memory until the data is read anew (reload).
		if (loadProblem || saveConflict) return;
		// The save waits its turn before it goes off: it builds on the stand the saves before it left in the
		// storage, so no unit changed in between is asked about twice (a save on its way stays unseen by a diff
		// built too early).
		savesSettled = savesSettled.then(() => persist(data));
	}

	/** Writes the units that differ from the stand the storage was last known to hold — a save that changes
	 * nothing writes nothing at all. That stand is only advanced once the storage has confirmed the write,
	 * so the units of a save that fails go out again with the next one.
	 *
	 * A write that fails flips `problems.saveFailed`. A unit someone else changed in between doesn't refuse
	 * the save — the storage answers its id (`collided`), wrote it anyway (last one wins) — and flips
	 * `problems.saveConflict`: saving pauses until the data is read anew (reload), everything changed stays
	 * in memory, and the problem says what happened.
	 */
	async function persist(stand: AppData): Promise<void> {
		const changes = changesBetween(baseline!, stand);
		if (changes.length === 0) return; // the storage already holds this stand — nothing to write, nothing to say
		let failed = false;
		let conflict = false;
		try {
			const answer = await port.saveChanges(workspaceId, changes);
			baseline = stand;
			seenVersion = answer.version;
			conflict = answer.collided.length > 0;
		} catch {
			failed = true;
		}
		const changed = failed !== saveFailed || conflict !== saveConflict;
		saveFailed = failed;
		saveConflict = conflict;
		if (changed) {
			for (const listener of problemListeners) listener();
		}
	}

	/** Makes `next` the data and saves it; the data before goes onto the undo history. Changes that change nothing are skipped. */
	function change(next: AppData): void {
		if (JSON.stringify(toSaved(next)) === savedJson) return;
		undoStack = [...undoStack.slice(1 - HISTORY_LIMIT), data];
		redoStack = [];
		data = next;
		save();
		for (const listener of historyListeners) listener();
	}

	/** Undo and redo restore everything but pan and zoom (of boards and pages), which stay as they are now. */
	function restore(snapshot: AppData): void {
		const viewports = new Map(data.boards.flatMap((b) => [[b.id, b.viewport] as const, ...b.pages.map((p) => [p.id, p.viewport] as const)]));
		data = {
			...snapshot,
			boards: snapshot.boards.map((b) => ({
				...b,
				viewport: viewports.get(b.id) ?? b.viewport,
				pages: b.pages.map((p) => ({ ...p, viewport: viewports.get(p.id) ?? p.viewport })),
			})),
		};
		save();
		for (const listener of historyListeners) listener();
	}

	const withBoard = (boardId: string, fn: (board: Board) => Board): AppData => ({
		...data,
		boards: data.boards.map((b) => (b.id === boardId ? fn(b) : b)),
	});

	function updateBoard(boardId: string, fn: (board: Board) => Board): void {
		change(withBoard(boardId, fn));
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

		/** Problems reading the saved data, whether the last save failed (changes are then only in memory),
		 * and whether one collided with someone else's save in between (then saving stops until the data is
		 * read anew). */
		get problems(): { load: LoadProblem | null; saveFailed: boolean; saveConflict: boolean } {
			return { load: loadProblem, saveFailed, saveConflict };
		},

		/** Reads the saved data again, e.g. after another tab saved it, so the next save here doesn't overwrite that.
		 * Hereby this stand is current again too: saving, paused after a conflict, is tried once more. */
		async reload(): Promise<void> {
			await savesSettled; // a save on its way lands first, so the read sees it
			({ data, problem: loadProblem, stand: baseline } = await load());
			savedJson = JSON.stringify(toSaved(data));
			saveConflict = false;
			// The history is from before the other tab's changes; undoing it would undo those too.
			undoStack = [];
			redoStack = [];
			for (const listener of historyListeners) listener();
		},

		/** Calls `listener` whenever `problems.saveFailed` or `problems.saveConflict` changes. */
		onProblemsChange(listener: () => void): void {
			problemListeners.push(listener);
		},

		/** Looks whether the storage holds a newer stand of the saved data than this one was last read or saved at.
		 * Only looks: nothing is reloaded, nothing in memory is touched — neither the data, nor the undo history, nor
		 * the problems. A look the storage can't answer is no event: false, and the next one may be asked again. */
		async checkForNewer(): Promise<boolean> {
			if (seenVersion === null) return false; // nothing was read to be newer than
			// One look at a time: a second ask joins the one on its way. The look waits behind the saves on their
			// way, so it never takes this store's own save for someone else's.
			newerLook ??= (async () => {
				try {
					await savesSettled;
					return (await port.version(workspaceId)) !== seenVersion;
				} catch {
					return false; // the look failed: no hint, and with it nothing was changed here
				} finally {
					newerLook = null; // free for the next look
				}
			})();
			return newerLook;
		},

		/** Without a color, the type gets the first palette color no other type uses. */
		addType(
			name: string,
			properties: DraftProperty[],
			contentTemplate: string,
			color = nextTypeColor(data.types.map((t) => t.color)),
		): EntityType {
			const type: EntityType = {
				id: ulid(),
				name: name.trim(),
				properties: toPropertyDefs(properties),
				contentTemplate,
				color,
			};
			change({ ...data, types: [...data.types, type] });
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
			change(reconcile({ ...data, types: data.types.map((t) => (t.id === typeId ? updated : t)) }));
		},

		deleteType(typeId: string): void {
			change(
				reconcile({
					...data,
					types: data.types.filter((t) => t.id !== typeId),
					entities: data.entities.filter((e) => e.typeId !== typeId),
				}),
			);
		},

		addEntity(
			typeId: string,
			name: string,
			content: string,
			values: Record<string, PropertyValue>,
			description = "",
		): Entity {
			const entity: Entity = { id: ulid(), typeId, name: name.trim(), content, description, values };
			change({ ...data, entities: [...data.entities, entity] });
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
			change({
				...data,
				entities: data.entities.map((e) =>
					e.id === entityId ? { ...e, name: name.trim(), content, description: description ?? e.description, values } : e,
				),
			});
		},

		deleteEntity(entityId: string): void {
			change(reconcile({ ...data, entities: data.entities.filter((e) => e.id !== entityId) }));
		},

		addBoard(name: string): Board {
			const board = newBoard(name.trim() || `Board ${data.boards.length + 1}`);
			change({ ...data, boards: [...data.boards, board] });
			return board;
		},

		renameBoard(boardId: string, name: string): void {
			if (name.trim() === "") return;
			updateBoard(boardId, (b) => ({ ...b, name: name.trim() }));
		},

		/** Deletes a board and its cards (never the entities). The last board can't be deleted. */
		deleteBoard(boardId: string): void {
			if (data.boards.length <= 1) return;
			change({ ...data, boards: data.boards.filter((b) => b.id !== boardId) });
		},

		/** Switches story mode on or off. The pages stay while it's off; switched on for the first time, the board
		 * gets an empty page `firstPageName`, seen as the board is now. */
		setStoryMode(boardId: string, story: boolean, firstPageName: string): void {
			updateBoard(boardId, (b) => ({
				...b,
				story,
				pages: story && b.pages.length === 0 ? [newPage(firstPageName, { ...b.viewport })] : b.pages,
			}));
		},

		/** Adds a story mode page after `afterPageId`, with its pan/zoom and description position. With
		 * `copyPrevious`, it also shows what that page shows. */
		addPage(boardId: string, afterPageId: string, name: string, copyPrevious: boolean): StoryPage | null {
			const board = data.boards.find((b) => b.id === boardId);
			const index = board?.pages.findIndex((p) => p.id === afterPageId) ?? -1;
			const previous = board?.pages[index];
			if (!previous) return null;
			const page: StoryPage = {
				...newPage(name.trim(), { ...previous.viewport }),
				descriptionPosition: { ...previous.descriptionPosition },
				descriptionSize: { ...previous.descriptionSize },
				...(copyPrevious && {
					cardIds: [...previous.cardIds],
					drawingIds: [...previous.drawingIds],
					dimmedCardIds: [...previous.dimmedCardIds],
				}),
			};
			updateBoard(boardId, (b) => ({ ...b, pages: b.pages.toSpliced(index + 1, 0, page) }));
			return page;
		},

		updatePage(
			boardId: string,
			pageId: string,
			patch: Partial<Pick<StoryPage, "name" | "description" | "descriptionPosition" | "descriptionSize">>,
		): void {
			updateBoard(boardId, (b) => ({ ...b, pages: b.pages.map((p) => (p.id === pageId ? { ...p, ...patch } : p)) }));
		},

		/** Deletes a page; its cards and drawings stay on the board. The last page can't be deleted. */
		removePage(boardId: string, pageId: string): void {
			updateBoard(boardId, (b) => (b.pages.length <= 1 ? b : { ...b, pages: b.pages.filter((p) => p.id !== pageId) }));
		},

		/** Shows a card of the page faded, out of focus, or in focus again. */
		setDimmed(boardId: string, pageId: string, cardId: string, dimmed: boolean): void {
			updateBoard(boardId, (b) => ({
				...b,
				pages: b.pages.map((p) => {
					if (p.id !== pageId || !p.cardIds.includes(cardId)) return p;
					const others = p.dimmedCardIds.filter((id) => id !== cardId);
					return { ...p, dimmedCardIds: dimmed ? [...others, cardId] : others };
				}),
			}));
		},

		/** Shows one of the board's cards or drawings on the page too. */
		showOnPage(boardId: string, pageId: string, itemId: string): void {
			updateBoard(boardId, (b) => {
				const key = b.cards.some((c) => c.id === itemId) ? "cardIds" : b.drawings.some((d) => d.id === itemId) ? "drawingIds" : null;
				if (!key) return b;
				return {
					...b,
					pages: b.pages.map((p) => (p.id === pageId && !p[key].includes(itemId) ? { ...p, [key]: [...p[key], itemId] } : p)),
				};
			});
		},

		/** Adds a new card for the entity at (x, y), on top of the board's other cards — and shown on the page `pageId`. */
		addCard(boardId: string, entityId: string, x: number, y: number, pageId?: string): CanvasCard {
			const card: CanvasCard = { id: ulid(), entityId, x, y, ...DEFAULT_CARD_SIZE };
			updateBoard(boardId, (b) => ({
				...b,
				cards: [...b.cards, card],
				pages: b.pages.map((p) => (p.id === pageId ? { ...p, cardIds: [...p.cardIds, card.id] } : p)),
			}));
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

		/** Takes the card off its board; the entity itself stays. With `pageId`, only off that story mode page:
		 * it stays on the board. */
		removeCard(cardId: string, pageId?: string): void {
			updateCardBoard(cardId, (b) => takeOff(b, "cards", cardId, pageId));
		},

		/** With `pageId` (in story mode), the drawing is shown on that page. */
		addDrawing(boardId: string, drawing: NewDrawing, pageId?: string): Drawing {
			const added = { ...drawing, id: ulid() } as Drawing;
			updateBoard(boardId, (b) => ({
				...b,
				drawings: [...b.drawings, added],
				pages: b.pages.map((p) => (p.id === pageId ? { ...p, drawingIds: [...p.drawingIds, added.id] } : p)),
			}));
			return added;
		},

		/** Replaces the drawing with the same id (on whichever board it is). */
		replaceDrawing(drawing: Drawing): void {
			updateDrawingBoard(drawing.id, (b) => ({ ...b, drawings: b.drawings.map((d) => (d.id === drawing.id ? drawing : d)) }));
		},

		/** Like removeCard: with `pageId`, only off that page. */
		removeDrawing(drawingId: string, pageId?: string): void {
			updateDrawingBoard(drawingId, (b) => takeOff(b, "drawings", drawingId, pageId));
		},

		/** Pan and zoom are saved, but not part of the undo history. */
		setViewport(boardId: string, viewport: Viewport): void {
			data = withBoard(boardId, (b) => ({ ...b, viewport: { ...viewport, zoom: clampZoom(viewport.zoom) } }));
			save();
		},

		/** A story mode page's pan and zoom; like setViewport, not part of the undo history. */
		setPageViewport(boardId: string, pageId: string, viewport: Viewport): void {
			const next = { ...viewport, zoom: clampZoom(viewport.zoom) };
			data = withBoard(boardId, (b) => ({ ...b, pages: b.pages.map((p) => (p.id === pageId ? { ...p, viewport: next } : p)) }));
			save();
		},

		get history(): { canUndo: boolean; canRedo: boolean } {
			return { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
		},

		/** Takes back the last change; false if there's none. */
		undo(): boolean {
			const previous = undoStack.at(-1);
			if (!previous) return false;
			undoStack = undoStack.slice(0, -1);
			redoStack = [...redoStack, data];
			restore(previous);
			return true;
		},

		/** Makes the last undone change again; false if there's none. */
		redo(): boolean {
			const next = redoStack.at(-1);
			if (!next) return false;
			redoStack = redoStack.slice(0, -1);
			undoStack = [...undoStack, data];
			restore(next);
			return true;
		},

		/** Calls `listener` whenever `history` may have changed. */
		onHistoryChange(listener: () => void): void {
			historyListeners.push(listener);
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
