import { createStoreCore, moveItem, ulid, type DataFormat, type DataPort, type Point, type Rect } from "../../shared/core/index.js";
import { changesBetween, dataOps, keepWellFormed, normalizeEntityData, normalizedFeatureData, reconcileValues, storedFeatureData } from "../../features.core.js";
import { clampZoom, defaultViewport, visibleRect, type Viewport } from "./viewport.js";
import {
	DEFAULT_CARD_SIZE,
	frameShape,
	canTakeMore,
	freeSpot,
	placeBeside,
	referencedIds,
	type Relation,
	type AppData,
	TEXT_SIZES,
	parseTags,
	type Board,
	type BoxDrawing,
	type CanvasCard,
	type Drawing,
	type ImageDrawing,
	type NewDrawing,
	type TextSize,
	type Entity,
} from "./model.js";

export type Store = Awaited<ReturnType<typeof createStore>>;

/** The format of the saved data. When it changes, raise this and add the step from the old version to MIGRATIONS —
 * and a step to the API's schema (apps/api: schema.ts and sqlite.ts) that brings the stored rows to the new format
 * and sets `workspaces.data_version` to it. Saves write only the units that changed, so stored data never catches
 * up by itself: without that step, unchanged units stay in the old format under a version that says otherwise. The
 * API's tests fail as long as the step is missing. */
export const DATA_VERSION = 9;

type SavedData = Record<string, unknown>;

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

function newBoard(name: string): Board {
	const viewFrame = visibleRect(defaultViewport(), REFERENCE_SCREEN.width, REFERENCE_SCREEN.height);
	return { id: ulid(), name, cards: [], viewport: defaultViewport(), viewFrame, drawings: [] };
}

/** The board without the card or drawing `id`. */
function takeOff(board: Board, list: "cards" | "drawings", id: string): Board {
	return { ...board, [list]: (board[list] as { id: string }[]).filter((x) => x.id !== id) };
}

/** How two entities get linked, seen from one of them: through which reference property, held by which side. */
export type Link = { propId: string; direction: Relation["direction"] };

/**
 * Links the entity of the card `sourceCardId` with `other` through `link` (seen from the card's entity), in `data`,
 * which must hold `other`: the holder of the reference gets the other one added (if it allows several) or set. Then
 * `other` is shown on the card's board: by its card there, or by a new one beside the source card. Null if they
 * don't fit together, or are linked already.
 */
function linkOnBoard(data: AppData, sourceCardId: string, link: Link, other: Entity): { data: AppData; card: CanvasCard } | null {
	const board = data.boards.find((b) => b.cards.some((c) => c.id === sourceCardId));
	const source = board?.cards.find((c) => c.id === sourceCardId);
	const entity = data.entities.find((e) => e.id === source?.entityId);
	if (!board || !source || !entity || entity.id === other.id) return null;
	const [holder, target] = link.direction === "forward" ? [entity, other] : [other, entity];
	const prop = data.types.find((t) => t.id === holder.typeId)?.properties.find((p) => p.id === link.propId);
	if (prop?.kind !== "reference" || !prop.reference?.typeIds.includes(target.typeId) || !canTakeMore(prop, holder.values[prop.id])) return null;
	const linked = referencedIds(prop, holder.values[prop.id]);
	if (linked.includes(target.id)) return null;
	const value = prop.reference.multiple ? [...linked, target.id] : target.id;

	const existing = board.cards.find((c) => c.entityId === other.id);
	const card: CanvasCard = existing ?? { id: ulid(), entityId: other.id, ...placeBeside(source, board.cards, DEFAULT_CARD_SIZE), ...DEFAULT_CARD_SIZE };
	return {
		card,
		data: {
			...data,
			entities: data.entities.map((e) => (e.id === holder.id ? { ...e, values: { ...e.values, [prop.id]: value } } : e)),
			boards: existing ? data.boards : data.boards.map((b) => (b.id === board.id ? { ...b, cards: [...b.cards, card] } : b)),
		},
	};
}

