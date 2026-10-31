import type { Point, Rect } from "../../../shared/core/index.js";
import { CLICK_TOLERANCE, trackPointer, wheelGesture } from "../../../shared/ui/index.js";
import { GRID_SIZE } from "../../data/core.js";
import { defaultViewport, fitRect, screenToWorld, snapZoom, stepZoom, zoomAt, type Board, type Viewport, type BoardStore } from "../core.js";

/** How long the pan/zoom takes to move somewhere else, in ms. */
const PAN_ANIMATION = 450;
/** How long scroll/pinch zooming must pause before the zoom settles on the nearest 10% step, and how long that takes, in ms. */
const ZOOM_SETTLE_DELAY = 150;
const ZOOM_SETTLE_ANIMATION = 120;
/** How long panning and zooming must pause before the pan/zoom is saved, in ms. */
const SAVE_DELAY = 250;
/** Room (screen px) around a frame the editor goes to. */
const FIT_MARGIN = 48;

const prefersReducedMotion = (): boolean => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export interface ViewportControl {
	/** The pan/zoom now. */
	readonly current: Viewport;
	/** A point on the screen (client coordinates) on the board. */
	toWorld(clientX: number, clientY: number): Point;
	/** Shows the board now chosen from where it's seen from (see `homeViewport`). */
	show(): void;
	/** Pans/zooms to `next` at once, and saves it soon. */
	set(next: Viewport): void;
	/** One 10% step in (1) or out (-1), around the canvas center. */
	zoomStep(direction: 1 | -1): void;
	/** Pans just enough to bring a rectangle (world coordinates) into view, with a little room around it. */
	reveal(rect: Rect): void;
	/** Editor: moves to show the whole frame, with some room around it, and keeps it for the board. */
	goTo(frame: Rect): void;
	/** The viewer fits what's shown again; the editor goes back to the default pan/zoom. */
	reset(): void;
	/** Saves a scheduled change right away, e.g. before switching boards. */
	flush(): void;
	/** Pans the board along with the pointer from this press; `onClick` when it didn't move. */
	pan(e: PointerEvent, onClick: () => void): void;
}

/**
 * The pan and zoom of the canvas: moves `layer` and the grid on `surface`, shows the zoom in `zoomLabel`, and pans and
 * zooms on the wheel (see wheelGesture). The editor keeps one pan/zoom per board, saved once it settles; the viewer
 * fits the board's frame into the screen, again whenever the screen changes size until panned or zoomed, and never saves.
 */
