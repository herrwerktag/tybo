import type { Rect } from "../../../shared/core/index.js";
import { CLICK_TOLERANCE, el, trackPointer } from "../../../shared/ui/index.js";

/**
 * A frame dragged over `surface` to select what it touches, shown while dragging. `drag` follows the pointer from a
 * press and answers the frame (screen coordinates, relative to the surface) once it's let go, or null for a click.
 */
export function marquee(surface: HTMLElement): { drag(e: PointerEvent, onDone: (frame: Rect | null) => void): void } {
	const element = el("div", { className: "marquee", hidden: true });
	surface.append(element);
	return {
		drag(e, onDone) {
			const area = surface.getBoundingClientRect();
			const start = { x: e.clientX - area.left, y: e.clientY - area.top };
			const frame = (dx: number, dy: number): Rect => ({
				x: Math.min(start.x, start.x + dx),
				y: Math.min(start.y, start.y + dy),
				width: Math.abs(dx),
				height: Math.abs(dy),
			});
			trackPointer(
				e,
				(dx, dy) => {
					if (element.hidden && Math.hypot(dx, dy) < CLICK_TOLERANCE) return;
					const f = frame(dx, dy);
					element.hidden = false;
					Object.assign(element.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.width}px`, height: `${f.height}px` });
				},
				(dx, dy) => {
					const framed = !element.hidden;
					element.hidden = true;
					onDone(framed ? frame(dx, dy) : null);
				},
				surface,
			);
		},
	};
}
