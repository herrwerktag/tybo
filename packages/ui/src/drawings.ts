/** Geometry for drawings on the canvas (shapes, lines, text, pen), in world coordinates. */

import type { Point, Rect } from "@bekbon/core";
import { hasRect, type Drawing, type PathDrawing } from "@bekbon/core";

/** The canvas tools: select (and move, resize, edit), draw one kind of drawing, or erase pen strokes. */
export type Tool = "select" | "rect" | "ellipse" | "line" | "arrow" | "text" | "pen" | "eraser";

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
	if (hasRect(drawing)) return { ...drawing, x: drawing.x + dx, y: drawing.y + dy };
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
 * Moves one corner of an image (or a placed library drawing) by (dx, dy) while the opposite corner stays put, keeping
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

/** Where a new image (or placed library drawing) goes: centered on `center`, at its own size or scaled down to
 * MAX_IMAGE_SIZE. */
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
	if (hasRect(drawing)) return { x: drawing.x, y: drawing.y, width: drawing.width, height: drawing.height };
	const xs = drawing.points.map((p) => p.x);
	const ys = drawing.points.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The smallest box containing all the drawings, or null when there are none. */
export function contentBounds(drawings: readonly Drawing[]): Rect | null {
	if (drawings.length === 0) return null;
	const boxes = drawings.map(drawingBounds);
	const x = Math.min(...boxes.map((b) => b.x));
	const y = Math.min(...boxes.map((b) => b.y));
	return {
		x,
		y,
		width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
		height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
	};
}

/**
 * The next pen point: `amount` of the way from the previous point to the pointer. Following the pointer only partly
 * evens out the hand's jitter, so freehand strokes come out smooth (lower amounts smooth more, but lag behind more).
 */
export function streamline(previous: Point, pointer: Point, amount = 0.5): Point {
	return { x: previous.x + (pointer.x - previous.x) * amount, y: previous.y + (pointer.y - previous.y) * amount };
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

/** How far the point is from the segment from `a` to `b`. */
function distanceToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * What's left of a stroke after the eraser moved from `from` to `to`: the stroke split into the parts more than
 * `radius` away from that path (parts too short to see are dropped), or null when the eraser didn't touch it.
 */
export function eraseStroke(points: readonly Point[], from: Point, to: Point, radius: number): Point[][] | null {
	// Long segments get points in between, so the eraser can cut them in the middle too; only the ones where a piece
	// ends are kept.
	const step = radius / 2;
	const dense = points.flatMap((p, i) => {
		const prev = points[i - 1];
		const n = prev ? Math.ceil(Math.hypot(p.x - prev.x, p.y - prev.y) / step) : 1;
		return Array.from({ length: n }, (_, k) => {
			const t = (k + 1) / n;
			return { point: prev ? { x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t } : p, original: k === n - 1 };
		});
	});
	const kept = dense.map(({ point }) => distanceToSegment(point, from, to) > radius);
	if (kept.every(Boolean)) return null;
	const pieces: Point[][] = [];
	dense.forEach(({ point, original }, i) => {
		if (!kept[i]) return;
		const starts = !kept[i - 1];
		if (starts) pieces.push([]);
		if (original || starts || !kept[i + 1]) pieces[pieces.length - 1]!.push(point);
	});
	return pieces.filter((piece) => piece.length >= 2);
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
