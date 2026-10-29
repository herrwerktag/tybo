import type { Point, Rect } from "../../shared/core/index.js";
import { GRID_SIZE, TYPE_COLORS, snapToGrid } from "../../features/data/core/model.js";
import type { Viewport } from "./viewport.js";

export * from "../../features/data/core/model.js";

/** Colors for drawings: the type colors plus dark grey (for strong lines and text). */
export const DRAWING_COLORS: readonly { name: string; value: string }[] = [
	...TYPE_COLORS,
	{ name: "Dark", value: "#4a4a4a" },
];

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

/** A named canvas with its own cards and pan/zoom. */
export interface Board {
	id: string;
	name: string;
	/** Later cards are drawn on top. */
	cards: CanvasCard[];
	/** The editor's pan/zoom of the board; the viewer shows its frame instead. */
	viewport: Viewport;
	/** The board's frame, always there: the viewer shows the board in it. In a frame's shape (see frameShape). */
	viewFrame: Rect;
	/** Text boxes, groups and images, drawn behind the cards; later ones on top. */
	drawings: Drawing[];
}

export type TextSize = "s" | "m" | "l";
export const TEXT_SIZES: readonly TextSize[] = ["s", "m", "l"];

/**
 * A text box (a colored box with its text centered) or an area. An area is a named group: the cards and drawings lying
 * in it move along when it's moved; its text is the name.
 */
export interface BoxDrawing {
	id: string;
	kind: "textbox" | "area";
	x: number;
	y: number;
	width: number;
	height: number;
	/** A value from DRAWING_COLORS. */
	color: string;
	text: string;
	textSize: TextSize;
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

export type Drawing = BoxDrawing | ImageDrawing;

/** Text boxes and areas (as opposed to images). */
export function isBox(drawing: Drawing): drawing is BoxDrawing {
	return drawing.kind === "textbox" || drawing.kind === "area";
}

export function isArea(drawing: Drawing): drawing is BoxDrawing & { kind: "area" } {
	return drawing.kind === "area";
}

export function isImage(drawing: Drawing): drawing is ImageDrawing {
	return drawing.kind === "image";
}

export type NewDrawing = Omit<BoxDrawing, "id"> | Omit<ImageDrawing, "id">;

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

export interface AppData {
	// The types and entities come with the data feature (`EntityData`).
	/** Empty once the last board was deleted (a new workspace starts with one). */
	boards: Board[];
	// The features add their own parts (see `DataPart`).
}