function emptyData(): AppData {
	return { types: [], entities: [], boards: [newBoard("Board 1")], ...storedFeatureData({}) };
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Kinds of drawing from before text boxes, read as text boxes: rectangles, ellipses and free text. */
const OLD_TEXTBOX_KINDS: readonly unknown[] = ["rect", "ellipse", "text"];

/**
 * A well-formed drawing, or null. Boards saved before drawings existed have none. Rectangles, ellipses and free text
 * saved before text boxes are read as text boxes; lines, arrows and pen strokes from then are left out.
 */
function normalizeDrawing(raw: unknown): Drawing | null {
	const d = raw as Partial<Omit<BoxDrawing, "kind">> & Partial<Pick<ImageDrawing, "src">> & { kind?: unknown };
	if (typeof d?.id !== "string") return null;
	if (d.kind === "image") {
		if (![d.x, d.y, d.width, d.height].every(isNumber) || typeof d.src !== "string" || !d.src.startsWith("data:image/")) return null;
		return { id: d.id, kind: d.kind, x: d.x!, y: d.y!, width: d.width!, height: d.height!, src: d.src };
	}
	if (typeof d.color !== "string") return null;
	if (d.kind === "textbox" || d.kind === "area" || OLD_TEXTBOX_KINDS.includes(d.kind)) {
		if (![d.x, d.y, d.width, d.height].every(isNumber)) return null;
		return {
			id: d.id,
			kind: d.kind === "area" ? "area" : "textbox",
			x: d.x!,
			y: d.y!,
			width: d.width!,
			height: d.height!,
			color: d.color,
			text: typeof d.text === "string" ? d.text : "",
			textSize: TEXT_SIZES.includes(d.textSize as TextSize) ? (d.textSize as TextSize) : "m",
		};
	}
	return null;
}

function normalizeViewport(v: Partial<Viewport> | null | undefined): Viewport {
	return v && isNumber(v.x) && isNumber(v.y) && isNumber(v.zoom) ? { x: v.x, y: v.y, zoom: clampZoom(v.zoom) } : defaultViewport();
}

/** How large a screen is taken where none is at hand: the frame of a board saved before frames shows that much,
 * from the top left corner of its view, and a new board's frame is that large. */
export const REFERENCE_SCREEN = { width: 1280, height: 720 } as const;

/**
 * Keeps only well-formed cards and viewport; anything else falls back to defaults. Cards and boards saved without an
 * id get one. A board saved before frames gets its frame of its pan/zoom. What was saved of stories is left out.
 */
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
	const viewport = normalizeViewport(board?.viewport);
	return {
		id: typeof board?.id === "string" ? board.id : ulid(),
		name: typeof board?.name === "string" && board.name.trim() !== "" ? board.name : fallbackName,
		cards,
		viewport,
		// A board saved without its frame (before frames) gets one of its pan/zoom: the viewer showed the board so.
		viewFrame: frameShape(
			isObject(board?.viewFrame) && [board.viewFrame.x, board.viewFrame.y, board.viewFrame.width, board.viewFrame.height].every(isNumber)
				? { x: board.viewFrame.x, y: board.viewFrame.y, width: board.viewFrame.width, height: board.viewFrame.height }
				: visibleRect(viewport, REFERENCE_SCREEN.width, REFERENCE_SCREEN.height),
		),
		drawings,
	};
}

/**
 * Reads the boards, including the single `canvas` saved by the version before boards existed. A workspace with
 * no entities yet (a new one, maybe with copied types) gets a first board; otherwise there may
 * be none, once the last one was deleted.
 */
function normalizeBoards(data: AppData & { canvas?: Partial<Board> }): Board[] {
	const raw: Partial<Board>[] = Array.isArray(data.boards) ? data.boards : data.canvas ? [data.canvas] : [];
	const boards = raw.map((b, i) => normalizeBoard(b, `Board ${i + 1}`));
	return boards.length > 0 || data.entities.length > 0 ? boards : [newBoard("Board 1")];
}

/** Re-validates every entity's values against its type's current properties, e.g. dropping references to deleted entities,
 * and drops cards of deleted entities. */
function reconcile(data: AppData): AppData {
	return pruneCards(reconcileValues(data));
}

