/** Pan and zoom of the canvas: a world point p is drawn at screen position p * zoom + (x, y). */
export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;
/** Zoom steps per 100%: the zoom settles on 10%, 20%, … */
const ZOOM_STEPS = 10;

export function defaultViewport(): Viewport {
	return { x: 0, y: 0, zoom: 1 };
}

export function clampZoom(zoom: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The nearest zoom step, within the limits. */
export function snapZoom(zoom: number): number {
	return clampZoom(Math.round(zoom * ZOOM_STEPS) / ZOOM_STEPS);
}

/** The next zoom step in (1) or out (-1) from `zoom`, within the limits; from between two steps, the next one. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
	// A little slack, so a zoom a rounding error off a step counts as on it.
	const steps = zoom * ZOOM_STEPS;
	const next = direction > 0 ? Math.floor(steps + 1e-6) + 1 : Math.ceil(steps - 1e-6) - 1;
	return clampZoom(next / ZOOM_STEPS);
}

/** Converts a point relative to the canvas element into world coordinates. */
export function screenToWorld(viewport: Viewport, sx: number, sy: number): { x: number; y: number } {
	return { x: (sx - viewport.x) / viewport.zoom, y: (sy - viewport.y) / viewport.zoom };
}

/** Changes the zoom while keeping the world point under (sx, sy) in place. */
export function zoomAt(viewport: Viewport, zoom: number, sx: number, sy: number): Viewport {
	const z = clampZoom(zoom);
	const world = screenToWorld(viewport, sx, sy);
	return { x: sx - world.x * z, y: sy - world.y * z, zoom: z };
}
