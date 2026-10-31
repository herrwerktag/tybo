/** Points and rectangles in world coordinates (the canvas's, unscaled). */

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

/** Whether two rectangles overlap or touch at an edge. */
export const touches = (a: Rect, b: Rect): boolean =>
	a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

/** Spacing of the boards' grid, in world units: cards are placed and sized on it. */
export const GRID_SIZE = 24;

/** The nearest grid line to `value`. */
export function snapToGrid(value: number): number {
	return Math.round(value / GRID_SIZE) * GRID_SIZE;
}
