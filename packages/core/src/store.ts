import { isUlid, ulid } from "./ulid.js";
import type { Point, Rect } from "./connectors.js";
import { changesBetween } from "./changes.js";
import type { DataPort } from "./ports.js";
import { clampZoom, defaultViewport, visibleRect, type Viewport } from "./viewport.js";
import {
	DEFAULT_CARD_SIZE,
	DEFAULT_DESCRIPTION_SIZE,
	MIN_DESCRIPTION_SIZE,
	frameShape,
	descriptionInView,
	MIN_CARD_SIZE,
	CARD_DISPLAYS,
	LINE_ARROWS,
	PROPERTY_KINDS,
	effectiveCardDisplay,
	entityTypeMap,
	migrateValues,
	moveItem,
	nextTypeColor,
	boardPages,
	canTakeMore,
	mapPages,
	freeSpot,
	placeBeside,
	referencedIds,
	type Relation,
	type AppData,
	PEN_STYLES,
	TEXT_SIZES,
	hasRect,
	isSymbol,
	parseTags,
	type Board,
	type BoxDrawing,
	type CanvasCard,
	type Drawing,
	type ImageDrawing,
	type LibraryDrawing,
	type NewDrawing,
	type PathDrawing,
	type PenStyle,
	type TextSize,
	type DraftProperty,
	type SymbolDrawing,
	type Entity,
	type EntityType,
	type PropertyDef,
	type ReferenceDef,
	type PropertyValue,
	type Story,
	type StoryPage,
	type ViewFrame,
} from "./model.js";

export type Store = Awaited<ReturnType<typeof createStore>>;

/** How many changes can be undone. */
const HISTORY_LIMIT = 100;

/** The format of the saved data. When it changes, raise this and add the step from the old version to MIGRATIONS. */
export const DATA_VERSION = 6;

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
	// Version 4 adds the library; normalize() gives data without one an empty library.
	3: (data) => data,
	// Version 5 gives boards several stories; normalizeBoard() turns a board's steps from before into one story.
	4: (data) => data,
	// Version 6 shows steps and boards in view frames instead of each step with its own pan/zoom; normalizeBoard()
	// turns the pan/zoom of the steps from before into frames, and gives each board a frame of its own pan/zoom.
	5: (data) => data,
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

/** A new page, with its description in view in `viewport`. */
function newPage(name: string, viewport = defaultViewport(), frameId: string | null = null): StoryPage {
	return {
		id: ulid(),
		name,
		description: "",
		descriptionPosition: descriptionInView(viewport),
		descriptionSize: { ...DEFAULT_DESCRIPTION_SIZE },
		frameId,
		cardIds: [],
		drawingIds: [],
		dimmedCardIds: [],
	};
}

function newBoard(name: string): Board {
	const viewFrame = visibleRect(defaultViewport(), REFERENCE_SCREEN.width, REFERENCE_SCREEN.height);
	return { id: ulid(), name, cards: [], viewport: defaultViewport(), viewFrame, frames: [], drawings: [], stories: [] };
}

/** Keeps only the ids of the cards and drawings the board still has, on every page of its stories. */
function prunePages(board: Board): Board {
	if (board.stories.length === 0) return board;
	const cardIds = new Set(board.cards.map((c) => c.id));
	const drawingIds = new Set(board.drawings.map((d) => d.id));
	return mapPages(board, (p) => ({
		...p,
		cardIds: p.cardIds.filter((id) => cardIds.has(id)),
		dimmedCardIds: p.dimmedCardIds.filter((id) => cardIds.has(id)),
		drawingIds: p.drawingIds.filter((id) => drawingIds.has(id)),
	}));
}

/** With `pageId`, takes the card or drawing off that page only: it stays on the board (stories never delete).
 * Without, off the board, and with it off every page. */
function takeOff(board: Board, list: "cards" | "drawings", id: string, pageId?: string): Board {
	const key = list === "cards" ? "cardIds" : "drawingIds";
	const pruned = mapPages(board, (p) =>
		pageId === undefined || p.id === pageId
			? { ...p, [key]: p[key].filter((x) => x !== id), dimmedCardIds: p.dimmedCardIds.filter((x) => x !== id) }
			: p,
	);
	if (pageId !== undefined) return pruned;
	return { ...pruned, [list]: (board[list] as { id: string }[]).filter((x) => x.id !== id) };
}

/** The board with `card` added, also to the page `pageId` (of one of its stories), if given. */
function withCard(board: Board, card: CanvasCard, pageId?: string): Board {
	return mapPages({ ...board, cards: [...board.cards, card] }, (p) => (p.id === pageId ? { ...p, cardIds: [...p.cardIds, card.id] } : p));
}

