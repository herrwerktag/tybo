import { freeName, touches, type Point, type Rect } from "../../../shared/core/index.js";
import { CLICK_TOLERANCE, el, listenWhileConnected, readPreference, resizeHandle, trackPointer, writePreference } from "../../../shared/ui/index.js";
import { DEFAULT_CARD_SIZE, snapToGrid, type Entity, type EntityType } from "../../data/core.js";
import { text as dataText } from "../../data/texts.js";
import { detailsPanel } from "../../data/ui/details-panel.js";
import { cardParts, cardSize, createCardPreview } from "../../data/ui/entity-card.js";
import { frameInside, referencesOffBoard, screenToWorld, visibleRect, type Board, type CanvasCard, type BoardStore } from "../core.js";
import { text } from "../texts.js";
import { connectDialog, newEntityDialog } from "./dialogs.js";
import { frameEditor } from "./frame.js";
import { boardLinks, chainOf, connectorLines, type Link } from "./lines.js";
import { marquee } from "./marquee.js";
import { ENTITY_MIME, entityPanel } from "./panel.js";
import { pickerDropdown, pickerLabel, renderPicker } from "./pickers.js";
import type { BoardExport, BoardItems, CanvasLayer } from "./layer.js";
import { viewportControl } from "./viewport.js";

const PANEL_COLLAPSED_KEY = "canvas-panel-collapsed";
/** The widths of the side panel and the details panel, if changed by dragging. */
export const PANEL_WIDTH_KEY = "canvas-panel-width";
const ACTIVE_BOARD_KEY = "canvas-active-board";
/** Whether the editor is editing the frames: only then are they shown, with their controls. */
const EDIT_FRAMES_KEY = "canvas-edit-frames";
export interface CanvasOptions {
	readOnly: boolean;
	/** The features' layers on the board (see `CanvasLayer`), the first drawn lowest. */
	layers: readonly CanvasLayer[];
	/** The ways to export a board, offered in the editor (see `BoardExport`). */
	exports?: readonly BoardExport[];
}

