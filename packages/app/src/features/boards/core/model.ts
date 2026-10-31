import type { Point, Rect } from "../../../shared/core/index.js";
import { GRID_SIZE, snapToGrid } from "../../data/core.js";
import type { Viewport } from "./viewport.js";

/**
 * Boards: named canvases holding cards of the entities. Their part of the app's data is `boards`; what else a board
 * holds (e.g. drawings) the features on top add as lists of their own (see `BoardList`).
 */
declare module "../../../shared/core/data.js" {
	interface AppData {
		/** Empty once the last board was deleted (a new workspace starts with one). */
		boards: Board[];
	}
}

/**
 * An entity placed on the canvas, in world coordinates. An entity can have several cards. Its size follows from what
 * it shows: the editor measures it and saves it here, so exports and layouts know it too.
 */
export interface CanvasCard {
	id: string;
	entityId: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Frames have a screen's shape (16:9): what the viewer shows fills a screen, and frames look alike on every one. */
export const FRAME_ASPECT = 16 / 9;
export const MIN_FRAME_SIZE = { width: 192, height: 192 / FRAME_ASPECT } as const;

/** The rectangle in a frame's shape: as wide (at least MIN_FRAME_SIZE), from the same top left corner. */
export function frameShape<R extends Rect>(rect: R): R {
	const width = Math.max(MIN_FRAME_SIZE.width, rect.width);
	return { ...rect, width, height: width / FRAME_ASPECT };
}

/** The largest rectangle in a frame's shape inside `rect`, centered: the frame of what is seen there. */
export function frameInside(rect: Rect): Rect {
	const width = Math.min(rect.width, rect.height * FRAME_ASPECT);
	const height = width / FRAME_ASPECT;
	return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}

/** A named canvas with its own cards and pan/zoom. The features add their lists to it (see `BoardList`). */
export interface Board {
	id: string;
	name: string;
	/** Later cards are drawn on top. */
	cards: CanvasCard[];
	/** The editor's pan/zoom of the board; the viewer shows its frame instead. */
	viewport: Viewport;
	/** The board's frame, always there: the viewer shows the board in it. In a frame's shape (see frameShape). */
	viewFrame: Rect;
}

/**
 * A feature's own list on each board (e.g. its drawings), next to the cards: its field on `Board` (added with
 * `declare module`), how it's read from what was saved, and how one of its items moves along when several things on
 * the board are moved together.
 */
export interface BoardList<T extends { id: string } = any> {
	key: string;
	/** The list as the app holds it, of what was saved there: well-formed, the empty list when nothing is. */
	normalize(raw: unknown): T[];
	/** The item moved by (dx, dy) world units. */
	move(item: T, dx: number, dy: number): T;
}

/** The features' lists of a board as the storage holds them: each a list, an empty one where there's none. */
export function storedLists(lists: readonly BoardList[], board: Record<string, unknown>): Record<string, unknown[]> {
	return Object.fromEntries(lists.map(({ key }) => [key, Array.isArray(board[key]) ? (board[key] as unknown[]) : []]));
}

/**
 * Where a card of `size` goes from `start` (snapped to the grid): moved down a grid step at a time until it overlaps
 * none of `cards`, keeping one grid step of space.
 */
export function freeSpot(start: Point, cards: readonly Rect[], size: { width: number; height: number }): Point {
	const x = snapToGrid(start.x);
	const overlaps = (y: number) =>
		cards.some(
			(c) =>
				x < c.x + c.width + GRID_SIZE &&
				c.x < x + size.width + GRID_SIZE &&
				y < c.y + c.height + GRID_SIZE &&
				c.y < y + size.height + GRID_SIZE,
		);
	let y = snapToGrid(start.y);
	while (overlaps(y)) y += GRID_SIZE;
	return { x, y };
}

/** Where a card of `size` goes next to the card `source`: to its right, two grid steps away, at a free spot. */
export function placeBeside(source: Rect, cards: readonly Rect[], size: { width: number; height: number }): Point {
	return freeSpot({ x: source.x + source.width + 2 * GRID_SIZE, y: source.y }, cards, size);
}

/**
 * Where cards of these sizes go around the card `source`: the `right` ones in a column to its right, the `left` ones
 * in a column to its left, each two grid steps away, from its top down, at free spots clear of `cards` and each other.
 */
export function placeAround(
	source: Rect,
	cards: readonly Rect[],
	{ right, left }: { right: readonly { width: number; height: number }[]; left: readonly { width: number; height: number }[] },
): { right: Point[]; left: Point[] } {
	const taken = [...cards];
	const place = (size: { width: number; height: number }, x: number): Point => {
		const spot = freeSpot({ x, y: source.y }, taken, size);
		taken.push({ ...spot, ...size });
		return spot;
	};
	return {
		right: right.map((size) => place(size, source.x + source.width + 2 * GRID_SIZE)),
		left: left.map((size) => place(size, source.x - 2 * GRID_SIZE - size.width)),
	};
}
