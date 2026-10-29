import type { Rect } from "../../../shared/core/index.js";
import { CLICK_TOLERANCE, el, trackPointer } from "../../../shared/ui/index.js";
import type { Store } from "../../../legacy/core/store.js";
import { snapToGrid } from "../../data/core.js";
import { FRAME_ASPECT, MIN_FRAME_SIZE, type Board } from "../core.js";
import { text } from "../texts.js";

/**
 * Editor, while editing the frame: the board's frame as an outline on the canvas, at the zoom `view.zoom`. It is moved
 * by its name (a click there goes to it, see `view.goTo`) and resized at its corner, snapped to the grid; only those
 * react to the pointer.
 */
export function frameEditor(store: Store, view: { board: () => Board; zoom: () => number; goTo: (frame: Rect) => void }) {
	const { board } = view;
	const element = el("div", { className: "view-frames" });
	/** Whether the frame is shown (see render). */
	let shown = false;

	function placeFrame(node: HTMLElement, { x, y, width, height }: { x: number; y: number; width: number; height: number }): void {
		Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
	}

	/** Shows the frame while `editing` it, or not. */
	function render(editing: boolean): void {
		shown = editing;
		element.replaceChildren(...(editing ? [frameElement(board().viewFrame)] : []));
	}

	/** Moves or resizes the board's frame. */
	function saveFrame({ x, y, width, height }: Rect): void {
		store.setViewFrame(board().id, { x, y, width, height });
		render(shown);
	}

	function frameElement(frame: Rect): HTMLElement {
		const node = el("div", { className: "view-frame" });
		placeFrame(node, frame);
		const label = el("div", { className: "view-frame-label", title: text.frameHandle }, text.boardFrame);
		label.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const zoom = view.zoom();
			const at = (dx: number, dy: number) => ({ x: snapToGrid(frame.x + dx / zoom), y: snapToGrid(frame.y + dy / zoom) });
			trackPointer(
				e,
				(dx, dy) => placeFrame(node, { ...frame, ...at(dx, dy) }),
				(dx, dy) => {
					if (Math.hypot(dx, dy) < CLICK_TOLERANCE) return view.goTo(frame);
					saveFrame({ ...frame, ...at(dx, dy) });
				},
			);
		});
		const resize = el("div", { className: "card-resize", title: text.resize });
		resize.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const zoom = view.zoom();
			// It keeps a frame's shape: the width follows the pointer across or (if moved more that way) down, on the grid.
			const size = (dx: number, dy: number) => {
				const along = Math.abs(dx) >= Math.abs(dy * FRAME_ASPECT) ? dx : dy * FRAME_ASPECT;
				const width = Math.max(MIN_FRAME_SIZE.width, snapToGrid(frame.width + along / zoom));
				return { width, height: width / FRAME_ASPECT };
			};
			trackPointer(
				e,
				(dx, dy) => placeFrame(node, { ...frame, ...size(dx, dy) }),
				(dx, dy) => saveFrame({ ...frame, ...size(dx, dy) }),
			);
		});
		node.append(label, resize);
		return node;
	}

	return { element, render, save: saveFrame };
}
