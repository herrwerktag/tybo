/** Pan and zoom of the canvas: a world point p is drawn at screen position p * zoom + (x, y). */
export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;

export function defaultViewport(): Viewport {
	return { x: 0, y: 0, zoom: 1 };
}

export function clampZoom(zoom: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
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