/** The boards without the cards of entities that are gone. */
function pruneCards(data: AppData): AppData {
	const entities = new Set(data.entities.map((e) => e.id));
	return { ...data, boards: data.boards.map((b) => ({ ...b, cards: b.cards.filter((c) => entities.has(c.entityId)) })) };
}


const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether `value` has the shape of saved data (types and entities lists), so loading can make use of it. */
export function looksLikeAppData(value: unknown): value is Record<string, unknown> & Pick<AppData, "types" | "entities"> {
	return isObject(value) && Array.isArray(value.types) && Array.isArray(value.entities);
}

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
		...storedFeatureData(data),
	};
}

/** Fills in fields that data saved by earlier versions may lack (e.g. number/boolean/date kinds, non-string values, entity names, ULIDs). */
function normalize(data: AppData): AppData {
	return {
		boards: normalizeBoards(data),
		...normalizedFeatureData(data),
		...normalizeEntityData(data),
	};
}

/** Imported data as the app holds it — brought up to this format, checked and completed the way a load
 * does — or null when it isn't app data, or is from a newer version of the app than this one. */
export function prepareImport(raw: unknown): AppData | null {
	if (!looksLikeAppData(raw) || savedVersion(raw) > DATA_VERSION) return null;
	return reconcile(normalize(keepWellFormed(migrate(raw) as unknown as AppData)));
}

/** The app's saved data as the store and the workspaces read, save, compare and import it. */
export const APP_FORMAT: DataFormat<AppData> = {
	version: DATA_VERSION,
	read(raw) {
		if (!looksLikeAppData(raw)) return null;
		if (savedVersion(raw) > DATA_VERSION) {
			const understood = reconcile(normalize(keepWellFormed(raw as unknown as AppData)));
			return { data: understood, problem: { code: "newerVersion" }, stand: null };
		}
		const kept = keepWellFormed(migrate(raw) as unknown as AppData);
		return { data: reconcile(normalize(kept)), problem: null, stand: storedStand(kept) };
	},
	looksLike: looksLikeAppData,
	prepareImport,
	empty: emptyData,
	nothing: () => ({ types: [], entities: [], boards: [], ...storedFeatureData({}) }),
	toSaved,
	changesBetween,
	// Undo and redo restore everything but the boards' pan and zoom, which stay as they are now.
	restore(snapshot, current) {
		const viewports = new Map(current.boards.map((b) => [b.id, b.viewport]));
		return { ...snapshot, boards: snapshot.boards.map((b) => ({ ...b, viewport: viewports.get(b.id) ?? b.viewport })) };
	},
};

/** The data of one workspace, kept in memory and saved through `port` as it changes (see `createStoreCore`), with
 * the changes the app makes to it. */
