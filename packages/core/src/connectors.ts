/** Geometry for connector lines between canvas cards, in world coordinates. */

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type Side = "left" | "right" | "top" | "bottom";

const NORMALS: Record<Side, Point> = {
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
	top: { x: 0, y: -1 },
	bottom: { x: 0, y: 1 },
};

export function center(r: Rect): Point {
	return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** The candidate whose center is closest to the center of `from`. */
export function nearest<T extends Rect>(from: Rect, candidates: readonly T[]): T | undefined {
	const c = center(from);
	let best: T | undefined;
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const d = Math.hypot(center(candidate).x - c.x, center(candidate).y - c.y);
		if (d < bestDistance) {
			best = candidate;
			bestDistance = d;
		}
	}
	return best;
}

function sideMidpoint(r: Rect, side: Side): Point {
	switch (side) {
		case "left":
			return { x: r.x, y: r.y + r.height / 2 };
		case "right":
			return { x: r.x + r.width, y: r.y + r.height / 2 };
		case "top":
			return { x: r.x + r.width / 2, y: r.y };
		case "bottom":
			return { x: r.x + r.width / 2, y: r.y + r.height };
	}
}

/** How far facing sides must overlap for a straight line between them, so it doesn't hug a corner. */
const MIN_OVERLAP = 24;

/**
 * Where the line leaves `from` and enters `to`: when the facing sides overlap, both at the middle of the overlap,
 * so the line runs straight even between cards of different sizes; otherwise at the middle of each side.
 */
function anchors(from: Rect, to: Rect, fromSide: Side, toSide: Side): { start: Point; end: Point } {
	const start = sideMidpoint(from, fromSide);
	const end = sideMidpoint(to, toSide);
	const vertical = fromSide === "top" || fromSide === "bottom";
	const [low, high] = vertical
		? [Math.max(from.x, to.x), Math.min(from.x + from.width, to.x + to.width)]
		: [Math.max(from.y, to.y), Math.min(from.y + from.height, to.y + to.height)];
	if (high - low < MIN_OVERLAP) return { start, end };
	const along = (low + high) / 2;
	return vertical
		? { start: { ...start, x: along }, end: { ...end, x: along } }
		: { start: { ...start, y: along }, end: { ...end, y: along } };
}

/** Picks the facing sides: left/right when the cards are further apart horizontally than vertically, else top/bottom. */
export function facingSides(from: Rect, to: Rect): { fromSide: Side; toSide: Side } {
	const horizontalGap = Math.max(to.x - (from.x + from.width), from.x - (to.x + to.width));
	const verticalGap = Math.max(to.y - (from.y + from.height), from.y - (to.y + to.height));
	const a = center(from);
	const b = center(to);
	if (horizontalGap >= verticalGap) {
		return b.x >= a.x ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
	}
	return b.y >= a.y ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

export interface Connector {
	/** SVG path data: a cubic curve leaving and entering the cards at right angles. */
	path: string;
	/** Middle of the curve, for the label. */
	mid: Point;
	/** Arrowhead triangle at the target, as SVG polygon points; null without an arrow. */
	arrow: string | null;
}

const ARROW_LENGTH = 10;
const ARROW_HALF_WIDTH = 5;

export function connector(from: Rect, to: Rect, withArrow = true): Connector {
	const { fromSide, toSide } = facingSides(from, to);
	const { start, end } = anchors(from, to, fromSide, toSide);
	const n1 = NORMALS[fromSide];
	const n2 = NORMALS[toSide];
	// With an arrow, the line stops at its base, so the line's end doesn't poke through the arrowhead.
	const inset = withArrow ? ARROW_LENGTH : 0;
	const lineEnd = { x: end.x + n2.x * inset, y: end.y + n2.y * inset };
	const reach = Math.max(30, Math.hypot(lineEnd.x - start.x, lineEnd.y - start.y) / 2);
	const c1 = { x: start.x + n1.x * reach, y: start.y + n1.y * reach };
	const c2 = { x: lineEnd.x + n2.x * reach, y: lineEnd.y + n2.y * reach };
	const mid = {
		x: (start.x + 3 * c1.x + 3 * c2.x + lineEnd.x) / 8,
		y: (start.y + 3 * c1.y + 3 * c2.y + lineEnd.y) / 8,
	};
	// Arrow points into the target card, against its side's outward normal.
	const left = { x: lineEnd.x - n2.y * ARROW_HALF_WIDTH, y: lineEnd.y + n2.x * ARROW_HALF_WIDTH };
	const right = { x: lineEnd.x + n2.y * ARROW_HALF_WIDTH, y: lineEnd.y - n2.x * ARROW_HALF_WIDTH };
	const fmt = (p: Point) => `${round(p.x)},${round(p.y)}`;
	return {
		path: `M ${fmt(start)} C ${fmt(c1)} ${fmt(c2)} ${fmt(lineEnd)}`,
		mid,
		arrow: withArrow ? `${fmt(end)} ${fmt(left)} ${fmt(right)}` : null,
	};
}

const round = (n: number) => Math.round(n * 10) / 10;
