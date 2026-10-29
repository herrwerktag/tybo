import type { Rect } from "../../../shared/core/index.js";
import { CLICK_TOLERANCE, el, readPreference, resizeHandle, trackPointer, wheelGesture, writePreference } from "../../../shared/ui/index.js";
import type { Store } from "../../../features.core.js";
import { DEFAULT_CARD_SIZE, GRID_SIZE, effectiveCardDisplay, referencedIds, snapToGrid, type Entity, type EntityType } from "../../data/core.js";
import { text as dataText } from "../../data/texts.js";
import { DETAILS_WIDTH_KEY, cardParts, cardSize, createCardPreview, entityDetails } from "../../data/ui/entity-card.js";
import { showEntityEditor } from "../../data/ui/entity-form.js";
import {
	defaultViewport,
	fitRect,
	frameInside,
	screenToWorld,
	snapZoom,
	stepZoom,
	visibleRect,
	zoomAt,
	type Board,
	type CanvasCard,
	type Viewport,
} from "../core.js";
import { text } from "../texts.js";
import { connectDialog, newEntityDialog } from "./dialogs.js";
import { frameEditor } from "./frame.js";
import { connectorLines, type Link } from "./lines.js";
import { ENTITY_MIME, entityPanel } from "./panel.js";
import { pickerDropdown, pickerLabel, renderPicker } from "./pickers.js";
import type { BoardExport, BoardItems, CanvasLayer } from "./layer.js";

const PANEL_COLLAPSED_KEY = "canvas-panel-collapsed";
/** The widths of the side panel and the details panel, if changed by dragging. */
export const PANEL_WIDTH_KEY = "canvas-panel-width";
const ACTIVE_BOARD_KEY = "canvas-active-board";
/** Whether the editor is editing the frames: only then are they shown, with their controls. */
const EDIT_FRAMES_KEY = "canvas-edit-frames";
/** How long the pan/zoom takes to move somewhere else, in ms. */
const PAN_ANIMATION = 450;
/** How long scroll/pinch zooming must pause before the zoom settles on the nearest 10% step, and how long that takes, in ms. */
const ZOOM_SETTLE_DELAY = 150;
const ZOOM_SETTLE_ANIMATION = 120;
/** Room (screen px) around a frame the editor goes to. */
const FIT_MARGIN = 48;

export interface CanvasOptions {
	readOnly: boolean;
	/** The features' layers on the board (see `CanvasLayer`), the first drawn lowest. */
	layers: readonly CanvasLayer[];
	/** The ways to export a board, offered in the editor (see `BoardExport`). */
	exports?: readonly BoardExport[];
}

/** Instead of the canvas while there's no board: a button that creates the first one and opens it. */
function firstBoardView(store: Store, options: CanvasOptions): HTMLElement {
	const view: HTMLElement = el(
		"section",
		{ className: "first-board" },
		el("p", {}, text.noBoardsYet),
		el(
			"button",
			{
				type: "button",
				className: "primary",
				onclick: () => {
					writePreference(ACTIVE_BOARD_KEY, store.addBoard(text.defaultBoardName(1)).id);
					view.replaceWith(canvasView(store, options));
				},
			},
			text.createFirstBoard,
		),
	);
	return view;
}

/**
 * The board canvas. With `readOnly` (the Viewer) it only displays: no side panel, no board editing,
 * no moving, resizing, removing or dropping cards, and pan/zoom are never saved. With `exports`, the editor offers
 * to export the current board.
 *
 * The viewer shows the board in its frame, fitted into the screen. The editor keeps one pan/zoom per board, and
 * shows the frame as an outline to move and resize.
 */