/** Instead of the canvas while there's no board: a button that creates the first one and opens it. */
function firstBoardView(store: BoardStore, options: CanvasOptions): HTMLElement {
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
export function canvasView(store: BoardStore, options: CanvasOptions): HTMLElement {
	return canvas(store, options).view;
}

/** The board canvas (see `canvasView`), with the way to draw it anew in place: after someone else's changes were
 * taken over, it shows them and keeps this tab's pan and zoom, and what's selected as far as it's still there.
 * False when that can't be done (no board, or the one shown is gone): then the canvas has to be made anew. */
export function canvas(store: BoardStore, options: CanvasOptions): { view: HTMLElement; refresh(): boolean } {
	if (store.data.boards.length === 0) return { view: firstBoardView(store, options), refresh: () => false };
	const { readOnly, layers, exports = [] } = options;
	let boardId = readPreference(ACTIVE_BOARD_KEY) ?? "";
	const currentBoard = (): Board => store.data.boards.find((b) => b.id === boardId) ?? store.data.boards[0]!;
	boardId = currentBoard().id;

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

	const canvasMain = el("div", { className: "canvas-main" });
	/** Read-only card shown while hovering or focusing a reference tag or an entity in the side panel; in screen
	 * space, so zoom doesn't shrink it. */
	const preview = createCardPreview(store, canvasMain);

	const panel = entityPanel(store, { board: currentBoard, readOnly, preview, onHide: () => setPanelCollapsed(true) });
	const renderPanel = panel.render;
	const layer = el("div", { className: "canvas-board" });
	const surface = el("div", { className: "canvas-surface" }, layer);
	const zoomLabel = el("span", { className: "zoom-label" });

	const viewport = viewportControl(store, { readOnly, surface, layer, zoomLabel, board: currentBoard, onZoom: () => renderLayers() });

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
				zoom: () => viewport.current.zoom,
				toWorld: viewport.toWorld,
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
	function switchBoard(id: string): void {
		viewport.flush();
		boardId = id;
		writePreference(ACTIVE_BOARD_KEY, id);
		show();
	}

	/** Shows the board now chosen, from where it's seen from (see viewportControl). */
	function show(): void {
		viewport.show();
		group = null;
		deselectLayers();
		renderBoardControls();
		renderPanel();
		renderCards();
		renderFrames();
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
					newName: freeName(boards, text.defaultBoardName),
					nameTaken: text.boardNameTaken,
					add: (name) => switchBoard(store.addBoard(name).id),
					move: (id, to) => store.moveBoard(id, to),
					moveTitle: text.moveBoard,
				},
			}),
		});
	}

	/** The frame of what is seen now: the largest one in a frame's shape inside the canvas. */
	const seenFrame = (): Rect => frameInside(visibleRect(viewport.current, surface.clientWidth, surface.clientHeight));

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
		viewport.flush();
		store.deleteBoard(id);
		if (store.data.boards.length === 0) {
			boardDialog.close();
			view.replaceWith(canvasView(store, options));
			return;
		}
		if (id === boardId) switchBoard(store.data.boards[0]!.id);
		renderBoardDialog();
	}

	/** The entity shown in the details panel, and the card that was selected for it (if it's on this board). */
	let selected: { entityId: string; cardId: string | null } | null = null;
	/** Easy-to-read details of the selected entity: description, all properties, content and ID. In the editor, Edit
	 * shows its form there; for a card on the board, Connect links it with another entity, existing or new. */
	const details = detailsPanel(store, {
		readOnly,
		actions: (entity) => [
			...(selected?.cardId ? [connect.button(entity, selected.cardId), layOutButton(selected.cardId)] : []),
			el("button", { type: "button", className: "entity-delete", title: text.deleteEntityHint, onclick: () => deleteEntity(entity) }, text.deleteEntity),
		],
		onClose: () => select(null),
		onSelectEntity: selectEntity,
		// What the cards show (name, properties, lines) may have changed; renderCards shows the details again.
		onSaved: () => {
			redrawBoard();
		},
	});

	function select(entityId: string | null, cardId: string | null = null): void {
		const hadGroup = group !== null;
		group = null;
		selected = entityId ? { entityId, cardId } : null;
		if (entityId) deselectLayers();
		markSelectedCards();
		if (hadGroup) renderLayers(); // without the group's outlines
		if (!details.open(selected?.entityId ?? null)) selected = null;
	}

	const isCardSelected = (cardId: string): boolean => (group ? !!group.cards?.has(cardId) : selected?.cardId === cardId);

	function markSelectedCards(): void {
		for (const node of layer.querySelectorAll<HTMLElement>(".canvas-card[data-card-id]")) {
			node.classList.toggle("selected", isCardSelected(node.dataset.cardId!));
		}
		markChain();
	}

	/**
	 * With one card selected, everything on the board fades but its chain: the cards linked to it and their lines,
	 * and what the layers keep in focus with it. Its own lines (and their labels) stand out further, as `direct`.
	 */
	function markChain(): void {
		const cardId = !group ? selected?.cardId : null;
		const chain = cardId ? chainOf(cardId, edges) : null;
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
		const { zoom } = viewport.current;
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
		redrawBoard();
		viewport.reveal(cardRects.get(card.id) ?? card);
	});

	/** Creates an entity of any type, with its card in the middle of the view (tagged like the side panel's filter). */
	const newEntity = newEntityDialog(store, {
		boardId: () => boardId,
		at: () => {
			const { zoom } = viewport.current;
			return screenToWorld(
				viewport.current,
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
			redrawBoard();
			select(entity.id, card.id);
			viewport.reveal(cardRects.get(card.id) ?? card);
		},
	});

	/** Shows the selected entity's details anew, keeping its open form (redrawing the board, moving a card, …). */
	function renderDetails(): void {
		if (!details.show(selected?.entityId ?? null)) selected = null;
	}

	/** Lays out the cards of the references the card lists but the board doesn't show around it (see
	 * layOutReferences); disabled while there are none. */
	function layOutButton(cardId: string): HTMLButtonElement {
		const { forward, inverse } = referencesOffBoard(store.data, cardId);
		return el(
			"button",
			{
				type: "button",
				title: text.layOutReferencesHint,
				ariaLabel: text.layOutReferencesHint,
				disabled: forward.length + inverse.length === 0,
				onclick: () => layOutReferences(cardId),
			},
			text.layOutReferences,
		);
	}

	/** Puts the cards beside the card `cardId`, each as big as it will show (see fitCard), and brings them into view. */
	function layOutReferences(cardId: string): void {
		const board = currentBoard();
		const onBoard = new Set(board.cards.map((c) => c.entityId));
		const names = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const measure = (entityId: string): { width: number; height: number } => {
			const entity = store.data.entities.find((e) => e.id === entityId)!;
			const type = store.data.types.find((t) => t.id === entity.typeId);
			const node = cardElement({ id: "", entityId, x: 0, y: 0, ...DEFAULT_CARD_SIZE }, entity, type, names, (id) => onBoard.has(id));
			node.style.visibility = "hidden";
			layer.append(node);
			const size = fitCard(node) ?? DEFAULT_CARD_SIZE;
			node.remove();
			return size;
		};
		const cards = store.layOutReferences(cardId, measure);
		if (cards.length === 0) return;
		appearing = new Set(cards.map((c) => c.id));
		redrawBoard();
		const all = [cardRects.get(cardId), ...cards].filter((r) => !!r);
		const x = Math.min(...all.map((r) => r.x));
		const y = Math.min(...all.map((r) => r.y));
		viewport.reveal({ x, y, width: Math.max(...all.map((r) => r.x + r.width)) - x, height: Math.max(...all.map((r) => r.y + r.height)) - y });
	}

	/** Deletes the entity (after asking), with its cards on every board; one undo step brings all of it back. */
	function deleteEntity(entity: Entity): void {
		const otherBoards = store.data.boards.filter((b) => b.id !== boardId && b.cards.some((c) => c.entityId === entity.id)).length;
		if (!confirm(dataText.confirmDeleteEntity(entity.name, store.referencesTo(entity.id)) + text.otherBoardsWithCards(otherBoards))) return;
		store.deleteEntity(entity.id);
		select(null);
		redrawBoard();
	}

	// Escape closes the details panel; in the editor, Delete takes the selected card off the board, like ×, and never
	// deletes its entity.
	listenWhileConnected(view, "keydown", (e) => {
		if ((e.target as Element).closest("input, select, textarea")) return;
		if (e.key === "Escape" && (selected || group)) select(null);
		const cardId = !group && selected?.cardId;
		if ((e.key === "Delete" || e.key === "Backspace") && cardId && !readOnly && !(e.ctrlKey || e.metaKey || e.altKey)) {
			e.preventDefault();
			store.removeCard(cardId);
			redrawBoard();
		}
	});

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

	/** After the board's cards changed: draws them anew, and the side panel that tells which are on the board. */
	function redrawBoard(): void {
		renderCards();
		renderPanel();
	}

	function renderCards(): void {
		preview.hide(); // its tag is about to be replaced
		const board = currentBoard();
		const entities = new Map(store.data.entities.map((e) => [e.id, e]));
		const entityNames = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const types = new Map(store.data.types.map((t) => [t.id, t]));
		const cardsByEntity = new Map<string, CanvasCard[]>();
		for (const card of board.cards) cardsByEntity.set(card.entityId, [...(cardsByEntity.get(card.entityId) ?? []), card]);

		cardRects = new Map(board.cards.map((c) => [c.id, { x: c.x, y: c.y, width: c.width, height: c.height }]));
		links = boardLinks(store.data, board);
		const cardNodes = board.cards.flatMap((card) => {
			const entity = entities.get(card.entityId);
			if (!entity) return [];
			// Whether another card on this board shows the given entity.
			const isLinked = (entityId: string) => (cardsByEntity.get(entityId) ?? []).some((c) => c.id !== card.id);
			return [cardElement(card, entity, types.get(entity.typeId), entityNames, isLinked)];
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
							redrawBoard();
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

		// A reference to an entity without a card on this board: dragging its tag puts that card here.
		for (const tag of body?.querySelectorAll<HTMLElement>(".ref-tag[data-entity-id]") ?? []) {
			const entityId = tag.dataset.entityId!;
			if (currentBoard().cards.some((c) => c.entityId === entityId)) continue;
			tag.classList.add("ref-drag");
			tag.addEventListener("pointerdown", (e) => dragReference(e, entityId));
		}

		header.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || e.shiftKey || (e.target as Element).closest("button")) return; // Shift: a click (see above)
			e.preventDefault();
			if (group?.cards?.has(card.id)) return dragGroup(e, { cardNode: node });
			const { zoom } = viewport.current;
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

	/**
	 * Drags the card of the entity `entityId` out of a card's reference tag, from this press: it follows the pointer on
	 * the grid and lands where it's let go, unless that's off the canvas. The board then shows the reference as its
	 * card display says: as a line, or still in the list.
	 */
	function dragReference(e: PointerEvent, entityId: string): void {
		const entity = store.data.entities.find((x) => x.id === entityId);
		if (e.button !== 0 || e.shiftKey || !entity) return;
		e.preventDefault(); // no text selection
		let ghost: HTMLElement | null = null;
		const pointerAt = (dx: number, dy: number) => ({ x: e.clientX + dx, y: e.clientY + dy });
		// So the pointer ends up on the card's header, as when dropped from the side panel.
		const spot = (dx: number, dy: number): Point => {
			const pointer = pointerAt(dx, dy);
			const world = viewport.toWorld(pointer.x, pointer.y);
			return { x: snapToGrid(world.x - (ghost?.offsetWidth || DEFAULT_CARD_SIZE.width) / 2), y: snapToGrid(world.y - 16) };
		};
		trackPointer(
			e,
			(dx, dy) => {
				if (!ghost && Math.hypot(dx, dy) < CLICK_TOLERANCE) return;
				if (!ghost) {
					preview.hide();
					const type = store.data.types.find((t) => t.id === entity.typeId);
					const names = new Map(store.data.entities.map((x) => [x.id, x.name]));
					const onBoard = (id: string) => currentBoard().cards.some((c) => c.entityId === id);
					const { header, body } = cardParts(store, entity, type, names, onBoard, { preview: null });
					ghost = el("article", { className: "canvas-card dragging in-chain card-ghost" }, header, ...(body ? [body] : []));
					layer.append(ghost);
					fitCard(ghost);
				}
				const { x, y } = spot(dx, dy);
				Object.assign(ghost.style, { left: `${x}px`, top: `${y}px` });
			},
			(dx, dy) => {
				if (!ghost) return;
				const { x, y } = spot(dx, dy);
				ghost.remove();
				const area = surface.getBoundingClientRect();
				const pointer = pointerAt(dx, dy);
				if (pointer.x < area.left || pointer.x > area.right || pointer.y < area.top || pointer.y > area.bottom) return;
				store.addCard(boardId, entityId, x, y);
				redrawBoard();
			},
		);
	}

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
		viewport.pan(e, () => {
			if (e.button !== 0) return;
			select(null);
			deselectLayers();
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
			for (const c of currentBoard().cards) if (touches(world, cardRects.get(c.id) ?? c)) add("cards", c.id);
			for (const [key, view] of views) for (const id of view.touching(world)) add(key, id);
			setSelection(items);
		});
	}

	// Dragging the empty background frames cards and layer items to select them. Touch, and the viewer (which has
	// nothing to select), pan instead.
	surface.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 || (e.target !== surface && e.target !== layer)) return;
		if (readOnly || e.pointerType === "touch") pan(e);
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
			store.addCard(boardId, entityId, x, snapToGrid(world.y - 16));
			redrawBoard();
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

	/** Editor, while editing the frame: the board's frame as an outline on the canvas (see frameEditor). */
	const frame = frameEditor(store, { board: currentBoard, zoom: () => viewport.current.zoom, goTo: viewport.goTo });

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
		el("button", { type: "button", ariaLabel: text.zoomOut, title: text.zoomOut, onclick: () => viewport.zoomStep(-1) }, "−"),
		zoomLabel,
		el("button", { type: "button", ariaLabel: text.zoomIn, title: text.zoomIn, onclick: () => viewport.zoomStep(1) }, "+"),
		// The viewer fits what's shown again; the editor resets to the default.
		el("button", { type: "button", onclick: () => viewport.reset() }, text.resetView),
	);

	renderBoardControls();
	if (!readOnly) panel.build();
	renderPanel();
	renderCards();
	renderFrames();
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
	view.append(...(readOnly ? [] : [panel.element, panelHandle]), canvasMain, details.handle, details.element);

	function refresh(): boolean {
		if (!view.isConnected || !store.data.boards.some((b) => b.id === boardId)) return false;
		if (group?.cards) {
			const onBoard = new Set(currentBoard().cards.map((c) => c.id));
			group.cards = new Set([...group.cards].filter((id) => onBoard.has(id)));
		}
		renderBoardControls();
		renderPanel();
		renderCards(); // with the layers, and the details of what's selected (or none, once it's gone)
		renderFrames();
		return true;
	}
	return { view, refresh };
}
