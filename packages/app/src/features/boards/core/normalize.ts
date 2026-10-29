import { ulid, type Rect } from "../../../shared/core/index.js";
import type { AppData } from "../../../legacy/core/model.js";
import { frameShape, storedLists, type Board, type BoardList, type CanvasCard } from "./model.js";
import { clampZoom, defaultViewport, visibleRect, type Viewport } from "./viewport.js";

/** How large a screen is taken where none is at hand: the frame of a board saved before frames shows that much,
 * from the top left corner of its view, and a new board's frame is that large. */
export const REFERENCE_SCREEN = { width: 1280, height: 720 } as const;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The features' `lists` of a board, each as it reads what was saved there (of nothing, the empty list). */
function readLists(lists: readonly BoardList[], board?: object): Record<string, unknown[]> {
	return Object.fromEntries(lists.map(({ key, normalize }) => [key, normalize((board as Record<string, unknown> | undefined)?.[key])]));
}

/** A board without cards, its features' `lists` empty too. */
export function newBoard(name: string, lists: readonly BoardList[]): Board {
	const viewFrame = visibleRect(defaultViewport(), REFERENCE_SCREEN.width, REFERENCE_SCREEN.height);
	return { id: ulid(), name, cards: [], viewport: defaultViewport(), viewFrame, ...readLists(lists) } as unknown as Board;
}

function normalizeViewport(v: Partial<Viewport> | null | undefined): Viewport {
	return v && isNumber(v.x) && isNumber(v.y) && isNumber(v.zoom) ? { x: v.x, y: v.y, zoom: clampZoom(v.zoom) } : defaultViewport();
}

/**
 * Keeps only well-formed cards and viewport, and its features' `lists` as they read them; anything else falls back
 * to defaults. Cards and boards saved without an id get one. A board saved before frames gets its frame of its
 * pan/zoom. What was saved of stories is left out.
 */
function normalizeBoard(board: Partial<Board> | undefined, fallbackName: string, lists: readonly BoardList[]): Board {
	const cards = Array.isArray(board?.cards)
		? board.cards
				.filter(
					(c: Partial<CanvasCard>) =>
						typeof c.entityId === "string" && isNumber(c.x) && isNumber(c.y) && isNumber(c.width) && isNumber(c.height),
				)
				.map((c: CanvasCard) => ({ ...c, id: typeof c.id === "string" ? c.id : ulid() }))
		: [];
	const viewport = normalizeViewport(board?.viewport);
	const viewFrame: Rect | undefined = board?.viewFrame;
	return {
		id: typeof board?.id === "string" ? board.id : ulid(),
		name: typeof board?.name === "string" && board.name.trim() !== "" ? board.name : fallbackName,
		cards,
		viewport,
		// A board saved without its frame (before frames) gets one of its pan/zoom: the viewer showed the board so.
		viewFrame: frameShape(
			isObject(viewFrame) && [viewFrame.x, viewFrame.y, viewFrame.width, viewFrame.height].every(isNumber)
				? { x: viewFrame.x, y: viewFrame.y, width: viewFrame.width, height: viewFrame.height }
				: visibleRect(viewport, REFERENCE_SCREEN.width, REFERENCE_SCREEN.height),
		),
		...readLists(lists, board),
	} as unknown as Board;
}

/**
 * Reads the boards, including the single `canvas` saved by the version before boards existed. A workspace with
 * no entities yet (a new one, maybe with copied types) gets a first board; otherwise there may
 * be none, once the last one was deleted.
 */
export function normalizeBoards(data: Pick<AppData, "boards" | "entities"> & { canvas?: Partial<Board> }, lists: readonly BoardList[]): Board[] {
	const raw: Partial<Board>[] = Array.isArray(data.boards) ? data.boards : data.canvas ? [data.canvas] : [];
	const boards = raw.map((b, i) => normalizeBoard(b, `Board ${i + 1}`, lists));
	return boards.length > 0 || data.entities.length > 0 ? boards : [newBoard("Board 1", lists)];
}

/** The boards as the storage holds them, as far as they can be compared with this app's: boards without their
 * cards or `lists` get empty ones (the storage keeps none of those either). */
export function storedBoards(data: Pick<AppData, "boards">, lists: readonly BoardList[]): Board[] {
	const boards = Array.isArray(data.boards) ? data.boards.filter(isObject) : [];
	return boards.map(
		(board) =>
			({
				...board,
				cards: Array.isArray(board.cards) ? board.cards : [],
				...storedLists(lists, board as unknown as Record<string, unknown>),
			}) as Board,
	);
}

/** The boards without the cards of entities that are gone. */
export function pruneCards<D extends Pick<AppData, "boards" | "entities">>(data: D): D {
	const entities = new Set(data.entities.map((e) => e.id));
	return { ...data, boards: data.boards.map((b) => ({ ...b, cards: b.cards.filter((c) => entities.has(c.entityId)) })) };
}

/** The boards of `snapshot` (from the undo history) with the pan and zoom they have in `current`: undo and redo
 * leave the view as it is. */
export function keepViewports<D extends Pick<AppData, "boards">>(snapshot: D, current: D): D {
	const viewports = new Map(current.boards.map((b) => [b.id, b.viewport]));
	return { ...snapshot, boards: snapshot.boards.map((b) => ({ ...b, viewport: viewports.get(b.id) ?? b.viewport })) };
}
