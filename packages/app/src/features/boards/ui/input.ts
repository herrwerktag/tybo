import { snapToGrid, touches, type Rect } from "../../../shared/core/index.js";
import { listenWhileConnected } from "../../../shared/ui/index.js";
import { DEFAULT_CARD_SIZE } from "../../data/core.js";
import type { CardPreview } from "../../data/ui.js";
import { screenToWorld, type Board, type BoardStore } from "../core.js";
import type { BoardItems, LayerView } from "./layer.js";
import { marquee } from "./marquee.js";
import { ENTITY_MIME } from "./panel.js";
import type { ViewportControl } from "./viewport.js";

/**
 * What pressing, dragging, dropping and pasting on the canvas's `surface` does, beyond its cards: Space + drag or
 * the middle button pans from anywhere; a layer's active tool takes a press; fingers pan and zoom, from cards too
 * (see `onTouch`); dragging the empty background frames cards and layer items to select them (the viewer pans
 * instead); entities dropped from the side panel get a card, and dropped or pasted files go to the layers. Registered
 * in this order, since the earlier capture listeners have to win.
 */
export function canvasInput(
	store: BoardStore,
	{
		readOnly,
		view,
		surface,
		layer,
		viewport,
		views,
		preview,
		board,
		cardRects,
		selection,
		setSelection,
		clearSelection,
		onTouch,
		onTap,
		onCardAdded,
	}: {
		readOnly: boolean;
		/** The whole canvas, for the keys and pasting. */
		view: HTMLElement;
		surface: HTMLElement;
		/** The board's layer inside `surface`, its empty background like the surface's. */
		layer: HTMLElement;
		viewport: ViewportControl;
		/** The features' layers on the canvas, by their key. */
		views: ReadonlyMap<string, LayerView>;
		preview: CardPreview;
		/** The board shown. */
		board: () => Board;
		/** Where the cards are now, by card id (see `canvas`). */
		cardRects: () => ReadonlyMap<string, Rect>;
		/** What's selected on the board, and selecting other things (see `canvas`). */
		selection: () => { [key: string]: Set<string> };
		setSelection: (items: BoardItems) => void;
		/** Selects nothing: no card, no layer's item. */
		clearSelection: () => void;
		/** A finger put on a card: true if the canvas does something else with it than pan and zoom (moves the card). */
		onTouch: (e: PointerEvent, card: HTMLElement) => boolean;
		/** A tap on a card (on `target` in it), or on the empty background (null). */
		onTap: (card: HTMLElement | null, target: Element) => void;
		/** After an entity dropped from the side panel got its card. */
		onCardAdded: () => void;
	},
): void {
	/** Whether Space is held: dragging then pans, wherever it starts. */
	let spaceHeld = false;
	function onSpace(e: KeyboardEvent): void {
		if (e.key !== " " || (e.target as Element).closest?.("input, select, textarea, [contenteditable]")) return;
		e.preventDefault(); // no scrolling, nor pressing a focused button
		spaceHeld = e.type === "keydown";
		surface.classList.toggle("space-pan", spaceHeld);
	}
	listenWhileConnected(view, "keydown", onSpace);
	listenWhileConnected(view, "keyup", onSpace);

	// The middle button, or Space + drag, pans from anywhere on the canvas: in the capture phase, registered first,
	// so it wins over cards, the layers and their tools.
	surface.addEventListener(
		"pointerdown",
		(e) => {
			if (e.button !== 1 && !(e.button === 0 && spaceHeld)) return;
			e.preventDefault();
			e.stopPropagation();
			pan(e);
		},
		{ capture: true },
	);

	// With a layer's tool active, pressing anywhere on the canvas except on a card (or the frame's name or corner)
	// uses it, e.g. starts a new drawing (in the capture phase, so it wins over panning and selecting).
	//
	// Otherwise a finger on the empty background or on a card pans the board, and a second one — wherever it lands —
	// zooms it; a tap is the click. So a card never moves under a finger that only meant to tap or pan (unless
	// `onTouch` takes it), and its buttons, the frame and the layers' items keep their own presses.
	surface.addEventListener(
		"pointerdown",
		(e) => {
			const target = e.target as Element;
			const onCanvas = !target.closest(".canvas-card, .view-frame");
			if (!readOnly && onCanvas && [...views.values()].some((view) => view.press(e))) return;
			if (e.pointerType !== "touch") return;
			const card = target.closest<HTMLElement>(".canvas-card[data-card-id]");
			if (!viewport.touching()) {
				if (card ? target.closest("button, a") : target !== surface && target !== layer) return;
				if (card && onTouch(e, card)) return e.stopPropagation();
			}
			e.stopPropagation();
			viewport.touch(e, () => onTap(card, target));
		},
		{ capture: true },
	);

	// Any drag, pan or zoom on the canvas closes the preview.
	surface.addEventListener("pointerdown", preview.hide, { capture: true });
	surface.addEventListener("wheel", preview.hide, { capture: true, passive: true });

	/** Pans the board along with the pointer from this press; a click without moving clears the selection. */
	function pan(e: PointerEvent): void {
		viewport.pan(e, () => {
			if (e.button !== 0) return;
			clearSelection();
		});
	}

	/** The frame dragged around cards and layer items to select them. */
	const frameDrag = marquee(surface);

	/**
	 * Drags a frame from this press: the cards and layer items it touches get selected (with
	 * Shift, added to the selection). A click without moving clears the selection.
	 */
	function frameSelect(e: PointerEvent): void {
		const adding = e.shiftKey;
		frameDrag.drag(e, (f) => {
			if (!f) {
				if (!adding) setSelection({});
				return;
			}
			const from = screenToWorld(viewport.current, f.x, f.y);
			const to = screenToWorld(viewport.current, f.x + f.width, f.y + f.height);
			const world = { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y };
			const items = adding ? selection() : {};
			const add = (key: string, id: string) => (items[key] ??= new Set()).add(id);
			const rects = cardRects();
			for (const c of board().cards) if (touches(world, rects.get(c.id) ?? c)) add("cards", c.id);
			for (const [key, view] of views) for (const id of view.touching(world)) add(key, id);
			setSelection(items);
		});
	}

	// Dragging the empty background frames cards and layer items to select them. The viewer (which has nothing to
	// select) pans instead; fingers have their own way (see above).
	surface.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 || e.pointerType === "touch" || (e.target !== surface && e.target !== layer)) return;
		if (readOnly) pan(e);
		else frameSelect(e);
	});

	/** Gives files to the layers, centered on a point (screen coordinates): true if one took any. */
	function dropFiles(files: FileList | undefined, clientX: number, clientY: number): boolean {
		const center = viewport.toWorld(clientX, clientY);
		const all = [...(files ?? [])];
		return all.length > 0 && [...views.values()].some((view) => view.drop(all, center));
	}

	// Drop entities from the side panel, or files for the layers, e.g. images (editor only).
	if (!readOnly) {
		surface.addEventListener("dragover", (e) => {
			if (!e.dataTransfer || ![ENTITY_MIME, "Files"].some((type) => e.dataTransfer!.types.includes(type))) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		});
		surface.addEventListener("drop", (e) => {
			if (dropFiles(e.dataTransfer?.files, e.clientX, e.clientY)) {
				e.preventDefault();
				return;
			}
			const world = viewport.toWorld(e.clientX, e.clientY);
			const entityId = e.dataTransfer?.getData(ENTITY_MIME);
			if (!entityId) return;
			e.preventDefault();
			// Drop so the pointer ends up on the card's header, on the grid.
			const x = snapToGrid(world.x - DEFAULT_CARD_SIZE.width / 2);
			store.addCard(board().id, entityId, x, snapToGrid(world.y - 16));
			onCardAdded();
		});
	}

	// Ctrl/⌘ + V with files on the clipboard, e.g. an image, gives them to the layers, in the middle of the view.
	// Pasting into a text field stays the text field's.
	if (!readOnly) {
		listenWhileConnected(view, "paste", (e) => {
			if ((e.target as Element).closest?.("input, select, textarea, [contenteditable]")) return;
			const rect = surface.getBoundingClientRect();
			if (dropFiles(e.clipboardData?.files, rect.left + rect.width / 2, rect.top + rect.height / 2)) e.preventDefault();
		});
	}
}