/** The board with the page `pageId` seen in the frame `frameId` (null: the board's frame). */
function withFrame(board: Board, frameId: string | null, pageId: string): Board {
	return mapPages(board, (p) => (p.id === pageId ? { ...p, frameId } : p));
}

/** How two entities get linked, seen from one of them: through which reference property, held by which side. */
export type Link = { propId: string; direction: Relation["direction"] };

/**
 * Links the entity of the card `sourceCardId` with `other` through `link` (seen from the card's entity), in `data`,
 * which must hold `other`: the holder of the reference gets the other one added (if it allows several) or set. Then
 * `other` is shown on the card's board: by its card there (on the page shown, if it has one there), or by a new one
 * beside the source card; with `pageId`, that card is also put on the story page. Null if they don't fit
 * together, or are linked already.
 */
function linkOnBoard(data: AppData, sourceCardId: string, link: Link, other: Entity, pageId?: string): { data: AppData; card: CanvasCard } | null {
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

	const page = boardPages(board).find((p) => p.id === pageId);
	const theirs = board.cards.filter((c) => c.entityId === other.id);
	const existing = theirs.find((c) => !page || page.cardIds.includes(c.id)) ?? theirs[0];
	const card: CanvasCard = existing ?? { id: ulid(), entityId: other.id, ...placeBeside(source, board.cards, DEFAULT_CARD_SIZE), ...DEFAULT_CARD_SIZE };
	return {
		card,
		data: {
			...data,
			entities: data.entities.map((e) => (e.id === holder.id ? { ...e, values: { ...e.values, [prop.id]: value } } : e)),
			boards: data.boards.map((b) =>
				b.id === board.id
					? mapPages({ ...b, cards: existing ? b.cards : [...b.cards, card] }, (p) =>
							p.id === pageId && !p.cardIds.includes(card.id) ? { ...p, cardIds: [...p.cardIds, card.id] } : p,
						)
					: b,
			),
		},
	};
}

function emptyData(): AppData {
	return { types: [], entities: [], boards: [newBoard("Board 1")], library: [] };
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isPoint = (p: unknown): p is Point => isNumber((p as Point | null)?.x) && isNumber((p as Point | null)?.y);

/** A well-formed drawing, or null. Boards saved before drawings existed have none. */
function normalizeDrawing(raw: unknown): Drawing | null {
	const d = raw as Partial<Omit<BoxDrawing, "kind">> &
		Partial<Omit<PathDrawing, "kind">> &
		Partial<Pick<ImageDrawing, "src">> & { kind?: unknown };
	if (typeof d?.id !== "string") return null;
	if (d.kind === "symbol") {
		const { libraryId } = raw as Partial<SymbolDrawing>;
		if (![d.x, d.y, d.width, d.height].every(isNumber) || typeof libraryId !== "string") return null;
		return { id: d.id, kind: d.kind, libraryId, x: d.x!, y: d.y!, width: d.width!, height: d.height! };
	}
	if (d.kind === "image") {
		if (![d.x, d.y, d.width, d.height].every(isNumber) || typeof d.src !== "string" || !d.src.startsWith("data:image/")) return null;
		return { id: d.id, kind: d.kind, x: d.x!, y: d.y!, width: d.width!, height: d.height!, src: d.src };
	}
	if (typeof d.color !== "string") return null;
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
		if (d.kind !== "pen") return { id: d.id, kind: d.kind, points, color: d.color };
		const penStyle = PEN_STYLES.includes(d.penStyle as PenStyle) ? (d.penStyle as PenStyle) : "pen";
		return { id: d.id, kind: d.kind, points, color: d.color, penStyle };
	}
	return null;
}

function normalizeViewport(v: Partial<Viewport> | null | undefined): Viewport {
	return v && isNumber(v.x) && isNumber(v.y) && isNumber(v.zoom) ? { x: v.x, y: v.y, zoom: clampZoom(v.zoom) } : defaultViewport();
}


/** The ids a board's pages may name: its cards, drawings and frames — and, for pages saved before frames, the frame
 * made of each one's pan/zoom (see legacyFrames). */
interface BoardIds {
	cardIds: ReadonlySet<string>;
	drawingIds: ReadonlySet<string>;
	frameIds: ReadonlySet<string>;
	legacyFrameIds: ReadonlyMap<string, string>;
}

