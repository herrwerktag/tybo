import { connector, nearest, type Rect } from "@tybo/core";
import { createDrawingLayer, libraryPicture } from "./drawing-layer.js";
import { areaContents, drawingBounds } from "./drawings.js";
import { CLICK_TOLERANCE, dragHandle, el, reorderable, resizeHandle, svgEl, tagFilter, trackPointer, typeDot, wheelGesture } from "./dom.js";
import { text } from "./i18n.js";
import {
	DEFAULT_CARD_SIZE,
	GRID_SIZE,
	FRAME_ASPECT,
	MIN_FRAME_SIZE,
	frameInside,
	effectiveCardDisplay,
	entityTags,
	filterEntities,
	linkCandidates,
	relationsOf,
	filterLibrary,
	isArea,
	isSymbol,
	referencedIds,
	snapToGrid,
	type Board,
	type CanvasCard,
	type Relation,
	type Entity,
	type EntityType,
	type LineArrow,
} from "@tybo/core";
import { cardParts, cardSize, createCardPreview, entityDetails } from "./entity-card.js";
import { showEntityEditor } from "./entity-form.js";
import { readPreference, writePreference } from "./preferences.js";
import type { Store } from "@tybo/core";
import { defaultViewport, fitRect, screenToWorld, snapZoom, stepZoom, visibleRect, zoomAt, type Viewport } from "@tybo/core";

const ENTITY_MIME = "application/x-entity-id";
const LIBRARY_MIME = "application/x-library-drawing-id";
const PICKER_MIME = "application/x-picker-index";
const PANEL_COLLAPSED_KEY = "canvas-panel-collapsed";
/** The widths of the side panel and the details panel, if changed by dragging. */
export const PANEL_WIDTH_KEY = "canvas-panel-width";
export const DETAILS_WIDTH_KEY = "details-panel-width";
/** What the side panel shows: entities or library drawings. */
const PANEL_TAB_KEY = "canvas-panel-tab";
/** The tag the side panel's entities are filtered by, if any. */
const PANEL_TAG_KEY = "canvas-panel-tag";
/** The size of the library drawings' thumbnails in the side panel, in px. */
const THUMBNAIL_SIZE = 40;
const ACTIVE_BOARD_KEY = "canvas-active-board";
/** Whether the editor is editing the frames: only then are they shown, with their controls. */
const EDIT_FRAMES_KEY = "canvas-edit-frames";
/** The connector lines' color (as in the stylesheet), for a gradient's end at a card whose type has no color. */
const LINE_COLOR = "#8a8a8a";
/** Canvases made so far (see gradientPrefix). */
let canvasCount = 0;
/** How long the pan/zoom takes to move somewhere else, in ms. */
const PAN_ANIMATION = 450;
/** How long scroll/pinch zooming must pause before the zoom settles on the nearest 10% step, and how long that takes, in ms. */
const ZOOM_SETTLE_DELAY = 150;
const ZOOM_SETTLE_ANIMATION = 120;
/** Room (screen px) around a frame the editor goes to. */
const FIT_MARGIN = 48;

/** What a viewer address names: `#view/<board>`, the board optional. */
export interface ViewTarget {
	boardId?: string;
}

