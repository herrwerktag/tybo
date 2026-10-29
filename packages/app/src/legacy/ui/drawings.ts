/** Geometry for drawings on the canvas (text boxes, groups, images), in world coordinates. */

import type { Point, Rect } from "../core/index.js";
import type { Drawing } from "../core/index.js";

/** The canvas tools: select (and move, resize, edit), or draw a text box or a group. */
export type Tool = "select" | "textbox" | "area";

/** Boxes never get smaller than this, so they stay visible and grabbable. */
export const MIN_BOX_SIZE = 12;

/** A new image's longer side, in world units (smaller images keep their own size). */
export const MAX_IMAGE_SIZE = 480;

export type Corner = "nw" | "ne" | "sw" | "se";

/** The box spanned by two corners, whichever way it was dragged. */
export function normalizeRect(a: Point, b: Point): Rect {
	return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

export function moveDrawing<T extends Drawing>(drawing: T, dx: number, dy: number): T {
	return { ...drawing, x: drawing.x + dx, y: drawing.y + dy };
}

/**
 * Moves one corner by (dx, dy) while the opposite corner stays put. Dragging past the opposite corner flips the
 * box; it never gets smaller than MIN_BOX_SIZE (it grows away from the fixed corner instead).
 */
export function resizeBox<T extends Rect>(box: T, corner: Corner, dx: number, dy: number): T {
	const left = corner === "nw" || corner === "sw";
	const top = corner === "nw" || corner === "ne";
	const fixed = { x: left ? box.x + box.width : box.x, y: top ? box.y + box.height : box.y };
	const moved = { x: (left ? box.x : box.x + box.width) + dx, y: (top ? box.y : box.y + box.height) + dy };
	const rect = normalizeRect(fixed, moved);
	const width = Math.max(MIN_BOX_SIZE, rect.width);
	const height = Math.max(MIN_BOX_SIZE, rect.height);
	return {
		...box,
		x: moved.x < fixed.x ? fixed.x - width : fixed.x,
		y: moved.y < fixed.y ? fixed.y - height : fixed.y,
		width,
		height,
	};
}

/**
 * Moves one corner of an image by (dx, dy) while the opposite corner stays put, keeping
 * the aspect ratio: the side dragged further decides the size. It never flips, and neither side gets smaller than
 * MIN_BOX_SIZE.
 */
export function resizeImage<T extends Rect>(image: T, corner: Corner, dx: number, dy: number): T {
	const left = corner === "nw" || corner === "sw";
	const top = corner === "nw" || corner === "ne";
	const ratio = image.width / image.height;
	const scaleX = (image.width + (left ? -dx : dx)) / image.width;
	const scaleY = (image.height + (top ? -dy : dy)) / image.height;
	const scale = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
	const width = Math.max(image.width * scale, MIN_BOX_SIZE, MIN_BOX_SIZE * ratio);
	const height = width / ratio;
	return {
		...image,
		x: left ? image.x + image.width - width : image.x,
		y: top ? image.y + image.height - height : image.y,
		width,
		height,
	};
}

/** Where a new image goes: centered on `center`, at its own size or scaled down to
 * MAX_IMAGE_SIZE. */
export function imageRect(center: Point, naturalWidth: number, naturalHeight: number): Rect {
	const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(naturalWidth, naturalHeight));
	const width = Math.max(MIN_BOX_SIZE, naturalWidth * scale);
	const height = Math.max(MIN_BOX_SIZE, naturalHeight * scale);
	return { x: center.x - width / 2, y: center.y - height / 2, width, height };
}

/** The smallest box containing the drawing. */
export function drawingBounds(drawing: Drawing): Rect {
	return { x: drawing.x, y: drawing.y, width: drawing.width, height: drawing.height };
}

/**
 * What lies in an area: the cards and drawings whose middle is inside it (not the area itself). Areas inside it count,
 * and so does what lies in them.
 */
export function areaContents(
	area: Drawing & Rect,
	cards: readonly (Rect & { id: string })[],
	drawings: readonly Drawing[],
): { cardIds: Set<string>; drawingIds: Set<string> } {
	const inside = (r: Rect) => {
		const x = r.x + r.width / 2;
		const y = r.y + r.height / 2;
		return x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height;
	};
	return {
		cardIds: new Set(cards.filter(inside).map((c) => c.id)),
		drawingIds: new Set(drawings.filter((d) => d.id !== area.id && inside(drawingBounds(d))).map((d) => d.id)),
	};
}