/** A well-formed page, or null; its ids only name the board's own cards, drawings and frames. */
function normalizePage(raw: unknown, { cardIds, drawingIds, frameIds, legacyFrameIds }: BoardIds, fallbackName: string): StoryPage | null {
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
		frameId: typeof raw.frameId === "string" && frameIds.has(raw.frameId) ? raw.frameId : (legacyFrameIds.get(raw.id) ?? null),
		cardIds: shown,
		drawingIds: ids(raw.drawingIds, drawingIds),
		dimmedCardIds: ids(raw.dimmedCardIds, new Set(shown)),
	};
}

/** A well-formed story with at least one page (a new one, seen like `viewport`, if it has none), or null. Pages whose
 * id another story of the board has already (in `seen`) are left out: page ids are unique on a board. */
function normalizeStory(
	raw: unknown,
	ids: BoardIds,
	seen: Set<string>,
	viewport: Viewport,
	fallbackName: string,
): Story | null {
	if (!isObject(raw) || typeof raw.id !== "string") return null;
	const pages = (Array.isArray(raw.pages) ? raw.pages : []).flatMap((p: unknown, i: number) => {
		const page = normalizePage(p, ids, `Step ${i + 1}`);
		if (!page || seen.has(page.id)) return [];
		seen.add(page.id);
		return [page];
	});
	return {
		id: raw.id,
		name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : fallbackName,
		pages: pages.length > 0 ? pages : [newPage("Step 1", { ...viewport })],
	};
}

/** How large a screen is taken where none is at hand: the frames made of a pan/zoom saved before frames show that
 * much, from the top left corner of their view, and a new board's frame is that large. */
export const REFERENCE_SCREEN = { width: 1280, height: 720 } as const;

/** A well-formed frame, in a frame's shape (see frameShape), or null. */
function normalizeFrame(raw: unknown, fallbackName: string): ViewFrame | null {
	if (!isObject(raw) || typeof raw.id !== "string" || ![raw.x, raw.y, raw.width, raw.height].every(isNumber)) return null;
	return {
		id: raw.id,
		name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : fallbackName,
		...frameShape({ x: raw.x as number, y: raw.y as number, width: raw.width as number, height: raw.height as number }),
	};
}

/**
 * The frames made of the pan/zoom of steps saved before frames, and which frame each step (by id) is seen in. Steps
 * seen alike (a new step took the pan/zoom of the one before) share a frame, named after the first of them and with
 * its id, so reading the same data twice makes the same frames.
 */
function legacyFrames(rawStories: readonly unknown[]): { frames: ViewFrame[]; frameIds: Map<string, string> } {
	const byView = new Map<string, ViewFrame>();
	const frameIds = new Map<string, string>();
	for (const story of rawStories) {
		const pages = isObject(story) && Array.isArray(story.pages) ? story.pages : [];
		for (const page of pages) {
			if (!isObject(page) || typeof page.id !== "string" || frameIds.has(page.id)) continue;
			const viewport = normalizeViewport(page.viewport as Partial<Viewport> | undefined);
			const key = `${viewport.x},${viewport.y},${viewport.zoom}`;
			let frame = byView.get(key);
			if (!frame) {
				const name = typeof page.name === "string" && page.name.trim() !== "" ? page.name : `Frame ${byView.size + 1}`;
				frame = { id: page.id, name, ...visibleRect(viewport, REFERENCE_SCREEN.width, REFERENCE_SCREEN.height) };
				byView.set(key, frame);
			}
			frameIds.set(page.id, frame.id);
		}
	}
	return { frames: [...byView.values()], frameIds };
}

/**
 * Keeps only well-formed cards and viewport; anything else falls back to defaults. Cards and boards saved without an
 * id get one. A board saved before boards had several stories had steps (`pages`, kept also while its story mode was
 * off): they become one story, with the board's id (as the server's schema migration does). A board saved before
 * frames gets frames for its steps' pan/zoom (see legacyFrames), and its own frame of its pan/zoom.
 */