export function canvasView(store: Store, options: CanvasOptions): HTMLElement {
	if (store.data.boards.length === 0) return firstBoardView(store, options);
	const { readOnly, layers, exports = [] } = options;
	let boardId = readPreference(ACTIVE_BOARD_KEY) ?? "";
	const currentBoard = (): Board => store.data.boards.find((b) => b.id === boardId) ?? store.data.boards[0]!;
	boardId = currentBoard().id;

	/** The viewer fits what's shown once the canvas is laid out (see homeViewport); the editor has the board's. */
	let viewport: Viewport = readOnly ? defaultViewport() : { ...currentBoard().viewport };
	/** Viewer only: whether it shows what's shown as fitted (see homeViewport), not panned or zoomed since — then it
	 * fits it again when the screen changes size. */
	let fitted = readOnly;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** Settles scroll/pinch zooming on a step once it pauses (see zoomSmoothly). */
	let zoomSettleTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingSave: (() => void) | null = null;
	// Until opened or closed here, the panel starts collapsed on narrow screens, where it would leave the canvas
	// little room.
	const panelPreference = readPreference(PANEL_COLLAPSED_KEY);
	let panelCollapsed =
		panelPreference === null ? !!window.matchMedia?.("(max-width: 40rem)").matches : panelPreference === "true";

	const view = el("div", {
		className: readOnly ? "canvas-view read-only" : panelCollapsed ? "canvas-view panel-collapsed" : "canvas-view",
	});

	function setPanelCollapsed(collapsed: boolean): void {
		panelCollapsed = collapsed;
		writePreference(PANEL_COLLAPSED_KEY, String(collapsed));
		view.classList.toggle("panel-collapsed", collapsed);
		openPanelButton.ariaExpanded = String(!collapsed);
	}

	// Shown over the canvas only while the panel is collapsed (see CSS).
	const openPanelButton = el(
		"button",
		{
			type: "button",
			className: "panel-open",
			title: text.showEntities,
			ariaLabel: text.showEntities,
			ariaExpanded: String(!panelCollapsed),
			onclick: () => setPanelCollapsed(false),
		},
		"»",
	);

	const panel = entityPanel(store, { board: currentBoard, readOnly, onHide: () => setPanelCollapsed(true) });
	const renderPanel = panel.render;
	const layer = el("div", { className: "canvas-board" });
	const surface = el("div", { className: "canvas-surface" }, layer);
	const zoomLabel = el("span", { className: "zoom-label" });

	/** Where the board is seen from: in the viewer, its frame fitted into the screen (as it is while the canvas
	 * isn't laid out); in the editor, the board's pan/zoom. */
	function homeViewport(): Viewport {
		if (!readOnly) return { ...currentBoard().viewport };
		const { clientWidth: width, clientHeight: height } = surface;
		if (width === 0 || height === 0) return viewport;
		return fitRect(currentBoard().viewFrame, width, height);
	}

	/** Two or more cards and layer items selected together, to move at once (Shift+click, or a frame dragged
	 * around them); meanwhile neither the details nor an item's handles are shown. */
	let group: { [key: string]: Set<string> } | null = null;

	/** The features' layers on this canvas (see `CanvasLayer`), by their key; below the lines and cards. */
	const views = new Map(
		layers.map((layer) => {
			const view = layer.create({
				store,
				readOnly,
				boardId: () => boardId,
				zoom: () => viewport.zoom,
				toWorld: (clientX, clientY) => {
					const rect = surface.getBoundingClientRect();
					return screenToWorld(viewport, clientX - rect.left, clientY - rect.top);
				},
				captureTarget: () => surface,
				cardRects: () => cardRects,
				group: () => group?.[layer.key] ?? new Set(),
				// A card and a layer's item are never selected at the same time, nor two layers' items.
				onSelect: (id) => {
					if (!id) return;
					select(null);
					for (const [key, other] of views) if (key !== layer.key) other.deselect();
				},
				onGroupPress: (e, id) => {
					if (e.shiftKey) toggleSelected(layer.key, id);
					else dragGroup(e, { key: layer.key, id });
				},
				dragItems: (e, id, items) => dragGroup(e, { key: layer.key, id }, items),
				onToolChange: (active) => surface.classList.toggle("tool-active", active),
			});
			return [layer.key, view];
		}),
	);
	const deselectLayers = () => views.forEach((view) => view.deselect());
	const renderLayers = () => views.forEach((view) => view.render());
	/** The zoom the layers' selection handles were last drawn for (they keep their screen size). */
	let drawnZoom = viewport.zoom;

	function applyViewport(): void {
		layer.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
		const grid = GRID_SIZE * viewport.zoom;
		surface.style.backgroundSize = `${grid}px ${grid}px`;
		// Each dot is drawn in the middle of its tile: shift by half a tile, so the dots are where cards snap to.
		surface.style.backgroundPosition = `${viewport.x - grid / 2}px ${viewport.y - grid / 2}px`;
		zoomLabel.textContent = `${Math.round(viewport.zoom * 100)}%`;
		if (viewport.zoom !== drawnZoom) {
			drawnZoom = viewport.zoom;
			renderLayers();
		}
	}

	/** Panning and zooming fire many events; save once they settle. */
	function saveViewportSoon(next: Viewport = viewport): void {
		if (readOnly) return; // the viewer never saves pan or zoom
		clearTimeout(saveTimer);
		const id = boardId;
		pendingSave = () => {
			pendingSave = null;
			store.setViewport(id, next);
		};
		saveTimer = setTimeout(() => pendingSave?.(), 250);
	}

	/** Saves a scheduled viewport change right away, e.g. before switching boards. */
	function flushViewport(): void {
		clearTimeout(zoomSettleTimer); // not to settle the zoom of what's shown next
		clearTimeout(saveTimer);
		pendingSave?.();
	}

	function switchBoard(id: string): void {
		flushViewport();
		boardId = id;
		writePreference(ACTIVE_BOARD_KEY, id);
		show();
	}

	/** Shows the board now chosen, with its pan/zoom (see homeViewport). */
	function show(): void {
		stopAnimation();
		fitted = readOnly;
		viewport = homeViewport();
		group = null;
		deselectLayers();
		applyViewport();
		renderBoardControls();
		renderPanel();
		renderCards();
		renderFrames();
	}

	/** Editor: moves the pan/zoom to show the whole frame, with some room around it, and keeps it for the board. */
	function goToFrame(frame: Rect): void {
		const { clientWidth: width, clientHeight: height } = surface;
		if (width === 0 || height === 0) return; // not laid out (yet)
		const target = fitRect(frame, width, height, FIT_MARGIN);
		animateViewport(target);
		saveViewportSoon(target);
	}

	let animation = 0;

	function stopAnimation(): void {
		cancelAnimationFrame(animation);
	}

	/** Moves the pan/zoom smoothly to `target` (at once if the user prefers less motion), keeping the canvas
	 * center on a straight path. Nothing is saved here. */
	function animateViewport(target: Viewport): void {
		stopAnimation();
		const from = viewport;
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
			viewport = target;
			return applyViewport();
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
			applyViewport();
			if (t < 1) animation = requestAnimationFrame(frame);
		};
		animation = requestAnimationFrame(frame);
	}

	/** Pans just enough to bring a rectangle (world coordinates) into view, with a little room around it. */
	function reveal(rect: Rect): void {
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
		const target = { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
		animateViewport(target);
		saveViewportSoon(target);
	}

	const boardControls = el("div", { className: "board-controls" });

	/** The boards: switch to another (and in the editor, create, rename or delete). */
	const { dialog: boardDialog, button: boardButton } = pickerDropdown("board-dialog", text.tabBoards, "board-switch", text.changeBoard, () =>
		renderBoardDialog(),
	);

	function renderBoardDialog(renamingId: string | null = null): void {
		const boards = store.data.boards;
		renderPicker({
			dialog: boardDialog,
			title: text.tabBoards,
			items: boards,
			currentId: boardId,
			renamingId,
			pick: switchBoard,
			rerender: renderBoardDialog,
			...(!readOnly && {
				editing: {
					renameTitle: text.renameBoard,
					deleteTitle: text.deleteBoard,
					rename: (id, name) => {
						store.renameBoard(id, name);
						renderBoardControls();
					},
					remove: deleteBoard,
					newTitle: text.newBoard,
					newName: text.defaultBoardName(boards.length + 1),
					add: (name) => switchBoard(store.addBoard(name).id),
					move: (id, to) => store.moveBoard(id, to),
					moveTitle: text.moveBoard,
				},
			}),
		});
	}

	/** The frame of what is seen now: the largest one in a frame's shape inside the canvas. */
	const seenFrame = (): Rect => frameInside(visibleRect(viewport, surface.clientWidth, surface.clientHeight));

	/** Editor: sets the board's frame to what is seen now. */
	const frameFromViewButton = el(
		"button",
		{ type: "button", className: "frame-from-view", title: text.frameFromViewHint, onclick: () => frame.save(seenFrame()) },
		text.frameFromView,
	);

	/** Editor: the frame is only shown and changed while editing it, so it doesn't clutter the board. */
	let editingFrames = readPreference(EDIT_FRAMES_KEY) === "true";
	const editFramesButton = el("button", {
		type: "button",
		className: "frames-toggle",
		title: text.editFramesHint,
		onclick: () => {
			editingFrames = !editingFrames;
			writePreference(EDIT_FRAMES_KEY, String(editingFrames));
			renderBoardControls();
			renderFrames();
		},
	});

	/** Editor: the current board's exports (see `BoardExport`), in a dropdown like the boards'. */
	const { dialog: exportDialog, button: exportButton } = pickerDropdown("export-dialog", text.exportButton, "export-switch", text.exportBoard, () => {
		const option = (label: string, title: string, run: (id: string) => void) =>
			el(
				"li",
				{},
				el("button", { type: "button", className: "picker-option", title, onclick: () => (exportDialog.close(), run(boardId)) }, label),
			);
		exportDialog.replaceChildren(
			el("h2", {}, text.exportButton),
			el("ul", { className: "picker-list" }, ...exports.map((way) => option(way.label(), way.title(), (id) => way.run(store, id)))),
		);
	});
	exportButton.replaceChildren(text.exportButton, el("span", { ariaHidden: "true" }, "▾"));

	function renderBoardControls(): void {
		boardButton.replaceChildren(...pickerLabel(currentBoard().name));
		// The viewer only switches boards.
		if (readOnly) return boardControls.replaceChildren(boardButton);
		editFramesButton.ariaPressed = String(editingFrames);
		editFramesButton.replaceChildren(el("span", { ariaHidden: "true" }, "▭"), editingFrames ? text.doneEditingFrames : text.editFrames);
		boardControls.replaceChildren(
			boardButton,
			editFramesButton,
			...(editingFrames ? [frameFromViewButton] : []),
			el("button", { type: "button", title: text.newEntityHint, onclick: newEntity.open }, text.newEntityButton),
			...(exports.length > 0 ? [exportButton] : []),
		);
	}

	/** Deletes a board (after asking); without any left, the canvas makes way for the button creating the first. */
	function deleteBoard(id: string): void {
		const board = store.data.boards.find((b) => b.id === id);
		if (!board || !confirm(text.confirmDeleteBoard(board.name, board.cards.length))) return;
		flushViewport();
		store.deleteBoard(id);
		if (store.data.boards.length === 0) {
			boardDialog.close();
			view.replaceWith(canvasView(store, options));
			return;
		}
		if (id === boardId) switchBoard(store.data.boards[0]!.id);
		renderBoardDialog();
	}

	function setViewport(next: Viewport): void {
		stopAnimation();
		fitted = false;
		viewport = next;
		applyViewport();
		saveViewportSoon();
	}

	/** One 10% step in (1) or out (-1), around the canvas center. */
	function zoomStep(direction: 1 | -1): void {
		setViewport(zoomAt(viewport, stepZoom(viewport.zoom, direction), surface.clientWidth / 2, surface.clientHeight / 2));
	}

	/** Scroll/pinch zooming follows the gesture smoothly; once it pauses, the zoom eases to the nearest step around
	 * the same point (at once if the user prefers less motion). */
	function zoomSmoothly(factor: number, sx: number, sy: number): void {
		setViewport(zoomAt(viewport, viewport.zoom * factor, sx, sy));
		clearTimeout(zoomSettleTimer);
		zoomSettleTimer = setTimeout(() => {
			const from = viewport.zoom;
			const target = snapZoom(from);
			if (target === from) return;
			if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
				return setViewport(zoomAt(viewport, target, sx, sy));
			}
			const start = performance.now();
			const frame = (now: number) => {
				const t = Math.min(1, (now - start) / ZOOM_SETTLE_ANIMATION);
				const e = 1 - (1 - t) ** 2; // ease out
				viewport = zoomAt(viewport, t < 1 ? from + (target - from) * e : target, sx, sy);
				applyViewport();
				if (t < 1) animation = requestAnimationFrame(frame);
				else saveViewportSoon();
			};
			stopAnimation();
			animation = requestAnimationFrame(frame);
		}, ZOOM_SETTLE_DELAY);
	}

	const canvasMain = el("div", { className: "canvas-main" });
	/** Read-only card shown while hovering or focusing a reference tag; in screen space, so zoom doesn't shrink it. */
	const preview = createCardPreview(store, canvasMain);

	/** The entity shown in the details panel, and the card that was selected for it (if it's on this board). */
	let selected: { entityId: string; cardId: string | null } | null = null;
	/** Editor: the details panel shows the selected entity's form instead of its details. */
	let editing = false;
	const details = el("aside", { className: "details-panel", ariaLabel: dataText.details });
	details.hidden = true;

	function select(entityId: string | null, cardId: string | null = null): void {
		const hadGroup = group !== null;
		group = null;
		selected = entityId ? { entityId, cardId } : null;
		editing = false;
		if (entityId) deselectLayers();
		markSelectedCards();
		if (hadGroup) renderLayers(); // without the group's outlines
		renderDetails();
	}

	const isCardSelected = (cardId: string): boolean => (group ? !!group.cards?.has(cardId) : selected?.cardId === cardId);

	function markSelectedCards(): void {
		for (const node of layer.querySelectorAll<HTMLElement>(".canvas-card[data-card-id]")) {
			node.classList.toggle("selected", isCardSelected(node.dataset.cardId!));
		}
		markChain();
	}

	/** The cards linked by lines to this one, either way and through others, with it. */
	function chainOf(cardId: string): Set<string> {
		const chain = new Set([cardId]);
		for (const id of chain) {
			for (const [from, to] of edges) {
				if (from === id) chain.add(to);
				if (to === id) chain.add(from);
			}
		}
		return chain;
	}

	/**
	 * With one card selected, everything on the board fades but its chain: the cards linked to it and their lines,
	 * and what the layers keep in focus with it. Its own lines (and their labels) stand out further, as `direct`.
	 */
	function markChain(): void {
		const cardId = !group ? selected?.cardId : null;
		const chain = cardId ? chainOf(cardId) : null;
		layer.classList.toggle("focusing", chain !== null);
		views.forEach((view) => view.focus(cardId ?? null));
		for (const node of layer.querySelectorAll<HTMLElement>(".canvas-card[data-card-id]")) {
			node.classList.toggle("in-chain", !!chain?.has(node.dataset.cardId!));
		}
		for (const node of layer.querySelectorAll<HTMLElement | SVGElement>(".connector, .connector-label")) {
			const { from, to } = node.dataset;
			node.classList.toggle("in-chain", !!chain?.has(from!) && !!chain?.has(to!));
			node.classList.toggle("direct", !!cardId && (from === cardId || to === cardId));
		}
	}

	/** What's selected on the board, by list (see `BoardItems`): the group, or the one card or item (copies, to change). */
	function selection(): { [key: string]: Set<string> } {
		if (group) return Object.fromEntries(Object.entries(group).map(([key, ids]) => [key, new Set(ids)]));
		const items: { [key: string]: Set<string> } = { cards: new Set(selected?.cardId ? [selected.cardId] : []) };
		for (const [key, view] of views) {
			const id = view.selected();
			items[key] = new Set(id ? [id] : []);
		}
		return items;
	}

	/** Selects these cards and items: two or more as a group, one as usual (with its details or handles). */
	function setSelection(items: BoardItems): void {
		const all = Object.entries(items).flatMap(([key, ids]) => [...ids].map((id) => ({ key, id })));
		const [one] = all;
		if (all.length >= 2) {
			select(null);
			deselectLayers();
			group = Object.fromEntries(Object.entries(items).map(([key, ids]) => [key, new Set(ids)]));
			markSelectedCards();
			renderLayers();
		} else if (one?.key === "cards") {
			const card = currentBoard().cards.find((c) => c.id === one.id);
			select(card?.entityId ?? null, card?.id ?? null);
		} else if (one) {
			select(null);
			views.get(one.key)?.select(one.id);
		} else {
			select(null);
			deselectLayers();
		}
	}

	/** Shift+click: adds a card or a layer's item to the selection, or takes it out. */
	function toggleSelected(key: string, id: string): void {
		const current = selection();
		const ids = (current[key] ??= new Set());
		if (!ids.delete(id)) ids.add(id);
		setSelection(current);
	}

	/**
	 * Moves the group (or other `items`) along with the pointer from a press on one of its cards or layer items,
	 * snapped to the grid like a single card, in one change. A click without moving selects just what was pressed (a
	 * card's own click handler does that for cards).
	 */
	function dragGroup(e: PointerEvent, pressed: { cardNode: HTMLElement } | { key: string; id: string }, items: BoardItems | null = group): void {
		if (!items) return;
		const cardIds = items.cards ?? new Set<string>();
		const { zoom } = viewport;
		const board = currentBoard();
		const cards = board.cards.filter((c) => cardIds.has(c.id));
		const offset = (dx: number, dy: number) => ({ x: snapToGrid(dx / zoom), y: snapToGrid(dy / zoom) });
		let moving = false;
		trackPointer(
			e,
			(dx, dy) => {
				if (!moving && Math.hypot(dx, dy) < CLICK_TOLERANCE) return;
				moving = true;
				const o = offset(dx, dy);
				for (const card of cards) {
					const node = layer.querySelector<HTMLElement>(`.canvas-card[data-card-id="${card.id}"]`);
					if (!node) continue;
					node.classList.add("dragging");
					node.style.left = `${card.x + o.x}px`;
					node.style.top = `${card.y + o.y}px`;
					cardRects.set(card.id, { ...(cardRects.get(card.id) ?? card), x: card.x + o.x, y: card.y + o.y });
				}
				for (const [key, view] of views) view.previewMove(items[key] ?? new Set(), o.x, o.y);
				drawConnectors();
			},
			(dx, dy) => {
				views.forEach((view) => view.previewMove(null));
				if (!moving) {
					if ("key" in pressed) setSelection({ [pressed.key]: new Set([pressed.id]) });
					return;
				}
				if ("cardNode" in pressed) pressed.cardNode.dataset.dragged = "true";
				const o = offset(dx, dy);
				store.moveItems(board.id, Object.fromEntries(Object.entries(items).map(([key, ids]) => [key, [...ids]])), o.x, o.y);
				renderCards();
			},
			surface,
		);
	}

	/** Shows another entity's details, selecting its card if it's on this board. */
	function selectEntity(entityId: string): void {
		select(entityId, currentBoard().cards.find((c) => c.entityId === entityId)?.id ?? null);
	}

	/** Links the selected card's entity with another one, existing or new; the other one's card shows beside it. */
	const connect = connectDialog(store, (card) => {
		appearing = new Set([card.id]);
		renderCards();
		renderPanel();
		reveal(cardRects.get(card.id) ?? card);
	});

	/** Creates an entity of any type, with its card in the middle of the view (tagged like the side panel's filter). */
	const newEntity = newEntityDialog(store, {
		boardId: () => boardId,
		at: () => {
			const { zoom } = viewport;
			return screenToWorld(
				viewport,
				surface.clientWidth / 2 - (DEFAULT_CARD_SIZE.width * zoom) / 2,
				surface.clientHeight / 2 - (DEFAULT_CARD_SIZE.height * zoom) / 2,
			);
		},
		tags: () => {
			const tag = panel.tag();
			return tag ? [tag] : [];
		},
		onMade: ({ entity, card }) => {
			appearing = new Set([card.id]);
			renderCards();
			renderPanel();
			select(entity.id, card.id);
			reveal(cardRects.get(card.id) ?? card);
		},
	});

	/** Easy-to-read details of the selected entity: description, all properties, content and ID. */
	function renderDetails(): void {
		const entity = selected && store.data.entities.find((e) => e.id === selected!.entityId);
		details.hidden = !entity;
		if (!entity) {
			selected = null;
			details.replaceChildren();
			return;
		}
		const type = store.data.types.find((t) => t.id === entity.typeId);
		if (editing && type) {
			// Redrawing the board (moving a card, …) keeps the open form and what was typed.
			return showEntityEditor(details, store, entity, type, {
				onClose: () => select(null),
				onDone: (saved) => {
					editing = false;
					if (!saved) return renderDetails();
					// What the cards show (name, properties, lines) may have changed; renderCards shows the details again.
					renderCards();
					renderPanel();
				},
			});
		}
		// In the editor: Edit shows the entity's form here; for a card on the board, Connect links it with another
		// entity, existing or new (see openConnect).
		const edit = () => {
			editing = true;
			renderDetails();
		};
		const actions = readOnly
			? []
			: [
					el("button", { type: "button", onclick: edit }, dataText.edit),
					...(selected?.cardId ? [connect.button(entity, selected.cardId)] : []),
				];
		details.replaceChildren(...entityDetails(store, entity, { actions, onClose: () => select(null), onSelectEntity: selectEntity }));
	}

	// Escape closes the details panel (the listener removes itself once this view is gone).
	function onKeyDown(e: KeyboardEvent): void {
		if (!view.isConnected) return document.removeEventListener("keydown", onKeyDown);
		if ((e.target as Element).closest("input, select, textarea")) return;
		if (e.key === "Escape" && (selected || group)) select(null);
	}
	document.addEventListener("keydown", onKeyDown);

	/** Lines from `line` reference properties, under the cards, with their labels. */
	const lines = connectorLines();
	/** Card positions and sizes by card id; updated live while dragging or resizing. */
	let cardRects = new Map<string, Rect>();
	/** One entry per drawn reference: from a card to the nearest of the target entity's cards. */
	let links: Link[] = [];
	/** Cards that just came onto the board, so they fade in. */
	let appearing = new Set<string>();
	/** The lines drawn, as the cards they link (see drawConnectors). */
	let edges: [string, string][] = [];

	function renderCards(): void {
		preview.hide(); // its tag is about to be replaced
		const board = currentBoard();
		const entities = new Map(store.data.entities.map((e) => [e.id, e]));
		const entityNames = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const types = new Map(store.data.types.map((t) => [t.id, t]));
		const cardsByEntity = new Map<string, CanvasCard[]>();
		for (const card of board.cards) cardsByEntity.set(card.entityId, [...(cardsByEntity.get(card.entityId) ?? []), card]);

		cardRects = new Map(board.cards.map((c) => [c.id, { x: c.x, y: c.y, width: c.width, height: c.height }]));
		links = [];
		const cardNodes = board.cards.flatMap((card) => {
			const entity = entities.get(card.entityId);
			if (!entity) return [];
			const type = types.get(entity.typeId);
			// Other cards on this board showing the given entity.
			const targetCards = (entityId: string) => (cardsByEntity.get(entityId) ?? []).filter((c) => c.id !== card.id);
			for (const prop of type?.properties ?? []) {
				if (effectiveCardDisplay(prop) !== "line") continue;
				for (const id of referencedIds(prop, entity.values[prop.id])) {
					const targets = targetCards(id);
					const color = types.get(entities.get(id)?.typeId ?? "")?.color ?? "";
					if (targets.length > 0) {
						links.push({
							fromCardId: card.id,
							targetCardIds: targets.map((c) => c.id),
							label: prop.reference?.lineLabel || prop.name,
							fromColor: type?.color ?? "",
							color,
							arrow: prop.reference?.arrow ?? "to",
						});
					}
				}
			}
			return [cardElement(card, entity, type, entityNames, (id) => targetCards(id).length > 0)];
		});
		appearing = new Set();
		// The frame's outline stays on top of the cards. It isn't redrawn with them: only the nodes before it are replaced.
		if (frame.element.parentNode !== layer) layer.append(frame.element);
		for (const node of [...layer.childNodes]) if (node !== frame.element) node.remove();
		frame.element.before(...[...views.values()].map((view) => view.element), lines.element, lines.labels, ...cardNodes);
		renderLayers();
		measureCards();
		drawConnectors();
		// On the first render the canvas isn't on the page yet, so sizes can only be measured a frame later.
		requestAnimationFrame(() => {
			if (measureCards()) drawConnectors();
		});
		if (selected?.cardId && !board.cards.some((c) => c.id === selected!.cardId)) selected = { ...selected, cardId: null };
		renderDetails(); // the entity may have changed or been removed
	}

	/** Sizes measured before, by the card's HTML: a card only has to be measured again when what it shows changed. */
	const fittedSizes = new Map<string, { width: number; height: number }>();

	/** Sizes a card to what it shows (see cardSize), measured once per HTML. Returns that size, or null while the
	 * card isn't laid out. */
	function fitCard(node: HTMLElement): { width: number; height: number } | null {
		const key = node.innerHTML;
		const size = fittedSizes.get(key) ?? cardSize(node);
		if (!size) return null;
		fittedSizes.set(key, size);
		Object.assign(node.style, { width: `${size.width}px`, height: `${size.height}px` });
		return size;
	}

	/**
	 * Sizes the cards to what they show (see fitCard), so lines attach to them, and saves the sizes that changed (not in
	 * the viewer, which only looks). Returns whether the size of any card the lines attach to changed.
	 */
	function measureCards(): boolean {
		const changed = new Map<string, { width: number; height: number }>();
		const saved = new Map(currentBoard().cards.map((c) => [c.id, c]));
		let resized = false;
		for (const node of layer.querySelectorAll<HTMLElement>(".canvas-card[data-card-id]")) {
			const id = node.dataset.cardId ?? "";
			const size = fitCard(node);
			const card = saved.get(id);
			if (!size || !card) continue;
			const rect = cardRects.get(id);
			if (rect && (rect.width !== size.width || rect.height !== size.height)) {
				cardRects.set(id, { ...rect, ...size });
				resized = true;
			}
			if (card.width !== size.width || card.height !== size.height) changed.set(id, size);
		}
		if (changed.size > 0 && !readOnly) store.fitCards(changed);
		return resized;
	}

	function drawConnectors(): void {
		edges = lines.draw(links, cardRects);
		markChain();
	}

	function cardElement(
		card: CanvasCard,
		entity: Entity,
		type: EntityType | undefined,
		entityNames: ReadonlyMap<string, string>,
		isLinked: (entityId: string) => boolean,
	): HTMLElement {
		const removeButton = readOnly
			? undefined
			: el(
					"button",
					{
						type: "button",
						className: "card-remove",
						ariaLabel: text.removeNamedFromCanvas(entity.name),
						title: text.removeFromCanvas,
						onclick: () => {
							store.removeCard(card.id);
							renderCards();
							renderPanel();
						},
					},
					"×",
				);
		const { header, body } = cardParts(store, entity, type, entityNames, isLinked, {
			buttons: removeButton ? [removeButton] : [],
			preview,
		});
		// Sized to what it shows once laid out (see fitCard); until then as last measured.
		const node = el("article", { className: "canvas-card" }, header, ...(body ? [body] : []));
		node.classList.toggle("selected", isCardSelected(card.id));
		node.classList.toggle("appear", appearing.has(card.id));
		node.dataset.cardId = card.id;
		// Only a click shows the card's details; the browser also fires a click after dragging or resizing,
		// which the drag handlers mark on the card so it can be ignored here.
		node.addEventListener("click", (e) => {
			if (node.dataset.dragged) {
				delete node.dataset.dragged;
				return;
			}
			if ((e.target as Element).closest("button, .ref-tag")) return;
			// Shift+click adds the card to the selection or takes it out (not in the viewer).
			if (e.shiftKey && !readOnly) toggleSelected("cards", card.id);
			else select(entity.id, card.id);
		});
		Object.assign(node.style, {
			left: `${card.x}px`,
			top: `${card.y}px`,
			width: `${card.width}px`,
			height: `${card.height}px`,
		});
		// The viewer only looks: no moving.
		if (readOnly) return node;

		header.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || e.shiftKey || (e.target as Element).closest("button")) return; // Shift: a click (see above)
			e.preventDefault();
			if (group?.cards?.has(card.id)) return dragGroup(e, { cardNode: node });
			const { zoom } = viewport;
			let dragging = false;
			trackPointer(
				e,
				(dx, dy) => {
					// Small jitter during a click doesn't move the card.
					if (!dragging && Math.hypot(dx, dy) < CLICK_TOLERANCE) return;
					// On top while dragging. Not by moving the element to the end of the layer: moving it would
					// release the pointer capture, and fast mouse movements would then leave the card behind.
					if (!dragging) node.classList.add("dragging");
					dragging = true;
					const x = snapToGrid(card.x + dx / zoom);
					const y = snapToGrid(card.y + dy / zoom);
					node.style.left = `${x}px`;
					node.style.top = `${y}px`;
					cardRects.set(card.id, { ...(cardRects.get(card.id) ?? card), x, y });
					drawConnectors();
				},
				(dx, dy) => {
					if (!dragging) return; // a click: the click handler selects the card
					node.dataset.dragged = "true";
					store.moveCard(card.id, snapToGrid(card.x + dx / zoom), snapToGrid(card.y + dy / zoom));
					renderCards();
				},
			);
		});

		return node;
	}

	/** Whether Space is held: dragging then pans, wherever it starts. */
	let spaceHeld = false;
	function onSpace(e: KeyboardEvent): void {
		if (!view.isConnected) {
			document.removeEventListener("keydown", onSpace);
			document.removeEventListener("keyup", onSpace);
			return;
		}
		if (e.key !== " " || (e.target as Element).closest?.("input, select, textarea, [contenteditable]")) return;
		e.preventDefault(); // no scrolling, nor pressing a focused button
		spaceHeld = e.type === "keydown";
		surface.classList.toggle("space-pan", spaceHeld);
	}
	document.addEventListener("keydown", onSpace);
	document.addEventListener("keyup", onSpace);

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
	if (!readOnly) {
		surface.addEventListener(
			"pointerdown",
			(e) => {
				if (!(e.target as Element).closest(".canvas-card, .view-frame")) [...views.values()].some((view) => view.press(e));
			},
			{ capture: true },
		);
	}

	// Any drag, pan or zoom on the canvas closes the preview.
	surface.addEventListener("pointerdown", preview.hide, { capture: true });
	surface.addEventListener("wheel", preview.hide, { capture: true, passive: true });

	/** Pans the board along with the pointer from this press; a click without moving clears the selection. */
	function pan(e: PointerEvent): void {
		stopAnimation();
		const start = viewport;
		surface.classList.add("panning");
		trackPointer(
			e,
			(dx, dy) => {
				fitted = false;
				viewport = { ...start, x: start.x + dx, y: start.y + dy };
				applyViewport();
			},
			(dx, dy) => {
				surface.classList.remove("panning");
				saveViewportSoon();
				if (Math.hypot(dx, dy) < CLICK_TOLERANCE && e.button === 0) {
					select(null);
					deselectLayers();
				}
			},
			surface,
		);
	}

	/** The frame being dragged around cards and layer items to select them, in screen coordinates. */
	const marquee = el("div", { className: "marquee", hidden: true });
	surface.append(marquee);
	const touches = (a: Rect, b: Rect): boolean =>
		a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

	/**
	 * Drags a frame from this press: the cards and layer items it touches get selected (with
	 * Shift, added to the selection). A click without moving clears the selection.
	 */
	function frameSelect(e: PointerEvent): void {
		const area = surface.getBoundingClientRect();
		const start = { x: e.clientX - area.left, y: e.clientY - area.top };
		const adding = e.shiftKey;
		const frame = (dx: number, dy: number): Rect => ({
			x: Math.min(start.x, start.x + dx),
			y: Math.min(start.y, start.y + dy),
			width: Math.abs(dx),
			height: Math.abs(dy),
		});
		trackPointer(
			e,
			(dx, dy) => {
				if (marquee.hidden && Math.hypot(dx, dy) < CLICK_TOLERANCE) return;
				const f = frame(dx, dy);
				marquee.hidden = false;
				Object.assign(marquee.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.width}px`, height: `${f.height}px` });
			},
			(dx, dy) => {
				const framed = !marquee.hidden;
				marquee.hidden = true;
				if (!framed) {
					if (!adding) setSelection({});
					return;
				}
				const f = frame(dx, dy);
				const from = screenToWorld(viewport, f.x, f.y);
				const to = screenToWorld(viewport, f.x + f.width, f.y + f.height);
				const world = { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y };
				const board = currentBoard();
				const items = adding ? selection() : {};
				const add = (key: string, id: string) => (items[key] ??= new Set()).add(id);
				for (const c of board.cards) if (touches(world, cardRects.get(c.id) ?? c)) add("cards", c.id);
				for (const [key, view] of views) for (const id of view.touching(world)) add(key, id);
				setSelection(items);
			},
			surface,
		);
	}

	// Dragging the empty background frames cards and layer items to select them. Touch, and the viewer (which has
	// nothing to select), pan instead.
	surface.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 || (e.target !== surface && e.target !== layer)) return;
		if (readOnly || e.pointerType === "touch") pan(e);
		else frameSelect(e);
	});

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
			setViewport({ ...viewport, x: viewport.x - gesture.pan.dx, y: viewport.y - gesture.pan.dy });
		},
		{ passive: false },
	);

	/** Gives files to the layers, centered on a point (screen coordinates): true if one took any. */
	function dropFiles(files: FileList | undefined, clientX: number, clientY: number): boolean {
		const rect = surface.getBoundingClientRect();
		const center = screenToWorld(viewport, clientX - rect.left, clientY - rect.top);
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
			const rect = surface.getBoundingClientRect();
			const world = screenToWorld(viewport, e.clientX - rect.left, e.clientY - rect.top);
			const entityId = e.dataTransfer?.getData(ENTITY_MIME);
			if (!entityId) return;
			e.preventDefault();
			// Drop so the pointer ends up on the card's header, on the grid.
			const x = snapToGrid(world.x - DEFAULT_CARD_SIZE.width / 2);
			store.addCard(boardId, entityId, x, snapToGrid(world.y - 16));
			renderCards();
			renderPanel();
		});
	}

	// Ctrl/⌘ + V with files on the clipboard, e.g. an image, gives them to the layers, in the middle of the view (the
	// listener removes itself once this view is gone). Pasting into a text field stays the text field's.
	function onPaste(e: ClipboardEvent): void {
		if (!view.isConnected) return document.removeEventListener("paste", onPaste);
		if ((e.target as Element).closest?.("input, select, textarea, [contenteditable]")) return;
		const rect = surface.getBoundingClientRect();
		if (dropFiles(e.clipboardData?.files, rect.left + rect.width / 2, rect.top + rect.height / 2)) e.preventDefault();
	}
	if (!readOnly) document.addEventListener("paste", onPaste);

	/** Editor, while editing the frame: the board's frame as an outline on the canvas (see frameEditor). */
	const frame = frameEditor(store, { board: currentBoard, zoom: () => viewport.zoom, goTo: goToFrame });

	function renderFrames(): void {
		if (!readOnly) frame.render(editingFrames);
	}

	// Narrow screens only (see CSS): shows the controls kept out of the way there, so the canvas has room.
	const moreButton = el(
		"button",
		{
			type: "button",
			className: "canvas-more",
			title: text.moreControls,
			ariaLabel: text.moreControls,
			ariaExpanded: "false",
			onclick: () => {
				moreButton.ariaExpanded = String(view.classList.toggle("show-more"));
			},
		},
		"⋯",
	);
	// Each control group has its own place: boards top right, the layers' controls (e.g. the drawing tools on the
	// left edge with their style bar at the bottom left, see CSS), zoom bottom right.
	const toolbar = el("div", { className: "canvas-toolbar" }, el("div", { className: "toolbar-group" }, boardControls, moreButton));
	const zoomBar = el(
		"div",
		{ className: "toolbar-group canvas-zoom" },
		el("button", { type: "button", ariaLabel: text.zoomOut, title: text.zoomOut, onclick: () => zoomStep(-1) }, "−"),
		zoomLabel,
		el("button", { type: "button", ariaLabel: text.zoomIn, title: text.zoomIn, onclick: () => zoomStep(1) }, "+"),
		// The viewer fits what's shown again; the editor resets to the default.
		el(
			"button",
			{
				type: "button",
				onclick: () => {
					if (!readOnly) return setViewport(defaultViewport());
					stopAnimation();
					fitted = true;
					viewport = homeViewport();
					applyViewport();
				},
			},
			text.resetView,
		),
	);

	applyViewport();
	renderBoardControls();
	if (!readOnly) panel.build();
	renderPanel();
	renderCards();
	renderFrames();
	// The viewer fits what's shown once the canvas has a size, and again whenever it changes, until panned or zoomed.
	if (readOnly && typeof ResizeObserver !== "undefined") {
		new ResizeObserver(() => {
			if (!fitted) return;
			stopAnimation();
			viewport = homeViewport();
			applyViewport();
		}).observe(surface);
	}
	canvasMain.append(
		surface,
		...(readOnly ? [] : [openPanelButton, ...[...views.values()].flatMap((view) => view.controls)]),
		toolbar,
		zoomBar,
		preview.element,
		boardDialog,
		exportDialog,
		connect.dialog,
		newEntity.dialog,
	);
	// Drag handles for the widths of the side panel and the details (hidden along with them, see CSS).
	const panelHandle = resizeHandle(panel.element, { key: PANEL_WIDTH_KEY, side: "left", min: 12, max: 32 });
	const detailsHandle = resizeHandle(details, { key: DETAILS_WIDTH_KEY, side: "right", min: 16, max: 40 });
	detailsHandle.classList.add("details-resize");
	view.append(...(readOnly ? [] : [panel.element, panelHandle]), canvasMain, detailsHandle, details);
	return view;
}