export function viewportControl(
	store: BoardStore,
	{
		readOnly,
		surface,
		layer,
		zoomLabel,
		board,
		onZoom,
	}: {
		readOnly: boolean;
		surface: HTMLElement;
		layer: HTMLElement;
		zoomLabel: HTMLElement;
		/** The board shown. */
		board: () => Board;
		/** After the zoom changed (what keeps its screen size draws anew). */
		onZoom: () => void;
	},
): ViewportControl {
	/** The viewer fits what's shown once the canvas is laid out (see homeViewport); the editor has the board's. */
	let viewport: Viewport = readOnly ? defaultViewport() : { ...board().viewport };
	/** Viewer only: whether it shows what's shown as fitted (see homeViewport), not panned or zoomed since — then it
	 * fits it again when the screen changes size. */
	let fitted = readOnly;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** Settles scroll/pinch zooming on a step once it pauses (see zoomSmoothly). */
	let zoomSettleTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingSave: (() => void) | null = null;
	let animation = 0;
	/** The zoom `onZoom` was last called for. */
	let drawnZoom = viewport.zoom;

	/** Where the board is seen from: in the viewer, its frame fitted into the screen (as it is while the canvas
	 * isn't laid out); in the editor, the board's pan/zoom. */
	function homeViewport(): Viewport {
		if (!readOnly) return { ...board().viewport };
		const { clientWidth: width, clientHeight: height } = surface;
		if (width === 0 || height === 0) return viewport;
		return fitRect(board().viewFrame, width, height);
	}

	function apply(): void {
		layer.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
		const grid = GRID_SIZE * viewport.zoom;
		surface.style.backgroundSize = `${grid}px ${grid}px`;
		// Each dot is drawn in the middle of its tile: shift by half a tile, so the dots are where cards snap to.
		surface.style.backgroundPosition = `${viewport.x - grid / 2}px ${viewport.y - grid / 2}px`;
		zoomLabel.textContent = `${Math.round(viewport.zoom * 100)}%`;
		if (viewport.zoom !== drawnZoom) {
			drawnZoom = viewport.zoom;
			onZoom();
		}
	}

	/** Panning and zooming fire many events; save once they settle. */
	function saveSoon(next: Viewport = viewport): void {
		if (readOnly) return; // the viewer never saves pan or zoom
		clearTimeout(saveTimer);
		const id = board().id;
		pendingSave = () => {
			pendingSave = null;
			store.setViewport(id, next);
		};
		saveTimer = setTimeout(() => pendingSave?.(), SAVE_DELAY);
	}

	function stopAnimation(): void {
		cancelAnimationFrame(animation);
	}

	/** Shows what's shown fitted again (viewer) or the board's pan/zoom (editor). */
	function home(): void {
		stopAnimation();
		fitted = readOnly;
		viewport = homeViewport();
		apply();
	}

	/** Moves the pan/zoom smoothly to `target` (at once if the user prefers less motion), keeping the canvas
	 * center on a straight path, and saves it. */
	function moveTo(target: Viewport): void {
		stopAnimation();
		saveSoon(target);
		const from = viewport;
		if (prefersReducedMotion()) {
			viewport = target;
			return apply();
		}
		const cx = surface.clientWidth / 2;
		const cy = surface.clientHeight / 2;
		const center = (v: Viewport) => ({ x: (cx - v.x) / v.zoom, y: (cy - v.y) / v.zoom });
		const a = center(from);
		const b = center(target);
		const start = performance.now();
		const frame = (now: number) => {
			const t = Math.min(1, (now - start) / PAN_ANIMATION);
			const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in and out
			const zoom = from.zoom + (target.zoom - from.zoom) * e;
			const x = a.x + (b.x - a.x) * e;
			const y = a.y + (b.y - a.y) * e;
			viewport = t < 1 ? { x: cx - x * zoom, y: cy - y * zoom, zoom } : target;
			apply();
			if (t < 1) animation = requestAnimationFrame(frame);
		};
		animation = requestAnimationFrame(frame);
	}

	function set(next: Viewport): void {
		stopAnimation();
		fitted = false;
		viewport = next;
		apply();
		saveSoon();
	}

	/** Scroll/pinch zooming follows the gesture smoothly; once it pauses, the zoom eases to the nearest step around
	 * the same point (at once if the user prefers less motion). */
	function zoomSmoothly(factor: number, sx: number, sy: number): void {
		set(zoomAt(viewport, viewport.zoom * factor, sx, sy));
		clearTimeout(zoomSettleTimer);
		zoomSettleTimer = setTimeout(() => {
			const from = viewport.zoom;
			const target = snapZoom(from);
			if (target === from) return;
			if (prefersReducedMotion()) return set(zoomAt(viewport, target, sx, sy));
			const start = performance.now();
			const frame = (now: number) => {
				const t = Math.min(1, (now - start) / ZOOM_SETTLE_ANIMATION);
				const e = 1 - (1 - t) ** 2; // ease out
				viewport = zoomAt(viewport, t < 1 ? from + (target - from) * e : target, sx, sy);
				apply();
				if (t < 1) animation = requestAnimationFrame(frame);
				else saveSoon();
			};
			stopAnimation();
			animation = requestAnimationFrame(frame);
		}, ZOOM_SETTLE_DELAY);
	}

	// A mouse wheel zooms around the pointer, as does a trackpad pinch; two-finger scrolling pans (see wheelGesture).
	surface.addEventListener(
		"wheel",
		(e) => {
			const gesture = wheelGesture(e);
			if ("zoom" in gesture) {
				e.preventDefault();
				const rect = surface.getBoundingClientRect();
				zoomSmoothly(gesture.zoom, e.clientX - rect.left, e.clientY - rect.top);
				return;
			}
			const body = (e.target as Element).closest(".card-body");
			if (body && body.scrollHeight > body.clientHeight) return; // let long card bodies scroll
			e.preventDefault();
			set({ ...viewport, x: viewport.x - gesture.pan.dx, y: viewport.y - gesture.pan.dy });
		},
		{ passive: false },
	);

	// The viewer fits what's shown once the canvas has a size, and again whenever it changes, until panned or zoomed.
	if (readOnly && typeof ResizeObserver !== "undefined") {
		new ResizeObserver(() => {
			if (!fitted) return;
			stopAnimation();
			viewport = homeViewport();
			apply();
		}).observe(surface);
	}

	apply();
	return {
		get current() {
			return viewport;
		},
		toWorld(clientX, clientY) {
			const rect = surface.getBoundingClientRect();
			return screenToWorld(viewport, clientX - rect.left, clientY - rect.top);
		},
		show: home,
		set,
		zoomStep(direction) {
			set(zoomAt(viewport, stepZoom(viewport.zoom, direction), surface.clientWidth / 2, surface.clientHeight / 2));
		},
		reveal(rect) {
			const width = surface.clientWidth;
			const height = surface.clientHeight;
			if (width === 0 || height === 0) return; // not laid out (yet)
			const margin = GRID_SIZE;
			const shift = (start: number, size: number, room: number) =>
				start < margin ? margin - start : start + size > room - margin ? Math.max(margin - start, room - margin - start - size) : 0;
			const { zoom } = viewport;
			const dx = shift(rect.x * zoom + viewport.x, rect.width * zoom, width);
			const dy = shift(rect.y * zoom + viewport.y, rect.height * zoom, height);
			if (dx === 0 && dy === 0) return;
			moveTo({ ...viewport, x: viewport.x + dx, y: viewport.y + dy });
		},
		goTo(frame) {
			const { clientWidth: width, clientHeight: height } = surface;
			if (width === 0 || height === 0) return; // not laid out (yet)
			moveTo(fitRect(frame, width, height, FIT_MARGIN));
		},
		reset() {
			if (!readOnly) return set(defaultViewport());
			home();
		},
		flush() {
			clearTimeout(zoomSettleTimer); // not to settle the zoom of what's shown next
			clearTimeout(saveTimer);
			pendingSave?.();
		},
		pan(e, onClick) {
			stopAnimation();
			const start = viewport;
			surface.classList.add("panning");
			trackPointer(
				e,
				(dx, dy) => {
					fitted = false;
					viewport = { ...start, x: start.x + dx, y: start.y + dy };
					apply();
				},
				(dx, dy) => {
					surface.classList.remove("panning");
					saveSoon();
					if (Math.hypot(dx, dy) < CLICK_TOLERANCE) onClick();
				},
				surface,
			);
		},
	};
}