function normalizeBoard(
	board: (Omit<Partial<Board>, "frames"> & { frames?: unknown; story?: unknown; pages?: unknown }) | undefined,
	fallbackName: string,
): Board {
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
	const id = typeof board?.id === "string" ? board.id : ulid();
	const viewport = normalizeViewport(board?.viewport);
	const steps = Array.isArray(board?.pages) ? board.pages : [];
	const rawStories: unknown[] = Array.isArray(board?.stories)
		? board.stories
		: steps.length > 0 || board?.story === true
			? [{ id, name: "Story 1", pages: steps }]
			: [];
	const legacy = Array.isArray(board?.frames) ? null : legacyFrames(rawStories);
	const frames = legacy?.frames ?? (board!.frames as unknown[]).flatMap((f, i) => normalizeFrame(f, `Frame ${i + 1}`) ?? []);
	const frameIds = new Set(frames.map((f) => f.id));
	const ids: BoardIds = { cardIds, drawingIds, frameIds, legacyFrameIds: legacy?.frameIds ?? new Map() };
	const seen = new Set<string>();
	return {
		id,
		name: typeof board?.name === "string" && board.name.trim() !== "" ? board.name : fallbackName,
		cards,
		viewport,
		// A board saved without its frame (before frames) gets one of its pan/zoom: the viewer showed the board so.
		viewFrame: frameShape(
			isObject(board?.viewFrame) && [board.viewFrame.x, board.viewFrame.y, board.viewFrame.width, board.viewFrame.height].every(isNumber)
				? { x: board.viewFrame.x, y: board.viewFrame.y, width: board.viewFrame.width, height: board.viewFrame.height }
				: visibleRect(viewport, REFERENCE_SCREEN.width, REFERENCE_SCREEN.height),
		),
		frames,
		drawings,
		stories: rawStories.flatMap((raw, i) => normalizeStory(raw, ids, seen, viewport, `Story ${i + 1}`) ?? []),
	};
}

/**
 * Reads the boards, including the single `canvas` saved by the version before boards existed. A workspace with
 * no entities or library drawings yet (a new one, maybe with copied types) gets a first board; otherwise there may
 * be none, once the last one was deleted.
 */
function normalizeBoards(data: AppData & { canvas?: Partial<Board> }): Board[] {
	const raw: Partial<Board>[] = Array.isArray(data.boards) ? data.boards : data.canvas ? [data.canvas] : [];
	const boards = raw.map((b, i) => normalizeBoard(b, `Board ${i + 1}`));
	const fresh = data.entities.length === 0 && !(Array.isArray(data.library) && data.library.length > 0);
	return boards.length > 0 || !fresh ? boards : [newBoard("Board 1")];
}

/** The well-formed library drawings, each with only well-formed drawings — never other library drawings. */
function normalizeLibrary(raw: unknown): LibraryDrawing[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item: unknown, i) => {
		if (!isObject(item) || typeof item.id !== "string") return [];
		const tags = Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string") : [];
		const drawings = Array.isArray(item.drawings) ? item.drawings.flatMap((d) => normalizeDrawing(d) ?? []) : [];
		return [
			{
				id: item.id,
				name: typeof item.name === "string" && item.name.trim() !== "" ? item.name : `Drawing ${i + 1}`,
				tags: parseTags(tags.join(",")),
				drawings: drawings.filter((d) => !isSymbol(d)),
			},
		];
	});
}

/** Re-validates every entity's values against its type's current properties, e.g. dropping references to deleted entities,
 * and drops cards of deleted entities and placed drawings whose library drawing was deleted. */
function reconcile(data: AppData): AppData {
	const entityTypes = entityTypeMap(data);
	const typesById = new Map(data.types.map((t) => [t.id, t]));
	const libraryIds = new Set(data.library.map((item) => item.id));
	return {
		...data,
		entities: data.entities.map((e) => ({
			...e,
			values: migrateValues(e.values, typesById.get(e.typeId)?.properties ?? [], entityTypes),
		})),
		boards: data.boards.map((b) =>
			prunePages({
				...b,
				cards: b.cards.filter((c) => entityTypes.has(c.entityId)),
				drawings: b.drawings.filter((d) => !isSymbol(d) || libraryIds.has(d.libraryId)),
			}),
		),
	};
}

/** Reads `cardDisplay`, or converts the `showOnCard` checkbox saved by the previous version. */
function cardDisplayFor(prop: PropertyDef, showOnCard: unknown): PropertyDef["cardDisplay"] {
	if (CARD_DISPLAYS.includes(prop.cardDisplay)) return effectiveCardDisplay(prop);
	return showOnCard === false ? "hidden" : "list";
}

