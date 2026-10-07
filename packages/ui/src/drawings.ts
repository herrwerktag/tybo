/** Geometry for drawings on the canvas (shapes, lines, text, pen), in world coordinates. */

import type { Point, Rect } from "@bekbon/core";
import { isBox, isImage, type Drawing, type ImageDrawing, type PathDrawing } from "@bekbon/core";

/** The canvas tools: select (and move, resize, edit) or draw one kind of drawing. */
export type Tool = "select" | "rect" | "ellipse" | "line" | "arrow" | "text" | "pen";

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
	if (isBox(drawing) || isImage(drawing)) return { ...drawing, x: drawing.x + dx, y: drawing.y + dy };
	return { ...drawing, points: (drawing as PathDrawing).points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
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
 * Moves one corner of an image by (dx, dy) while the opposite corner stays put, keeping the aspect ratio: the
 * side dragged further decides the size. It never flips, and neither side gets smaller than MIN_BOX_SIZE.
 */
export function resizeImage(image: ImageDrawing, corner: Corner, dx: number, dy: number): ImageDrawing {
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

/** Where a new image goes: centered on `center`, at its own size or scaled down to MAX_IMAGE_SIZE. */
export function imageRect(center: Point, naturalWidth: number, naturalHeight: number): Rect {
	const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(naturalWidth, naturalHeight));
	const width = Math.max(MIN_BOX_SIZE, naturalWidth * scale);
	const height = Math.max(MIN_BOX_SIZE, naturalHeight * scale);
	return { x: center.x - width / 2, y: center.y - height / 2, width, height };
}

/** Moves one end of a line or arrow. */
export function moveEndpoint(line: PathDrawing, index: 0 | 1, dx: number, dy: number): PathDrawing {
	return { ...line, points: line.points.map((p, i) => (i === index ? { x: p.x + dx, y: p.y + dy } : p)) };
}

/** The smallest box containing the drawing. */
export function drawingBounds(drawing: Drawing): Rect {
	if (isBox(drawing) || isImage(drawing)) return { x: drawing.x, y: drawing.y, width: drawing.width, height: drawing.height };
	const xs = drawing.points.map((p) => p.x);
	const ys = drawing.points.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Drops pen points closer than `minDistance` to the previous kept point; the last point is always kept. */
export function simplifyStroke(points: readonly Point[], minDistance = 2): Point[] {
	if (points.length <= 2) return [...points];
	const kept: Point[] = [points[0]!];
	for (const p of points.slice(1, -1)) {
		const last = kept[kept.length - 1]!;
		if (Math.hypot(p.x - last.x, p.y - last.y) >= minDistance) kept.push(p);
	}
	kept.push(points[points.length - 1]!);
	return kept;
}

const round = (n: number) => Math.round(n * 10) / 10;
const fmt = (p: Point) => `${round(p.x)},${round(p.y)}`;

/** SVG path data through the points: straight segments, or smoothed through the midpoints for pen strokes. */
export function strokePath(points: readonly Point[], smooth: boolean): string {
	if (points.length === 0) return "";
	if (!smooth || points.length < 3) return `M ${points.map(fmt).join(" L ")}`;
	let d = `M ${fmt(points[0]!)}`;
	for (let i = 1; i < points.length - 1; i++) {
		const p = points[i]!;
		const next = points[i + 1]!;
		d += ` Q ${fmt(p)} ${fmt({ x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 })}`;
	}
	return `${d} L ${fmt(points[points.length - 1]!)}`;
}

const ARROW_LENGTH = 12;
const ARROW_HALF_WIDTH = 6;

/** For an arrow from `from` to `to`: where the line stops (the arrowhead's base) and the arrowhead triangle. */
export function arrowGeometry(from: Point, to: Point): { lineEnd: Point; head: string } {
	const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
	const ux = (to.x - from.x) / length;
	const uy = (to.y - from.y) / length;
	const base = { x: to.x - ux * Math.min(ARROW_LENGTH, length), y: to.y - uy * Math.min(ARROW_LENGTH, length) };
	const left = { x: base.x - uy * ARROW_HALF_WIDTH, y: base.y + ux * ARROW_HALF_WIDTH };
	const right = { x: base.x + uy * ARROW_HALF_WIDTH, y: base.y - ux * ARROW_HALF_WIDTH };
	return { lineEnd: base, head: `${fmt(to)} ${fmt(left)} ${fmt(right)}` };
}