export function parseViewHash(hash: string): ViewTarget {
	const [route, boardId] = hash.replace(/^#/, "").split("/").map(decodeURIComponent);
	if (route !== "view") return {};
	return boardId ? { boardId } : {};
}

export function viewHash({ boardId }: ViewTarget): string {
	return boardId === undefined ? "#view" : `#view/${encodeURIComponent(boardId)}`;
}

interface CanvasOptions {
	readOnly: boolean;
	/** Viewer only: the address (location.hash) names the board shown, and follows it. */
	addressed?: boolean;
	onExportView?: (boardId: string) => void;
	onExportDrawio?: (boardId: string) => void;
	onEditLibraryDrawing?: (libraryId: string) => void;
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
 * no moving, resizing, removing or dropping cards, and pan/zoom are never saved. With `onExportView` and
 * `onExportDrawio`, the viewer offers to export the current board (as HTML, for draw.io). With
 * `onEditLibraryDrawing`, a placed library drawing can be opened in the library.
 *
 * The viewer shows the board in its frame, fitted into the screen. The editor keeps one pan/zoom per board, and
 * shows the frame as an outline to move and resize.
 */
export function canvasView(store: Store, options: CanvasOptions): HTMLElement {
	if (store.data.boards.length === 0) return firstBoardView(store, options);
	const { readOnly, onExportView, onExportDrawio, onEditLibraryDrawing } = options;
	const addressed = readOnly && options.addressed === true;
	const target = addressed ? parseViewHash(location.hash) : {};
	let boardId = target.boardId ?? readPreference(ACTIVE_BOARD_KEY) ?? "";
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

	const panel = el("aside", { className: "canvas-panel" });
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

	/** Two or more cards and drawings selected together, to move at once (Shift+click, or a frame dragged around
	 * them); meanwhile neither the details nor a drawing's handles are shown. */
	let group: { cardIds: Set<string>; drawingIds: Set<string> } | null = null;
	/** The areas the selected card lies in, kept from fading along with the rest of the board (see markChain). */
	let focusedAreas = new Set<string>();

	// Shapes, lines, text and pen strokes: below the connector lines and cards.
	const drawing = createDrawingLayer({
		store,
		readOnly,
		owner: () => ({ boardId }),
		zoom: () => viewport.zoom,
		toWorld: (clientX, clientY) => {
			const rect = surface.getBoundingClientRect();
			return screenToWorld(viewport, clientX - rect.left, clientY - rect.top);
		},
		captureTarget: () => surface,
		// A card and a drawing are never selected at the same time.
		onSelect: (drawingId) => {
			if (drawingId) select(null);
		},
		group: () => group?.drawingIds ?? new Set(),
		inFocus: () => focusedAreas,
		onGroupPress: (e, drawingId) => {
			if (e.shiftKey) toggleSelected("drawingIds", drawingId);
			else dragGroup(e, { drawingId });
		},
		// An area moves along with the cards and drawings lying in it.
		onAreaPress: (e, drawingId) => {
			const board = currentBoard();
			const area = board.drawings.find((d) => d.id === drawingId);
			if (!area || !isArea(area)) return;
			const cards = board.cards.map((c) => ({ ...c, ...cardRects.get(c.id) }));
			const { cardIds, drawingIds } = areaContents(area, cards, board.drawings);
			setSelection(new Set(), new Set([drawingId]));
			dragGroup(e, { drawingId }, { cardIds, drawingIds: drawingIds.add(drawingId) });
		},
		onToolChange: (tool) => surface.classList.toggle("drawing-tool", tool !== "select"),
		...(onEditLibraryDrawing && { onEditSymbol: onEditLibraryDrawing }),
	});
	/** The zoom the drawings' selection handles were last drawn for (they keep their screen size). */
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
			drawing.render();
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
		address();
	}

	/** Shows the board now chosen, with its pan/zoom (see homeViewport). */
	function show(): void {
		stopAnimation();
		fitted = readOnly;
		viewport = homeViewport();
		group = null;
		drawing.deselect();
		applyViewport();
		renderBoardControls();
		renderPanel();
		renderCards();
		renderFrames();
	}

	/** In an addressed viewer, puts the board shown into the address, in place of the current one. */
	function address(): void {
		if (!addressed) return;
		const hash = viewHash({ boardId });
		if (hash !== location.hash) history.replaceState(null, "", hash);
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

	/** An overlay over the canvas (shown with showModal), closed by its × (see dialogHeader), Escape, or a click beside it. */
	function canvasDialog(className: string, label: string): HTMLDialogElement {
		const dialog: HTMLDialogElement = el("dialog", {
			className: `canvas-dialog ${className}`,
			ariaLabel: label,
			// No expression body: an on… handler returning false would cancel every click inside, submits included.
			onclick: (e: MouseEvent) => {
				if (e.target === dialog) dialog.close();
			},
		});
		return dialog;
	}

	function dialogHeader(dialog: HTMLDialogElement, title: string): HTMLElement {
		return el(
			"header",
			{},
			el("h2", {}, title),
			el("button", { type: "button", className: "card-remove", title: text.close, ariaLabel: text.close, onclick: () => dialog.close() }, "×"),
		);
	}

	/**
	 * A picker dropdown (boards): its items, the current one marked; clicking one picks it. In the editor (with
	 * `editing`), each can be renamed in place and deleted, and a form below adds one; with `move`, too, the items can
	 * be reordered.
	 */
	interface Picker {
		dialog: HTMLDialogElement;
		title: string;
		items: readonly { id: string; name: string }[];
		currentId: string;
		/** The item shown with a name field instead, if any. */
		renamingId: string | null;
		pick(id: string): void;
		/** Draws the dropdown again (with an item being renamed). */
		rerender(renamingId?: string | null): void;
		editing?: {
			renameTitle: string;
			deleteTitle: string;
			rename(id: string, name: string): void;
			remove(id: string): void;
			newTitle: string;
			newName: string;
			add(name: string): void;
			/** Moves the item to index `to` among the items. */
			move?(id: string, to: number): void;
			/** The label of an item's drag handle. */
			moveTitle?(name: string): string;
		};
	}

	function renderPicker({ dialog, title, items, currentId, renamingId, pick, rerender, editing }: Picker): void {
		const rows = items.map((item, i) => {
			if (editing && item.id === renamingId) {
				const input = el("input", { value: item.name, ariaLabel: editing.renameTitle, required: true });
				// Escape leaves the name as it was, instead of closing the dropdown.
				input.addEventListener("keydown", (e) => {
					if (e.key !== "Escape") return;
					e.preventDefault();
					rerender();
				});
				requestAnimationFrame(() => input.select());
				return el(
					"li",
					{},
					el(
						"form",
						{
							className: "picker-rename",
							onsubmit: (e: SubmitEvent) => {
								e.preventDefault();
								editing.rename(item.id, input.value);
								rerender();
							},
						},
						input,
						el("button", { type: "submit", className: "primary" }, text.save),
						el("button", { type: "button", onclick: () => rerender() }, text.cancel),
					),
				);
			}
			const option = el(
				"button",
				{
					type: "button",
					className: "picker-option",
					onclick: () => {
						dialog.close();
						if (item.id !== currentId) pick(item.id);
					},
				},
				item.name,
			);
			if (item.id === currentId) option.setAttribute("aria-current", "true");
			if (!editing) return el("li", {}, option);
			const { move, moveTitle } = editing;
			const handle = move ? dragHandle(moveTitle?.(item.name) ?? item.name, item.id) : null;
			const row = el(
				"li",
				{},
				...(handle ? [handle] : []),
				option,
				el("button", { type: "button", title: editing.renameTitle, onclick: () => rerender(item.id) }, text.renameButton),
				el("button", { type: "button", title: editing.deleteTitle, onclick: () => editing.remove(item.id) }, text.delete),
			);
			if (handle && move) {
				reorderable(row, handle, {
					index: i,
					count: items.length,
					mime: PICKER_MIME,
					move: (from, to) => {
						const moved = items[from]!.id;
						move(moved, to);
						rerender();
						dialog.querySelector<HTMLElement>(`.drag-handle[data-focus-key="${moved}"]`)?.focus();
					},
				});
			}
			return row;
		});

		const nameInput = el("input", { ariaLabel: text.name, value: editing?.newName ?? "", required: true });
		const newForm = el(
			"form",
			{
				className: "picker-new",
				onsubmit: (e: SubmitEvent) => {
					e.preventDefault();
					dialog.close();
					editing?.add(nameInput.value);
				},
			},
			el("h3", {}, editing?.newTitle ?? ""),
			nameInput,
			el("button", { type: "submit", className: "primary" }, text.create),
		);
		dialog.replaceChildren(el("h2", {}, title), el("ul", { className: "picker-list" }, ...rows), ...(editing ? [newForm] : []));
	}

	/**
	 * A picker as a dropdown under its button (`buttonClass`, showing what's current), the way the workspace menu opens:
	 * a dialog that isn't modal, filled by `render` as it opens. Picking closes it, and so do Escape, a click beside it,
	 * or its button again.
	 */
	function pickerDropdown(dialogClass: string, label: string, buttonClass: string, title: string, render: () => void) {
		const dialog: HTMLDialogElement = el("dialog", { className: `picker-dropdown ${dialogClass}`, ariaLabel: label });
		const button = el("button", {
			type: "button",
			className: `picker-switch ${buttonClass}`,
			title,
			ariaHasPopup: "dialog",
			onclick: () => (dialog.open ? dialog.close() : open()),
		});
		button.setAttribute("aria-expanded", "false");
		function open(): void {
			render();
			dialog.show();
			// Under the button, kept on the screen; what doesn't fit below scrolls.
			const at = button.getBoundingClientRect();
			dialog.style.top = `${at.bottom + 6}px`;
			dialog.style.left = `${Math.max(8, Math.min(at.left, innerWidth - dialog.offsetWidth - 8))}px`;
			dialog.style.maxHeight = `${innerHeight - at.bottom - 14}px`;
			button.setAttribute("aria-expanded", "true");
			document.addEventListener("pointerdown", onPointerDown);
			document.addEventListener("keydown", onKeyDown);
		}
		function onPointerDown(e: PointerEvent): void {
			if (!dialog.contains(e.target as Node) && !button.contains(e.target as Node)) dialog.close();
		}
		function onKeyDown(e: KeyboardEvent): void {
			// A rename field takes its own Escape (it keeps the old name).
			if (e.key !== "Escape" || e.defaultPrevented) return;
			dialog.close();
			button.focus();
		}
		dialog.addEventListener("close", () => {
			button.setAttribute("aria-expanded", "false");
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		});
		return { dialog, button };
	}
	const pickerLabel = (name: string) => [el("span", { className: "picker-name" }, name), el("span", { ariaHidden: "true" }, "▾")];

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
		{ type: "button", className: "frame-from-view", title: text.frameFromViewHint, onclick: () => saveFrame(seenFrame()) },
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

	function renderBoardControls(): void {
		boardButton.replaceChildren(...pickerLabel(currentBoard().name));
		// The viewer only switches boards, and maybe exports the current board.
		if (readOnly) {
			const exportButton = el("button", { type: "button", title: text.exportView, onclick: () => onExportView?.(boardId) }, text.exportButton);
			const drawioButton = el("button", { type: "button", title: text.exportDrawio, onclick: () => onExportDrawio?.(boardId) }, text.exportDrawioButton);
			return boardControls.replaceChildren(
				boardButton,
				...(onExportView ? [exportButton] : []),
				...(onExportDrawio ? [drawioButton] : []),
			);
		}
		editFramesButton.ariaPressed = String(editingFrames);
		editFramesButton.replaceChildren(el("span", { ariaHidden: "true" }, "▭"), editingFrames ? text.doneEditingFrames : text.editFrames);
		boardControls.replaceChildren(
			boardButton,
			editFramesButton,
			...(editingFrames ? [frameFromViewButton] : []),
			el("button", { type: "button", title: text.newEntityHint, onclick: openNewEntity }, text.newEntityButton),
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

	// Search and type filter for the side panel, kept for this visit only; the tag filter is remembered (see buildPanel).
	let panelQuery = "";
	let panelTypeId: string | null = null;
	let panelTag: string | null = null;
	let libraryQuery = "";
	let panelTab: "entities" | "library" = readPreference(PANEL_TAB_KEY) === "library" ? "library" : "entities";
	/** The list below the panel's controls; re-rendered on its own, so typing in the search keeps focus. */
	const panelList = el("div", { className: "panel-list" });

	/** Builds the panel once (header with the tabs, hint, filters); the list itself is drawn by renderPanel. */
	function buildPanel(): void {
		const toggle = el(
			"button",
			{
				type: "button",
				className: "panel-toggle",
				title: text.hideEntities,
				ariaLabel: text.hideEntities,
				onclick: () => setPanelCollapsed(true),
			},
			"«",
		);
		const search = el("input", {
			type: "search",
			placeholder: text.searchEntities,
			ariaLabel: text.searchEntities,
			oninput: () => {
				panelQuery = search.value;
				renderPanel();
			},
		});
		const typeFilter = el(
			"select",
			{
				ariaLabel: text.filterByType,
				onchange: () => {
					panelTypeId = typeFilter.value || null;
					renderPanel();
				},
			},
			el("option", { value: "" }, text.allTypes),
			...store.data.types.map((t) => el("option", { value: t.id }, t.name)),
		);
		// Only with tags in use: filters by a set of entities that belong together (e.g. one project's).
		const tags = entityTags(store.data.entities);
		const byTag = tagFilter(tags, PANEL_TAG_KEY, (tag) => {
			panelTag = tag;
			renderPanel();
		});
		panelTag = byTag.tag;
		const entityFilters = el("div", { className: "panel-filters" }, search, typeFilter, ...(tags.length > 0 ? [byTag.select] : []));
		const librarySearch = el("input", {
			type: "search",
			placeholder: text.searchLibrary,
			ariaLabel: text.searchLibrary,
			oninput: () => {
				libraryQuery = librarySearch.value;
				renderPanel();
			},
		});
		const libraryFilters = el("div", { className: "panel-filters" }, librarySearch);
		const tab = (id: typeof panelTab, label: string) =>
			el("button", { type: "button", className: "panel-tab", ariaPressed: String(panelTab === id), onclick: () => showTab(id) }, label);
		const tabs = el("div", { className: "panel-tabs", role: "group", ariaLabel: text.sidePanelContent });
		function showTab(id: typeof panelTab): void {
			panelTab = id;
			writePreference(PANEL_TAB_KEY, id);
			tabs.replaceChildren(tab("entities", text.entities), tab("library", text.libraryDrawings));
			entityFilters.hidden = id !== "entities";
			libraryFilters.hidden = id !== "library";
			renderPanel();
		}
		showTab(panelTab);
		panel.replaceChildren(
			el("div", { className: "panel-header" }, tabs, toggle),
			el("p", { className: "muted" }, text.dragOntoCanvas),
			entityFilters,
			libraryFilters,
			panelList,
		);
	}

	/** The library drawings in the side panel, each with a thumbnail, to drag onto the board. */
	function renderLibraryPanel(): void {
		const placed = new Map<string, number>();
		for (const d of currentBoard().drawings) {
			if (isSymbol(d)) placed.set(d.libraryId, (placed.get(d.libraryId) ?? 0) + 1);
		}
		const matches = filterLibrary(store.data.library, libraryQuery);
		const empty = store.data.library.length === 0 ? text.noLibraryYet : text.noLibraryMatches;
		panelList.replaceChildren(
			...(matches.length === 0 ? [el("p", { className: "muted" }, empty)] : []),
			el(
				"ul",
				{ className: "panel-group" },
				...matches.map((item) => {
					const count = placed.get(item.id) ?? 0;
					const li = el(
						"li",
						{ className: count > 0 ? "panel-item library-item placed" : "panel-item library-item", draggable: true },
						libraryPicture(item.drawings, { x: 0, y: 0, width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }),
						el(
							"span",
							{ className: "library-item-text" },
							el("span", {}, item.name),
							...(item.tags.length > 0 ? [el("span", { className: "panel-item-note muted" }, item.tags.join(", "))] : []),
							...(count > 0 ? [el("span", { className: "panel-item-note muted" }, text.onCanvas(count))] : []),
						),
					);
					li.dataset.libraryId = item.id;
					li.addEventListener("dragstart", (e) => {
						if (!e.dataTransfer) return;
						e.dataTransfer.setData(LIBRARY_MIME, item.id);
						e.dataTransfer.effectAllowed = "copy";
					});
					return li;
				}),
			),
		);
	}

	function renderPanel(): void {
		if (readOnly) return; // no side panel in the viewer
		if (panelTab === "library") return renderLibraryPanel();
		const cardCounts = new Map<string, number>();
		for (const card of currentBoard().cards) cardCounts.set(card.entityId, (cardCounts.get(card.entityId) ?? 0) + 1);
		const matches = filterEntities(store.data.entities, { query: panelQuery, typeId: panelTypeId, tag: panelTag });
		const groups = store.data.types
			.map((type) => ({ type, entities: matches.filter((e) => e.typeId === type.id) }))
			.filter((g) => g.entities.length > 0);

		const empty = store.data.entities.length === 0 ? text.noEntitiesYet : text.noMatches;
		panelList.replaceChildren(
			...(groups.length === 0 ? [el("p", { className: "muted" }, empty)] : []),
			...groups.map(({ type, entities }) =>
				el(
					"div",
					{ className: "panel-group" },
					el("h3", {}, typeDot(type.color), type.name),
					el(
						"ul",
						{},
						...entities.map((entity) => {
							const count = cardCounts.get(entity.id) ?? 0;
							const item = el(
								"li",
								{ className: count > 0 ? "panel-item placed" : "panel-item", draggable: true },
								el("span", {}, entity.name),
								// Always on its own line below the name.
								...(count > 0 ? [el("span", { className: "panel-item-note muted" }, text.onCanvas(count))] : []),
							);
							item.addEventListener("dragstart", (e) => {
								if (!e.dataTransfer) return;
								e.dataTransfer.setData(ENTITY_MIME, entity.id);
								e.dataTransfer.effectAllowed = "copy";
							});
							return item;
						}),
					),
				),
			),
		);
	}

	const canvasMain = el("div", { className: "canvas-main" });
	/** Read-only card shown while hovering or focusing a reference tag; in screen space, so zoom doesn't shrink it. */
	const preview = createCardPreview(store, canvasMain);

	/** The entity shown in the details panel, and the card that was selected for it (if it's on this board). */
	let selected: { entityId: string; cardId: string | null } | null = null;
	/** Editor: the details panel shows the selected entity's form instead of its details. */
	let editing = false;
	const details = el("aside", { className: "details-panel", ariaLabel: text.details });
	details.hidden = true;

	function select(entityId: string | null, cardId: string | null = null): void {
		const hadGroup = group !== null;
		group = null;
		selected = entityId ? { entityId, cardId } : null;
		editing = false;
		if (entityId) drawing.deselect();
		markSelectedCards();
		if (hadGroup) drawing.render(); // without the group's outlines
		renderDetails();
	}

	const isCardSelected = (cardId: string): boolean => (group ? group.cardIds.has(cardId) : selected?.cardId === cardId);

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

	/** The areas the card lies in. */
	function areasOf(cardId: string): Set<string> {
		const board = currentBoard();
		const cards = board.cards.map((c) => ({ ...c, ...cardRects.get(c.id) }));
		return new Set(
			board.drawings.filter((d) => isArea(d) && areaContents(d, cards, board.drawings).cardIds.has(cardId)).map((d) => d.id),
		);
	}

	/**
	 * With one card selected, everything on the board fades but its chain: the cards linked to it and their lines,
	 * and the areas it lies in. Its own lines (and their labels) stand out further, as `direct`.
	 */
	function markChain(): void {
		const cardId = !group ? selected?.cardId : null;
		const chain = cardId ? chainOf(cardId) : null;
		layer.classList.toggle("focusing", chain !== null);
		focusedAreas = cardId ? areasOf(cardId) : new Set();
		for (const node of layer.querySelectorAll<SVGElement>(".drawing[data-id]")) {
			node.classList.toggle("in-chain", focusedAreas.has(node.dataset.id!));
		}
		for (const node of layer.querySelectorAll<HTMLElement>(".canvas-card[data-card-id]")) {
			node.classList.toggle("in-chain", !!chain?.has(node.dataset.cardId!));
		}
		for (const node of layer.querySelectorAll<HTMLElement | SVGElement>(".connector, .connector-label")) {
			const { from, to } = node.dataset;
			node.classList.toggle("in-chain", !!chain?.has(from!) && !!chain?.has(to!));
			node.classList.toggle("direct", !!cardId && (from === cardId || to === cardId));
		}
	}

	/** What's selected on the board: the group, or the one card or drawing (copies, to change). */
	function selection(): { cardIds: Set<string>; drawingIds: Set<string> } {
		if (group) return { cardIds: new Set(group.cardIds), drawingIds: new Set(group.drawingIds) };
		const drawingId = drawing.selected();
		return { cardIds: new Set(selected?.cardId ? [selected.cardId] : []), drawingIds: new Set(drawingId ? [drawingId] : []) };
	}

	/** Selects these cards and drawings: two or more as a group, one as usual (with its details or handles). */
	function setSelection(cardIds: Set<string>, drawingIds: Set<string>): void {
		if (cardIds.size + drawingIds.size >= 2) {
			select(null);
			drawing.deselect();
			group = { cardIds, drawingIds };
			markSelectedCards();
			drawing.render();
		} else if (cardIds.size === 1) {
			const card = currentBoard().cards.find((c) => cardIds.has(c.id));
			select(card?.entityId ?? null, card?.id ?? null);
		} else if (drawingIds.size === 1) {
			select(null);
			drawing.select([...drawingIds][0]!);
		} else {
			select(null);
			drawing.deselect();
		}
	}

	/** Shift+click: adds a card or drawing to the selection, or takes it out. */
	function toggleSelected(kind: "cardIds" | "drawingIds", id: string): void {
		const current = selection();
		if (!current[kind].delete(id)) current[kind].add(id);
		setSelection(current.cardIds, current.drawingIds);
	}

	/**
	 * Moves the group (or other `items`) along with the pointer from a press on one of its cards or drawings, snapped to
	 * the grid like a single card, in one change. A click without moving selects just what was pressed (a card's own
	 * click handler does that for cards).
	 */
	function dragGroup(
		e: PointerEvent,
		pressed: { cardNode: HTMLElement } | { drawingId: string },
		items: { cardIds: ReadonlySet<string>; drawingIds: ReadonlySet<string> } | null = group,
	): void {
		if (!items) return;
		const { cardIds, drawingIds } = items;
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
				drawing.previewMove(drawingIds, o.x, o.y);
				drawConnectors();
			},
			(dx, dy) => {
				drawing.previewMove(null);
				if (!moving) {
					if ("drawingId" in pressed) setSelection(new Set(), new Set([pressed.drawingId]));
					return;
				}
				if ("cardNode" in pressed) pressed.cardNode.dataset.dragged = "true";
				const o = offset(dx, dy);
				store.moveItems(board.id, [...cardIds], [...drawingIds], o.x, o.y);
				renderCards();
			},
			surface,
		);
	}

	/** Shows another entity's details, selecting its card if it's on this board. */
	function selectEntity(entityId: string): void {
		select(entityId, currentBoard().cards.find((c) => c.entityId === entityId)?.id ?? null);
	}

	/** Links the selected card's entity with another one, existing or new, through any relation (see relationsOf). */
	const connectDialog = canvasDialog("connect-dialog", text.connect);

	function connectButton(entity: Entity, cardId: string): HTMLButtonElement {
		const none = relationsOf(store.data.types, entity).length === 0;
		return el(
			"button",
			{ type: "button", disabled: none, title: none ? text.noRelations : text.connectHint, onclick: () => openConnect(entity.id, cardId) },
			text.connect,
		);
	}

	/** How a relation reads in the dialog, seen from the selected entity: its own reference, or another type's. */
	function relationLabel({ prop, direction, typeId }: Relation): string {
		const typeName = store.data.types.find((t) => t.id === typeId)?.name ?? "?";
		if (direction === "forward") return text.relationForward(prop.name, typeName);
		const inverse = prop.reference?.inverseLabel.trim() ?? "";
		return inverse ? text.relationInverse(inverse, typeName) : text.relationInverseUnnamed(typeName, prop.name);
	}

	function openConnect(entityId: string, cardId: string): void {
		renderConnect(entityId, cardId);
		connectDialog.showModal();
		connectDialog.querySelector<HTMLInputElement>(".connect-new input")?.focus();
	}

	/** The dialog's content for one of the relations: the existing entities fitting it (found by name), and a form for
	 * a new one. Either way the other entity's card is shown beside the card, and the selection stays on it. */
	function renderConnect(entityId: string, cardId: string, index = 0): void {
		const entity = store.data.entities.find((e) => e.id === entityId);
		if (!entity) return connectDialog.close();
		const relations = relationsOf(store.data.types, entity);
		const relation = relations[index];
		if (!relation) return connectDialog.close();
		const link = { propId: relation.prop.id, direction: relation.direction };
		const typeName = store.data.types.find((t) => t.id === relation.typeId)?.name ?? "?";
		const done = (card: CanvasCard | undefined) => {
			connectDialog.close();
			if (!card) return;
			appearing = new Set([card.id]);
			renderCards();
			renderPanel();
			reveal(cardRects.get(card.id) ?? card);
		};

		const choice = el(
			"select",
			{ ariaLabel: text.relation, onchange: () => renderConnect(entityId, cardId, Number(choice.value)) },
			...relations.map((r, i) => el("option", { value: String(i), selected: i === index }, relationLabel(r))),
		);
		const candidates = linkCandidates(store.data.entities, entity, relation);
		const list = el("ul", { className: "connect-list" });
		const renderList = (query: string) => {
			const found = filterEntities(candidates, { query, typeId: null });
			list.replaceChildren(
				...(found.length === 0 ? [el("li", { className: "muted" }, candidates.length === 0 ? text.noCandidates : text.noMatches)] : []),
				...found.map((other) =>
					el(
						"li",
						{},
						el(
							"button",
							{
								type: "button",
								className: "picker-option",
								onclick: () => done(store.linkEntity(cardId, link, other.id) ?? undefined),
							},
							other.name,
						),
					),
				),
			);
		};
		renderList("");
		const search = el("input", {
			type: "search",
			placeholder: text.searchEntities,
			ariaLabel: text.searchEntities,
			oninput: () => renderList(search.value),
		});
		const name = el("input", { required: true, pattern: ".*\\S.*", placeholder: text.name, ariaLabel: text.name });
		connectDialog.replaceChildren(
			dialogHeader(connectDialog, text.connectNamed(entity.name)),
			el("label", { className: "field" }, el("span", {}, text.relation), choice),
			el(
				"form",
				{
					className: "connect-new",
					onsubmit: (e: SubmitEvent) => {
						e.preventDefault();
						done(store.addLinkedEntity(cardId, link, relation.typeId, name.value)?.card);
					},
				},
				el("h3", {}, text.newEntity(typeName)),
				el("div", { className: "row" }, name, el("button", { type: "submit", className: "primary" }, text.create)),
			),
			el("div", { className: "connect-existing" }, el("h3", {}, text.existingEntity(typeName)), search, list),
		);
	}

	/** Creates an entity of any type, with its card in the middle of the view (tagged like the side panel's filter). */
	const newEntityDialog = canvasDialog("new-entity-dialog", text.newEntityTitle);

	function openNewEntity(): void {
		const types = store.data.types;
		const typeSelect = el("select", { ariaLabel: text.entityType }, ...types.map((t) => el("option", { value: t.id }, t.name)));
		const name = el("input", { required: true, pattern: ".*\\S.*", placeholder: text.name, ariaLabel: text.name });
		newEntityDialog.replaceChildren(
			dialogHeader(newEntityDialog, text.newEntityTitle),
			types.length === 0
				? el("p", { className: "muted" }, text.createTypeFirst)
				: el(
						"form",
						{
							className: "connect-new",
							onsubmit: (e: SubmitEvent) => {
								e.preventDefault();
								const { zoom } = viewport;
								const at = screenToWorld(
									viewport,
									surface.clientWidth / 2 - (DEFAULT_CARD_SIZE.width * zoom) / 2,
									surface.clientHeight / 2 - (DEFAULT_CARD_SIZE.height * zoom) / 2,
								);
								const made = store.addEntityWithCard(boardId, typeSelect.value, name.value, at, panelTag ? [panelTag] : []);
								newEntityDialog.close();
								if (!made) return;
								appearing = new Set([made.card.id]);
								renderCards();
								renderPanel();
								select(made.entity.id, made.card.id);
								reveal(cardRects.get(made.card.id) ?? made.card);
							},
						},
						el("label", { className: "field" }, el("span", {}, text.entityType), typeSelect),
						el("div", { className: "row" }, name, el("button", { type: "submit", className: "primary" }, text.create)),
					),
		);
		newEntityDialog.showModal();
		name.focus();
	}

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
					el("button", { type: "button", onclick: edit }, text.edit),
					...(selected?.cardId ? [connectButton(entity, selected.cardId)] : []),
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

	/** Lines from `line` reference properties, under the cards. */
	const connectorLayer = svgEl("svg", { class: "connectors", "aria-hidden": "true" });
	/** Property-name labels at the lines' midpoints: above the lines, below the cards. */
	const connectorLabels = el("div", { className: "connector-labels", ariaHidden: "true" });
	/** Card positions and sizes by card id; updated live while dragging or resizing. */
	let cardRects = new Map<string, Rect>();
	/** One entry per drawn reference: from a card to the nearest of the target entity's cards. */
	let links: {
		fromCardId: string;
		targetCardIds: string[];
		label: string;
		/** The source's and the target's type colors. */
		fromColor: string;
		color: string;
		arrow: LineArrow;
	}[] = [];
	/** Makes the lines' gradient ids unique in the document, should it show more than one canvas. */
	const gradientPrefix = `connector-gradient-${++canvasCount}`;
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
		if (frameLayer.parentNode !== layer) layer.append(frameLayer);
		for (const node of [...layer.childNodes]) if (node !== frameLayer) node.remove();
		frameLayer.before(drawing.element, connectorLayer, connectorLabels, ...cardNodes);
		drawing.render();
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
		const lines: SVGElement[] = [];
		const gradients: SVGElement[] = [];
		const labels: HTMLElement[] = [];
		edges = [];
		for (const { fromCardId, targetCardIds, label, fromColor, color, arrow } of links) {
			const from = cardRects.get(fromCardId);
			const to = from && nearest(from, targetCardIds.flatMap((id) => cardRects.get(id) ?? []));
			if (!from || !to) continue;
			const toCardId = targetCardIds.find((id) => cardRects.get(id) === to)!;
			edges.push([fromCardId, toCardId]);
			// "from" draws the same curve the other way round, so the arrowhead lands on this card.
			const shape = arrow === "from" ? connector(to, from) : connector(from, to, arrow === "to");
			const { path, mid, start, end } = shape;
			// The selected card's own lines are drawn in a gradient along the curve, from the start card's color to
			// the end card's (see .connector.direct).
			const gradientId = `${gradientPrefix}-${gradients.length}`;
			const [startColor, endColor] = arrow === "from" ? [color, fromColor] : [fromColor, color];
			gradients.push(
				svgEl(
					"linearGradient",
					{ id: gradientId, gradientUnits: "userSpaceOnUse", x1: start.x, y1: start.y, x2: end.x, y2: end.y },
					svgEl("stop", { offset: 0, "stop-color": startColor || LINE_COLOR }),
					svgEl("stop", { offset: 1, "stop-color": endColor || LINE_COLOR }),
				),
			);
			lines.push(
				svgEl(
					"g",
					{
						class: "connector",
						"data-from": fromCardId,
						"data-to": toCardId,
						style: `--line-gradient: url(#${gradientId})`,
					},
					svgEl("path", { class: "connector-line", d: path }),
					...(shape.arrow
						? [svgEl("polygon", { class: "connector-arrow", points: shape.arrow, fill: color || "currentColor" })]
						: []),
				),
			);
			const tag = el("span", { className: "connector-label" }, label);
			Object.assign(tag.style, { left: `${mid.x}px`, top: `${mid.y}px` });
			Object.assign(tag.dataset, { from: fromCardId, to: toCardId });
			labels.push(tag);
		}
		connectorLayer.replaceChildren(svgEl("defs", {}, ...gradients), ...lines);
		connectorLabels.replaceChildren(...labels);
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
			if (e.shiftKey && !readOnly) toggleSelected("cardIds", card.id);
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
			if (group?.cardIds.has(card.id)) return dragGroup(e, { cardNode: node });
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
	// so it wins over cards, drawings and drawing tools.
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

	// With a drawing tool active, pressing anywhere on the canvas except on a card (or the frame's
	// name or corner) starts a new drawing (in the capture phase, so it wins over panning and selecting).
	if (!readOnly) {
		surface.addEventListener(
			"pointerdown",
			(e) => {
				if (!(e.target as Element).closest(".canvas-card, .view-frame")) drawing.startCreate(e);
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
					drawing.deselect();
				}
			},
			surface,
		);
	}

	/** The frame being dragged around cards and drawings to select them, in screen coordinates. */
	const marquee = el("div", { className: "marquee", hidden: true });
	surface.append(marquee);
	const touches = (a: Rect, b: Rect): boolean =>
		a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

	/**
	 * Drags a frame from this press: the cards and drawings it touches get selected (with
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
					if (!adding) setSelection(new Set(), new Set());
					return;
				}
				const f = frame(dx, dy);
				const from = screenToWorld(viewport, f.x, f.y);
				const to = screenToWorld(viewport, f.x + f.width, f.y + f.height);
				const world = { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y };
				const board = currentBoard();
				const { cardIds, drawingIds } = adding ? selection() : { cardIds: new Set<string>(), drawingIds: new Set<string>() };
				for (const c of board.cards) if (touches(world, cardRects.get(c.id) ?? c)) cardIds.add(c.id);
				for (const d of board.drawings) if (touches(world, drawingBounds(d))) drawingIds.add(d.id);
				setSelection(cardIds, drawingIds);
			},
			surface,
		);
	}

	// Dragging the empty background frames cards and drawings to select them. Touch, and the viewer (which has
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

	/** Puts image files on the board, centered on a point (screen coordinates); several are staggered. */
	function addImages(files: readonly File[], clientX: number, clientY: number): void {
		const rect = surface.getBoundingClientRect();
		const center = screenToWorld(viewport, clientX - rect.left, clientY - rect.top);
		files.forEach((file, i) => void drawing.addImage(file, { x: center.x + i * GRID_SIZE, y: center.y + i * GRID_SIZE }));
	}

	const imageFiles = (files: FileList | undefined): File[] => [...(files ?? [])].filter((f) => f.type.startsWith("image/"));

	// Drop entities or library drawings from the side panel, or image files (editor only).
	if (!readOnly) {
		surface.addEventListener("dragover", (e) => {
			if (!e.dataTransfer || ![ENTITY_MIME, LIBRARY_MIME, "Files"].some((type) => e.dataTransfer!.types.includes(type))) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		});
		surface.addEventListener("drop", (e) => {
			const images = imageFiles(e.dataTransfer?.files);
			if (images.length > 0) {
				e.preventDefault();
				addImages(images, e.clientX, e.clientY);
				return;
			}
			const rect = surface.getBoundingClientRect();
			const world = screenToWorld(viewport, e.clientX - rect.left, e.clientY - rect.top);
			const libraryId = e.dataTransfer?.getData(LIBRARY_MIME);
			if (libraryId) {
				e.preventDefault();
				drawing.addSymbol(libraryId, world);
				renderPanel();
				return;
			}
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

	// Ctrl/⌘ + V with an image on the clipboard puts it in the middle of the view (the listener removes itself
	// once this view is gone). Pasting into a text field stays the text field's.
	function onPaste(e: ClipboardEvent): void {
		if (!view.isConnected) return document.removeEventListener("paste", onPaste);
		if ((e.target as Element).closest?.("input, select, textarea, [contenteditable]")) return;
		const images = imageFiles(e.clipboardData?.files);
		if (images.length === 0) return;
		e.preventDefault();
		const rect = surface.getBoundingClientRect();
		addImages(images, rect.left + rect.width / 2, rect.top + rect.height / 2);
	}
	if (!readOnly) document.addEventListener("paste", onPaste);

	/** Editor, while editing the frame: the board's frame as an outline on the canvas. It is moved by its name (a click
	 * there goes to it) and resized at its corner, snapped to the grid; only those react to the pointer. */
	const frameLayer = el("div", { className: "view-frames" });

	function placeFrame(node: HTMLElement, { x, y, width, height }: { x: number; y: number; width: number; height: number }): void {
		Object.assign(node.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
	}

	function renderFrames(): void {
		if (readOnly) return;
		frameLayer.replaceChildren(...(editingFrames ? [frameElement(currentBoard().viewFrame)] : []));
	}

	/** Moves or resizes the board's frame. */
	function saveFrame({ x, y, width, height }: Rect): void {
		store.setViewFrame(boardId, { x, y, width, height });
		renderFrames();
	}

	function frameElement(frame: Rect): HTMLElement {
		const node = el("div", { className: "view-frame" });
		placeFrame(node, frame);
		const label = el("div", { className: "view-frame-label", title: text.frameHandle }, text.boardFrame);
		label.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const { zoom } = viewport;
			const at = (dx: number, dy: number) => ({ x: snapToGrid(frame.x + dx / zoom), y: snapToGrid(frame.y + dy / zoom) });
			trackPointer(
				e,
				(dx, dy) => placeFrame(node, { ...frame, ...at(dx, dy) }),
				(dx, dy) => {
					if (Math.hypot(dx, dy) < CLICK_TOLERANCE) return goToFrame(frame);
					saveFrame({ ...frame, ...at(dx, dy) });
				},
			);
		});
		const resize = el("div", { className: "card-resize", title: text.resize });
		resize.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const { zoom } = viewport;
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
	// Each control group has its own place: boards top right, drawing tools on the left edge with their style
	// bar at the bottom left (see CSS), zoom bottom right.
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
	if (!readOnly) buildPanel();
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
		...(readOnly ? [] : [openPanelButton, drawing.toolbar, drawing.styleBar]),
		toolbar,
		zoomBar,
		preview.element,
		boardDialog,
		connectDialog,
		newEntityDialog,
	);
	// Drag handles for the widths of the side panel and the details (hidden along with them, see CSS).
	const panelHandle = resizeHandle(panel, { key: PANEL_WIDTH_KEY, side: "left", min: 12, max: 32 });
	const detailsHandle = resizeHandle(details, { key: DETAILS_WIDTH_KEY, side: "right", min: 16, max: 40 });
	detailsHandle.classList.add("details-resize");
	view.append(...(readOnly ? [] : [panel, panelHandle]), canvasMain, detailsHandle, details);
	return view;
}