export async function createStore(port: DataPort, workspaceId: string) {
	const core = await createStoreCore(port, workspaceId, APP_FORMAT);

	const withBoard = (boardId: string, fn: (board: Board) => Board): AppData => ({
		...core.data,
		boards: core.data.boards.map((b) => (b.id === boardId ? fn(b) : b)),
	});

	function updateBoard(boardId: string, fn: (board: Board) => Board): void {
		core.change(withBoard(boardId, fn));
	}

	/** Applies fn to the board holding the drawing. */
	function updateDrawingBoard(drawingId: string, fn: (board: Board) => Board): void {
		const board = core.data.boards.find((b) => b.drawings.some((d) => d.id === drawingId));
		if (board) updateBoard(board.id, fn);
	}

	/** Applies fn to the board holding the card (card ids are unique across boards). */
	function updateCardBoard(cardId: string, fn: (board: Board, card: CanvasCard) => Board): void {
		for (const board of core.data.boards) {
			const card = board.cards.find((c) => c.id === cardId);
			if (card) return updateBoard(board.id, (b) => fn(b, card));
		}
	}

	return Object.assign(core, dataOps(core, pruneCards), {
		addBoard(name: string): Board {
			const board = newBoard(name.trim() || `Board ${core.data.boards.length + 1}`);
			core.change({ ...core.data, boards: [...core.data.boards, board] });
			return board;
		},

		renameBoard(boardId: string, name: string): void {
			if (name.trim() === "") return;
			updateBoard(boardId, (b) => ({ ...b, name: name.trim() }));
		},

		/** Moves the board to index `to` in the list of boards. */
		moveBoard(boardId: string, to: number): void {
			const from = core.data.boards.findIndex((b) => b.id === boardId);
			if (from < 0) return;
			core.change({ ...core.data, boards: moveItem(core.data.boards, from, to) });
		},

		/** Deletes a board and its cards (never the entities), even the last one. */
		deleteBoard(boardId: string): void {
			core.change({ ...core.data, boards: core.data.boards.filter((b) => b.id !== boardId) });
		},

		/** Adds a new card for the entity at (x, y), on top of the board's other cards. */
		addCard(boardId: string, entityId: string, x: number, y: number): CanvasCard {
			const card: CanvasCard = { id: ulid(), entityId, x, y, ...DEFAULT_CARD_SIZE };
			updateBoard(boardId, (b) => ({ ...b, cards: [...b.cards, card] }));
			return card;
		},

		/** Puts the cards of several entities on the board as one change: an entity with a card there already has its
		 * first card moved to (x, y), the others get a new one on top. An entity given twice goes where it's given
		 * last. Answers the cards, one per entity in the order given. */
		placeCards(boardId: string, placements: readonly { entityId: string; x: number; y: number }[]): CanvasCard[] {
			const board = core.data.boards.find((b) => b.id === boardId);
			if (!board || placements.length === 0) return [];
			const last = new Map(placements.map((p) => [p.entityId, p]));
			const cards = [...last.values()].map(({ entityId, x, y }): CanvasCard => {
				const existing = board.cards.find((c) => c.entityId === entityId);
				return existing ? { ...existing, x, y } : { id: ulid(), entityId, x, y, ...DEFAULT_CARD_SIZE };
			});
			const byId = new Map(cards.map((c) => [c.id, c]));
			const added = cards.filter((c) => !board.cards.some((b) => b.id === c.id));
			updateBoard(boardId, (b) => ({ ...b, cards: [...b.cards.map((c) => byId.get(c.id) ?? c), ...added] }));
			return cards;
		},

		/**
		 * Creates an entity of type `typeId` named `name` and links it with the entity of the card `sourceCardId`
		 * through `link` (seen from that entity; see linkOnBoard, which also places its card). It gets the type's
		 * template as description and the source entity's tags (it belongs to the same set). One change, so one
		 * undo step; null (and no change) if they don't fit together.
		 */
		addLinkedEntity(sourceCardId: string, link: Link, typeId: string, name: string): { entity: Entity; card: CanvasCard } | null {
			const type = core.data.types.find((t) => t.id === typeId);
			const sourceEntityId = core.data.boards.flatMap((b) => b.cards).find((c) => c.id === sourceCardId)?.entityId;
			const sourceEntity = core.data.entities.find((e) => e.id === sourceEntityId);
			if (!type || !sourceEntity) return null;
			const entity: Entity = {
				id: ulid(),
				typeId,
				name: name.trim(),
				content: "",
				description: type.contentTemplate,
				tags: [...sourceEntity.tags],
				values: {},
			};
			const linked = linkOnBoard({ ...core.data, entities: [...core.data.entities, entity] }, sourceCardId, link, entity);
			if (!linked) return null;
			core.change(linked.data);
			return { entity: linked.data.entities.find((e) => e.id === entity.id)!, card: linked.card }; // with its reference, if it holds it
		},

		/** Links an existing entity with the entity of the card `sourceCardId` through `link`, showing its card
		 * there (see linkOnBoard); one change. Answers that card, or null (and no change) if they don't fit together. */
		linkEntity(sourceCardId: string, link: Link, otherId: string): CanvasCard | null {
			const other = core.data.entities.find((e) => e.id === otherId);
			const linked = other && linkOnBoard(core.data, sourceCardId, link, other);
			if (!linked) return null;
			core.change(linked.data);
			return linked.card;
		},

		/** Creates an entity of type `typeId` named `name`, with `tags` and the type's template as description, and its
		 * card on the board at the first free spot from `at`; one change. */
		addEntityWithCard(boardId: string, typeId: string, name: string, at: Point, tags: readonly string[] = []): { entity: Entity; card: CanvasCard } | null {
			const type = core.data.types.find((t) => t.id === typeId);
			const board = core.data.boards.find((b) => b.id === boardId);
			if (!type || !board) return null;
			const entity: Entity = { id: ulid(), typeId, name: name.trim(), content: "", description: type.contentTemplate, tags: parseTags(tags.join(",")), values: {} };
			const card: CanvasCard = { id: ulid(), entityId: entity.id, ...freeSpot(at, board.cards, DEFAULT_CARD_SIZE), ...DEFAULT_CARD_SIZE };
			core.change({
				...core.data,
				entities: [...core.data.entities, entity],
				boards: core.data.boards.map((b) => (b.id === boardId ? { ...b, cards: [...b.cards, card] } : b)),
			});
			return { entity, card };
		},

		/** Moves a card to (x, y) and brings it to the front. */
		moveCard(cardId: string, x: number, y: number): void {
			updateCardBoard(cardId, (b, card) => ({
				...b,
				cards: [...b.cards.filter((c) => c.id !== cardId), { ...card, x, y }],
			}));
		},

		/** Moves some of a board's cards and drawings by (dx, dy) together, as one change (one undo step). Unlike
		 * moveCard, it keeps the order of the cards. */
		moveItems(boardId: string, cardIds: readonly string[], drawingIds: readonly string[], dx: number, dy: number): void {
			const cards = new Set(cardIds);
			const drawings = new Set(drawingIds);
			const move = (d: Drawing): Drawing => ({ ...d, x: d.x + dx, y: d.y + dy });
			updateBoard(boardId, (b) => ({
				...b,
				cards: b.cards.map((c) => (cards.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c)),
				drawings: b.drawings.map((d) => (drawings.has(d.id) ? move(d) : d)),
			}));
		},

		/** The sizes cards were measured at, by card id. Saved, but like pan and zoom not part of the undo history:
		 * they follow from what the cards show. */
		fitCards(sizes: ReadonlyMap<string, { width: number; height: number }>): void {
			core.changeQuietly({
				...core.data,
				boards: core.data.boards.map((b) =>
					b.cards.some((c) => sizes.has(c.id)) ? { ...b, cards: b.cards.map((c) => ({ ...c, ...sizes.get(c.id) })) } : b,
				),
			});
		},

		/** Takes the card off its board; the entity itself stays. */
		removeCard(cardId: string): void {
			updateCardBoard(cardId, (b) => takeOff(b, "cards", cardId));
		},

		addDrawing(boardId: string, drawing: NewDrawing): Drawing {
			const added = { ...drawing, id: ulid() } as Drawing;
			updateBoard(boardId, (b) => ({ ...b, drawings: [...b.drawings, added] }));
			return added;
		},

		/** Replaces the drawing with the same id (on whichever board it is). */
		replaceDrawing(drawing: Drawing): void {
			const replace = (drawings: Drawing[]) => drawings.map((d) => (d.id === drawing.id ? drawing : d));
			updateDrawingBoard(drawing.id, (b) => ({ ...b, drawings: replace(b.drawings) }));
		},

		removeDrawing(drawingId: string): void {
			updateDrawingBoard(drawingId, (b) => takeOff(b, "drawings", drawingId));
		},

		/** Pan and zoom are saved, but not part of the undo history. */
		setViewport(boardId: string, viewport: Viewport): void {
			core.changeQuietly(withBoard(boardId, (b) => ({ ...b, viewport: { ...viewport, zoom: clampZoom(viewport.zoom) } })));
		},

		/** Moves or resizes the board's own frame, in a frame's shape (see frameShape). */
		setViewFrame(boardId: string, rect: Rect): void {
			updateBoard(boardId, (b) => ({ ...b, viewFrame: frameShape({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }) }));
		},

	});
}