/** Fills in a reference's defaults, and reads the single `typeId` saved before it could target several types. */
function normalizeReference({ typeId, ...reference }: ReferenceDef & { typeId?: unknown }): ReferenceDef {
	return {
		...reference,
		typeIds: Array.isArray(reference.typeIds)
			? reference.typeIds.filter((id) => typeof id === "string")
			: typeof typeId === "string"
				? [typeId]
				: [],
		arrow: LINE_ARROWS.includes(reference.arrow) ? reference.arrow : "to",
		lineLabel: typeof reference.lineLabel === "string" ? reference.lineLabel : "",
		inverseLabel: typeof reference.inverseLabel === "string" ? reference.inverseLabel : "",
	};
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
		library: Array.isArray(data.library) ? data.library : [],
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
		library: normalizeLibrary(data.library),
		types: data.types.map((type) => ({
			...type,
			color: colorFor(type.color),
			contentTemplate: typeof type.contentTemplate === "string" ? type.contentTemplate : "",
			properties: type.properties.map(({ showOnCard, ...prop }: PropertyDef & { showOnCard?: unknown }) => ({
				...prop,
				kind: PROPERTY_KINDS.includes(prop.kind) ? prop.kind : "text",
				options: Array.isArray(prop.options) ? prop.options : [],
				reference: prop.reference ? normalizeReference(prop.reference) : null,
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
			const tags = Array.isArray(entity.tags) ? parseTags(entity.tags.filter((t) => typeof t === "string").join(",")) : [];
			return { ...entity, id: isUlid(entity.id) ? entity.id : ulid(), name, content, description, tags, values };
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

	/** Undo and redo restore everything but the boards' pan and zoom, which stay as they are now. */
	function restore(snapshot: AppData): void {
		const viewports = new Map(data.boards.map((b) => [b.id, b.viewport]));
		data = { ...snapshot, boards: snapshot.boards.map((b) => ({ ...b, viewport: viewports.get(b.id) ?? b.viewport })) };
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

	/** Applies fn to the library drawing made of the drawing; false when no library drawing holds it. */
	function updateLibraryHolding(drawingId: string, fn: (item: LibraryDrawing) => LibraryDrawing): boolean {
		const holder = data.library.find((item) => item.drawings.some((d) => d.id === drawingId));
		if (!holder) return false;
		change({ ...data, library: data.library.map((item) => (item.id === holder.id ? fn(item) : item)) });
		return true;
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

		/** Moves the type to index `to` in the list of types. */
		moveType(typeId: string, to: number): void {
			const from = data.types.findIndex((t) => t.id === typeId);
			if (from < 0) return;
			change({ ...data, types: moveItem(data.types, from, to) });
		},

		addEntity(
			typeId: string,
			name: string,
			content: string,
			values: Record<string, PropertyValue>,
			description = "",
			tags: readonly string[] = [],
		): Entity {
			const entity: Entity = { id: ulid(), typeId, name: name.trim(), content, description, tags: parseTags(tags.join(",")), values };
			change({ ...data, entities: [...data.entities, entity] });
			return entity;
		},

		/** Without a description or tags, the entity keeps its current ones. */
		updateEntity(
			entityId: string,
			name: string,
			content: string,
			values: Record<string, PropertyValue>,
			description?: string,
			tags?: readonly string[],
		): void {
			change({
				...data,
				entities: data.entities.map((e) =>
					e.id === entityId
						? {
								...e,
								name: name.trim(),
								content,
								description: description ?? e.description,
								tags: tags ? parseTags(tags.join(",")) : e.tags,
								values,
							}
						: e,
				),
			});
		},

		/** Moves the entity to index `to` among the entities of its type; other types' entities keep their places. */
		moveEntity(entityId: string, to: number): void {
			const entity = data.entities.find((e) => e.id === entityId);
			if (!entity) return;
			const ofType = data.entities.filter((e) => e.typeId === entity.typeId);
			const reordered = moveItem(ofType, ofType.indexOf(entity), to);
			let next = 0;
			change({ ...data, entities: data.entities.map((e) => (e.typeId === entity.typeId ? reordered[next++]! : e)) });
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

		/** Deletes a board and its cards (never the entities), even the last one. */
		deleteBoard(boardId: string): void {
			change({ ...data, boards: data.boards.filter((b) => b.id !== boardId) });
		},

		/** Adds a story to the board, with an empty first page `firstPageName`, its description in the board's view (the
		 * page is seen in the board's frame). */
		addStory(boardId: string, name: string, firstPageName: string): Story | null {
			const board = data.boards.find((b) => b.id === boardId);
			if (!board) return null;
			const story: Story = {
				id: ulid(),
				name: name.trim() || `Story ${board.stories.length + 1}`,
				pages: [newPage(firstPageName, { ...board.viewport })],
			};
			updateBoard(boardId, (b) => ({ ...b, stories: [...b.stories, story] }));
			return story;
		},

		renameStory(boardId: string, storyId: string, name: string): void {
			if (name.trim() === "") return;
			updateBoard(boardId, (b) => ({ ...b, stories: b.stories.map((s) => (s.id === storyId ? { ...s, name: name.trim() } : s)) }));
		},

		/** Deletes a story with its pages; their cards and drawings stay on the board. */
		removeStory(boardId: string, storyId: string): void {
			updateBoard(boardId, (b) => ({ ...b, stories: b.stories.filter((s) => s.id !== storyId) }));
		},

		/** Adds a page after `afterPageId`, in its story, with its frame and description position. With
		 * `copyPrevious`, it also shows what that page shows. */
		addPage(boardId: string, afterPageId: string, name: string, copyPrevious: boolean): StoryPage | null {
			const board = data.boards.find((b) => b.id === boardId);
			const story = board?.stories.find((s) => s.pages.some((p) => p.id === afterPageId));
			const index = story?.pages.findIndex((p) => p.id === afterPageId) ?? -1;
			const previous = story?.pages[index];
			if (!story || !previous) return null;
			const page: StoryPage = {
				...newPage(name.trim(), undefined, previous.frameId),
				descriptionPosition: { ...previous.descriptionPosition },
				descriptionSize: { ...previous.descriptionSize },
				...(copyPrevious && {
					cardIds: [...previous.cardIds],
					drawingIds: [...previous.drawingIds],
					dimmedCardIds: [...previous.dimmedCardIds],
				}),
			};
			updateBoard(boardId, (b) => ({
				...b,
				stories: b.stories.map((s) => (s.id === story.id ? { ...s, pages: s.pages.toSpliced(index + 1, 0, page) } : s)),
			}));
			return page;
		},

		updatePage(
			boardId: string,
			pageId: string,
			patch: Partial<Pick<StoryPage, "name" | "description" | "descriptionPosition" | "descriptionSize">>,
		): void {
			updateBoard(boardId, (b) => mapPages(b, (p) => (p.id === pageId ? { ...p, ...patch } : p)));
		},

		/** Deletes a page; its cards and drawings stay on the board. A story's last page can't be deleted. */
		removePage(boardId: string, pageId: string): void {
			updateBoard(boardId, (b) => ({
				...b,
				stories: b.stories.map((s) => (s.pages.length > 1 ? { ...s, pages: s.pages.filter((p) => p.id !== pageId) } : s)),
			}));
		},

		/** Shows a card of the page faded, out of focus, or in focus again. */
		setDimmed(boardId: string, pageId: string, cardId: string, dimmed: boolean): void {
			updateBoard(boardId, (b) =>
				mapPages(b, (p) => {
					if (p.id !== pageId || !p.cardIds.includes(cardId)) return p;
					const others = p.dimmedCardIds.filter((id) => id !== cardId);
					return { ...p, dimmedCardIds: dimmed ? [...others, cardId] : others };
				}),
			);
		},

		/** Shows one of the board's cards or drawings on the page too. */
		showOnPage(boardId: string, pageId: string, itemId: string): void {
			updateBoard(boardId, (b) => {
				const key = b.cards.some((c) => c.id === itemId) ? "cardIds" : b.drawings.some((d) => d.id === itemId) ? "drawingIds" : null;
				if (!key) return b;
				return mapPages(b, (p) => (p.id === pageId && !p[key].includes(itemId) ? { ...p, [key]: [...p[key], itemId] } : p));
			});
		},

		/** Adds a new card for the entity at (x, y), on top of the board's other cards — and shown on the page `pageId`. */
		addCard(boardId: string, entityId: string, x: number, y: number, pageId?: string): CanvasCard {
			const card: CanvasCard = { id: ulid(), entityId, x, y, ...DEFAULT_CARD_SIZE };
			updateBoard(boardId, (b) => withCard(b, card, pageId));
			return card;
		},

		/**
		 * Creates an entity of type `typeId` named `name` and links it with the entity of the card `sourceCardId`
		 * through `link` (seen from that entity; see linkOnBoard, which also places its card). It gets the type's
		 * template as description and the source entity's tags (it belongs to the same set). One change, so one
		 * undo step; null (and no change) if they don't fit together.
		 */
		addLinkedEntity(sourceCardId: string, link: Link, typeId: string, name: string, pageId?: string): { entity: Entity; card: CanvasCard } | null {
			const type = data.types.find((t) => t.id === typeId);
			const sourceEntityId = data.boards.flatMap((b) => b.cards).find((c) => c.id === sourceCardId)?.entityId;
			const sourceEntity = data.entities.find((e) => e.id === sourceEntityId);
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
			const linked = linkOnBoard({ ...data, entities: [...data.entities, entity] }, sourceCardId, link, entity, pageId);
			if (!linked) return null;
			change(linked.data);
			return { entity: linked.data.entities.find((e) => e.id === entity.id)!, card: linked.card }; // with its reference, if it holds it
		},

		/** Links an existing entity with the entity of the card `sourceCardId` through `link`, showing its card
		 * there (see linkOnBoard); one change. Answers that card, or null (and no change) if they don't fit together. */
		linkEntity(sourceCardId: string, link: Link, otherId: string, pageId?: string): CanvasCard | null {
			const other = data.entities.find((e) => e.id === otherId);
			const linked = other && linkOnBoard(data, sourceCardId, link, other, pageId);
			if (!linked) return null;
			change(linked.data);
			return linked.card;
		},

		/** Creates an entity of type `typeId` named `name`, with `tags` and the type's template as description, and its
		 * card on the board at the first free spot from `at` (also on story page `pageId`); one change. */
		addEntityWithCard(boardId: string, typeId: string, name: string, at: Point, pageId?: string, tags: readonly string[] = []): { entity: Entity; card: CanvasCard } | null {
			const type = data.types.find((t) => t.id === typeId);
			const board = data.boards.find((b) => b.id === boardId);
			if (!type || !board) return null;
			const entity: Entity = { id: ulid(), typeId, name: name.trim(), content: "", description: type.contentTemplate, tags: parseTags(tags.join(",")), values: {} };
			const card: CanvasCard = { id: ulid(), entityId: entity.id, ...freeSpot(at, board.cards, DEFAULT_CARD_SIZE), ...DEFAULT_CARD_SIZE };
			change({
				...data,
				entities: [...data.entities, entity],
				boards: data.boards.map((b) => (b.id === boardId ? withCard(b, card, pageId) : b)),
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
			const move = (d: Drawing): Drawing =>
				hasRect(d) ? { ...d, x: d.x + dx, y: d.y + dy } : { ...d, points: d.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
			updateBoard(boardId, (b) => ({
				...b,
				cards: b.cards.map((c) => (cards.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c)),
				drawings: b.drawings.map((d) => (drawings.has(d.id) ? move(d) : d)),
			}));
		},

		resizeCard(cardId: string, width: number, height: number): void {
			const size = { width: Math.max(MIN_CARD_SIZE.width, width), height: Math.max(MIN_CARD_SIZE.height, height) };
			updateCardBoard(cardId, (b) => ({ ...b, cards: b.cards.map((c) => (c.id === cardId ? { ...c, ...size } : c)) }));
		},

		/** Takes the card off its board; the entity itself stays. With `pageId`, only off that story page:
		 * it stays on the board. */
		removeCard(cardId: string, pageId?: string): void {
			updateCardBoard(cardId, (b) => takeOff(b, "cards", cardId, pageId));
		},

		/** With `pageId` (a story page), the drawing is shown on that page. */
		addDrawing(boardId: string, drawing: NewDrawing, pageId?: string): Drawing {
			const added = { ...drawing, id: ulid() } as Drawing;
			updateBoard(boardId, (b) =>
				mapPages({ ...b, drawings: [...b.drawings, added] }, (p) => (p.id === pageId ? { ...p, drawingIds: [...p.drawingIds, added.id] } : p)),
			);
			return added;
		},

		/** Replaces the drawing with the same id (on whichever board or library drawing it is). */
		replaceDrawing(drawing: Drawing): void {
			const replace = (drawings: Drawing[]) => drawings.map((d) => (d.id === drawing.id ? drawing : d));
			if (updateLibraryHolding(drawing.id, (item) => ({ ...item, drawings: replace(item.drawings) }))) return;
			updateDrawingBoard(drawing.id, (b) => ({ ...b, drawings: replace(b.drawings) }));
		},

		/** Like removeCard: with `pageId`, only off that page. */
		removeDrawing(drawingId: string, pageId?: string): void {
			if (updateLibraryHolding(drawingId, (item) => ({ ...item, drawings: item.drawings.filter((d) => d.id !== drawingId) }))) return;
			updateDrawingBoard(drawingId, (b) => takeOff(b, "drawings", drawingId, pageId));
		},

		/**
		 * Replaces each drawing named in `pieces` with its pieces, where it was (no pieces remove it), all in one change:
		 * what the eraser leaves of pen strokes. The pieces are shown on the story pages the drawing was on.
		 */
		splitDrawings(pieces: ReadonlyMap<string, readonly NewDrawing[]>): void {
			if (pieces.size === 0) return;
			const added = new Map([...pieces].map(([id, list]) => [id, list.map((d) => ({ ...d, id: ulid() }) as Drawing)]));
			const split = (drawings: Drawing[]) => drawings.flatMap((d) => added.get(d.id) ?? [d]);
			const ids = (drawingIds: string[]) => drawingIds.flatMap((id) => added.get(id)?.map((d) => d.id) ?? [id]);
			change({
				...data,
				boards: data.boards.map((b) => mapPages({ ...b, drawings: split(b.drawings) }, (p) => ({ ...p, drawingIds: ids(p.drawingIds) }))),
				library: data.library.map((item) => ({ ...item, drawings: split(item.drawings) })),
			});
		},

		/** Adds an empty drawing to the library. */
		addLibraryDrawing(name: string): LibraryDrawing {
			const item: LibraryDrawing = { id: ulid(), name: name.trim() || `Drawing ${data.library.length + 1}`, tags: [], drawings: [] };
			change({ ...data, library: [...data.library, item] });
			return item;
		},

		/** Renames the library drawing or sets its tags; an empty name is ignored. */
		updateLibraryDrawing(libraryId: string, patch: Partial<Pick<LibraryDrawing, "name" | "tags">>): void {
			const name = patch.name?.trim();
			change({
				...data,
				library: data.library.map((item) =>
					item.id === libraryId
						? { ...item, ...(name && { name }), ...(patch.tags && { tags: parseTags(patch.tags.join(",")) }) }
						: item,
				),
			});
		},

		/** Deletes the library drawing, and with it every place it's used on a board (of every story page too). */
		deleteLibraryDrawing(libraryId: string): void {
			change({
				...data,
				library: data.library.filter((item) => item.id !== libraryId),
				boards: data.boards.map((b) =>
					b.drawings
						.filter((d) => isSymbol(d) && d.libraryId === libraryId)
						.reduce((board, d) => takeOff(board, "drawings", d.id), b),
				),
			});
		},

		/** Adds a shape, line, text, pen stroke or image to the library drawing. A placed library drawing is not added:
		 * library drawings don't contain each other. */
		addToLibraryDrawing(libraryId: string, drawing: NewDrawing): Drawing {
			const added = { ...drawing, id: ulid() } as Drawing;
			if (isSymbol(added)) return added;
			change({
				...data,
				library: data.library.map((item) => (item.id === libraryId ? { ...item, drawings: [...item.drawings, added] } : item)),
			});
			return added;
		},

		/** How often the library drawing is placed on boards, and on how many boards. */
		libraryUses(libraryId: string): { count: number; boards: number } {
			const counts = data.boards.map((b) => b.drawings.filter((d) => isSymbol(d) && d.libraryId === libraryId).length);
			return { count: counts.reduce((sum, n) => sum + n, 0), boards: counts.filter((n) => n > 0).length };
		},

		/** Pan and zoom are saved, but not part of the undo history. */
		setViewport(boardId: string, viewport: Viewport): void {
			data = withBoard(boardId, (b) => ({ ...b, viewport: { ...viewport, zoom: clampZoom(viewport.zoom) } }));
			save();
		},

		/** Adds a frame showing `rect`, in a frame's shape (see frameShape), and lets the page `pageId` be seen in it; one
		 * change. */
		addFrame(boardId: string, name: string, rect: Rect, pageId: string): ViewFrame | null {
			const board = data.boards.find((b) => b.id === boardId);
			if (!board) return null;
			const frame: ViewFrame = {
				id: ulid(),
				name: name.trim() || `Frame ${board.frames.length + 1}`,
				...frameShape({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }),
			};
			updateBoard(boardId, (b) => withFrame({ ...b, frames: [...b.frames, frame] }, frame.id, pageId));
			return frame;
		},

		/** Renames, moves or resizes a frame; an empty name is ignored, the frame keeps a frame's shape (its height
		 * follows the width, see frameShape). */
		updateFrame(boardId: string, frameId: string, patch: Partial<Omit<ViewFrame, "id">>): void {
			const name = patch.name?.trim();
			updateBoard(boardId, (b) => ({
				...b,
				frames: b.frames.map((f) => (f.id === frameId ? frameShape({ ...f, ...patch, name: name || f.name }) : f)),
			}));
		},

		/** Deletes a frame; the pages seen in it are then seen in the board's frame. */
		removeFrame(boardId: string, frameId: string): void {
			updateBoard(boardId, (b) =>
				mapPages({ ...b, frames: b.frames.filter((f) => f.id !== frameId) }, (p) => (p.frameId === frameId ? { ...p, frameId: null } : p)),
			);
		},

		/** Lets the page `pageId` be seen in one of the board's frames, or in the board's own (null). */
		setFrame(boardId: string, frameId: string | null, pageId: string): void {
			updateBoard(boardId, (b) => (frameId === null || b.frames.some((f) => f.id === frameId) ? withFrame(b, frameId, pageId) : b));
		},

		/** Moves or resizes the board's own frame, in a frame's shape (see frameShape). */
		setViewFrame(boardId: string, rect: Rect): void {
			updateBoard(boardId, (b) => ({ ...b, viewFrame: frameShape({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }) }));
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
					t.properties.filter((p) => p.reference?.typeIds.includes(typeId)).map((p) => `${t.name}.${p.name}`),
				);
		},
	};
}
