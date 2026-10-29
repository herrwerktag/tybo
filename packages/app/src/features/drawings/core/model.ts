import type { UnitKind } from "../../../shared/core/index.js";
import type { AppData } from "../../../legacy/core/model.js";
import { TYPE_COLORS } from "../../data/core.js";
import { withBoardList, type BoardList } from "../../boards/core.js";

/** Drawings on the boards: text boxes, areas and images, a list of each board's own (see `BoardList`). */
declare module "../../boards/core/model.js" {
	interface Board {
		/** Text boxes, groups and images, drawn behind the cards; later ones on top. */
		drawings: Drawing[];
	}
}

/** Colors for drawings: the type colors plus dark grey (for strong lines and text). */
export const DRAWING_COLORS: readonly { name: string; value: string }[] = [
	...TYPE_COLORS,
	{ name: "Dark", value: "#4a4a4a" },
];

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

/** The drawings as a list of each board's own. */
export const DRAWING_LIST: BoardList<Drawing> = {
	key: "drawings",
	normalize: (raw) => (Array.isArray(raw) ? raw.flatMap((d) => normalizeDrawing(d) ?? []) : []),
	move: (drawing, dx, dy) => ({ ...drawing, x: drawing.x + dx, y: drawing.y + dy }),
};

export const DRAWING_UNIT: UnitKind<AppData, Drawing> = {
	kind: "drawing",
	onBoard: true,
	lists: (data) => data.boards.map((board) => ({ items: board.drawings ?? [], boardId: board.id })),
	withList: (data, drawings, boardId) => withBoardList(data, "drawings", drawings, boardId),
	// A new board starts without drawings.
	settle: (data) => ({ ...data, boards: data.boards.map((board) => ({ ...board, drawings: board.drawings ?? [] })) }),
};
