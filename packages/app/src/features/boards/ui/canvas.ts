import { GRID_SIZE, freeName, snapToGrid, type Point, type Rect } from "../../../shared/core/index.js";
import { CLICK_TOLERANCE, el, icon, listenWhileConnected, readPreference, resizeHandle, trackPointer, writePreference, type EntityLink, type SearchSource } from "../../../shared/ui/index.js";
import { DEFAULT_CARD_SIZE, type Entity, type EntityType } from "../../data/core.js";
import { text as dataText } from "../../data/texts.js";
import { cardParts, cardSize, conversionDialog, createCardPreview, detailsPanel, type EntityPlaces } from "../../data/ui.js";
import { frameInside, referencesOffBoard, screenToWorld, visibleRect, type Board, type CanvasCard, type BoardStore, type Viewport } from "../core.js";
import { text } from "../texts.js";
import { connectDialog, newEntityDialog } from "./dialogs.js";
import { frameEditor } from "./frame.js";
import { boardControls } from "./board-controls.js";
import { boardLinks, chainOf, connectorLines, type Link } from "./lines.js";
import { canvasInput } from "./input.js";
import { entityPanel } from "./panel.js";
import type { BoardExport, BoardItems, CanvasLayer } from "./layer.js";
import { viewportControl } from "./viewport.js";

const PANEL_COLLAPSED_KEY = "canvas-panel-collapsed";
/** The widths of the side panel and the details panel, if changed by dragging. */
export const PANEL_WIDTH_KEY = "canvas-panel-width";
const ACTIVE_BOARD_KEY = "canvas-active-board";
export interface CanvasOptions {
	readOnly: boolean;
	/** The features' layers on the board (see `CanvasLayer`), the first drawn lowest. */
	layers: readonly CanvasLayer[];
	/** The ways to export a board, offered in the editor (see `BoardExport`). */
	exports?: readonly BoardExport[];
	/** Where the details lead from an entity to the features' pages (its history, say). */
	entityLinks?: readonly EntityLink[];
}

/** The address of an entity's card on a board: the board opened, the card selected and in view. */
export const cardRoute = (boardId: string, entityId: string) => `#boards/${encodeURIComponent(boardId)}/${encodeURIComponent(entityId)}`;

/** The address of a board. */
export const boardRoute = (boardId: string) => `#boards/${encodeURIComponent(boardId)}`;

/** The board the address names (`#boards/<board>`), and the entity whose card to show there (`…/<entity>`), if it does. */
export function cardOfRoute(hash: string): { boardId: string; entityId: string | null } | null {
	const [route, board, entity] = hash.slice(1).split("/");
	return route === "boards" && board ? { boardId: decodeURIComponent(board), entityId: entity ? decodeURIComponent(entity) : null } : null;
}

/** In the search: the boards, and a new one (named with the first number free), opened. */
export const BOARD_SEARCH: SearchSource<BoardStore> = {
	items: (store) => store.data.boards.map((b) => ({ label: b.name, detail: text.board, href: boardRoute(b.id) })),
	actions: (store) => [
		{
			label: text.newBoard,
			run: () => {
				location.hash = boardRoute(store.addBoard(freeName(store.data.boards, text.defaultBoardName)).id);
			},
		},
	],
};

/** Opens this board the next time a canvas is made. */
export const openBoard = (boardId: string) => writePreference(ACTIVE_BOARD_KEY, boardId);

/** In an entity's details: the boards with a card of it, each a link to that card. */
export const BOARD_PLACES: EntityPlaces = {
	label: () => text.onBoards,
	places: (store, entityId) =>
		(store as BoardStore).data.boards.filter((b) => b.cards.some((c) => c.entityId === entityId)).map((b) => ({ label: b.name, href: cardRoute(b.id, entityId) })),
};

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
export function canvas(store: BoardStore, options: CanvasOptions): { view: HTMLElement; refresh(): boolean; follow(entityId: string): void } {
	if (store.data.boards.length === 0) return { view: firstBoardView(store, options), refresh: () => false, follow: () => {} };
	const { readOnly, layers, exports = [], entityLinks = [] } = options;
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

	/** Whether the screen is narrow (a phone): the details then lie over the board as a sheet (see CSS). */
	const narrow = (): boolean => !!window.matchMedia?.("(max-width: 40rem)").matches;

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
		icon("panelOpen"),
	);

	const canvasMain = el("div", { className: "canvas-main" });
	/** Read-only card shown while hovering or focusing a reference tag or an entity in the side panel; in screen
	 * space, so zoom doesn't shrink it. */
	const preview = createCardPreview(store, canvasMain);

	const panel = entityPanel(store, { board: currentBoard, readOnly, preview, onHide: () => setPanelCollapsed(true), onNewEntity: () => newEntity.open() });
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

	/** Editor, while editing the frame: the board's frame as an outline on the canvas (see frameEditor). */
	const frame = frameEditor(store, { board: currentBoard, zoom: () => viewport.current.zoom, goTo: viewport.goTo });

	const controls = boardControls(store, {
		readOnly,
		exports,
		board: currentBoard,
		switchBoard,
		beforeDelete: viewport.flush,
		onNoBoards: () => view.replaceWith(canvasView(store, options)),
		newEntity: () => newEntity.open(),
		// The largest frame in a frame's shape inside the canvas.
		seenFrame: () => frameInside(visibleRect(viewport.current, surface.clientWidth, surface.clientHeight)),
		frame,
	});
	const renderBoardControls = controls.render;

	/** The entity shown in the details panel, and the card that was selected for it (if it's on this board). */
	let selected: { entityId: string; cardId: string | null } | null = null;
	/** Narrow screens: the details were closed, the selection kept (see `closeDetails`). */
	let detailsClosed = false;
	/** With touch (see `touchBar`): whether tapping cards selects several, and whether dragging a selected card moves
	 * the selection — a finger moves no card otherwise. */
	let selecting = false;
	let moving = false;
	const conversion = conversionDialog(store, { onConverted: () => redrawBoard() });
	/** Easy-to-read details of the selected entity: description, all properties, content and ID. In the editor, Edit
	 * shows its form there; for a card on the board, Connect links it with another entity, existing or new. */
	const details = detailsPanel(store, {
		readOnly,
		actions: (entity) => [
			...(selected?.cardId ? [connect.button(entity, selected.cardId), layOutButton(selected.cardId)] : []),
			conversion.button(entity),
			el("button", { type: "button", className: "entity-delete", title: text.deleteEntityHint, onclick: () => deleteEntity(entity) }, text.deleteEntity),
		],
		onClose: () => (narrow() ? closeDetails() : select(null)),
		onSelectEntity: followReference,
		places: [BOARD_PLACES],
		links: entityLinks,
		// What the cards show (name, properties, lines) may have changed; renderCards shows the details again.
		onSaved: () => {
			redrawBoard();
		},
	});

	function select(entityId: string | null, cardId: string | null = null): void {
		const hadGroup = group !== null;
		group = null;
		selected = entityId ? { entityId, cardId } : null;
		detailsClosed = false;
		moving = false;
		if (entityId) deselectLayers();
		markSelectedCards();
		if (hadGroup) renderLayers(); // without the group's outlines
		if (!details.open(selected?.entityId ?? null)) selected = null;
		liftBoard();
	}

	/**
	 * Narrow screens: while the details lie over the board, the canvas is pushed up just far enough to show the
	 * selected card above them, as far as there's room under the controls. The pan/zoom stays as it is (or is about to
	 * be: `at`), so closing the details shows what was seen before.
	 */
	function liftBoard(at: Viewport = viewport.current): void {
		const rect = selected?.cardId ? cardRects.get(selected.cardId) : undefined;
		let lift = 0;
		if (rect && !details.element.hidden && narrow()) {
			const top = canvasMain.getBoundingClientRect().top + rect.y * at.zoom + at.y;
			const sheet = details.element.getBoundingClientRect();
			const controls = (readOnly ? toolbar : touchBar).getBoundingClientRect().bottom;
			lift = Math.min(top + rect.height * at.zoom + GRID_SIZE - sheet.top, top - controls - GRID_SIZE / 2, sheet.height);
		}
		surface.style.translate = lift > 0 ? `0 ${-Math.round(lift)}px` : "";
	}

	/** Brings a rectangle on the board into view (see `ViewportControl.reveal`), above the details lying over it. */
	const reveal = (rect: Rect): void => liftBoard(viewport.reveal(rect));

	/** Narrow screens: closes the details lying over the board; the card stays selected, and a tap on it shows them
	 * again. */
	function closeDetails(): void {
		detailsClosed = true;
		renderDetails();
	}

	const isCardSelected = (cardId: string): boolean => (group ? !!group.cards?.has(cardId) : selected?.cardId === cardId);
	const anyCardSelected = (): boolean => (group ? !!group.cards?.size : !!selected?.cardId);

	function markSelectedCards(): void {
		for (const node of layer.querySelectorAll<HTMLElement>(".canvas-card[data-card-id]")) {
			node.classList.toggle("selected", isCardSelected(node.dataset.cardId!));
		}
		markChain();
		renderTouchBar();
	}

	/** A click or tap on a card shows its details; while selecting several, it adds the card or takes it out. */
	function pressCard(card: CanvasCard): void {
		if (selecting) toggleSelected("cards", card.id);
		else select(card.entityId, card.id);
	}

	/** Selecting several cards by tapping them, one after the other; what's selected stays so, without its details. */
	function setSelecting(on: boolean): void {
		selecting = on;
		if (on) setSelection(selection(), true);
		renderTouchBar();
	}

	/** Moving what's selected by dragging one of its cards with a finger, until turned off or something else is
	 * selected. On narrow screens the details make room for it. */
	function setMoving(on: boolean): void {
		moving = on && anyCardSelected();
		if (moving) selecting = false;
		if (moving && narrow()) closeDetails();
		renderTouchBar();
	}

	const selectButton = el("button", { type: "button", title: text.selectCardsHint, onclick: () => setSelecting(!selecting) }, text.selectCards);
	const moveButton = el("button", { type: "button", title: text.moveCardsHint, onclick: () => setMoving(!moving) }, text.moveCards);
	/** Only where there's touch (see CSS), in the editor: what a finger can't tell apart by how it presses. */
	const touchBar = el("div", { className: "toolbar-group canvas-touch", role: "group", ariaLabel: text.touchActions }, selectButton, moveButton);

	function renderTouchBar(): void {
		if (!anyCardSelected()) moving = false;
		selectButton.ariaPressed = String(selecting);
		moveButton.ariaPressed = String(moving);
		moveButton.disabled = !anyCardSelected();
		view.classList.toggle("moving-cards", moving);
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

	/** Selects these cards and items: two or more as a group, one as usual (with its details or handles) — or, with
	 * `asGroup`, as a group too. */
	function setSelection(items: BoardItems, asGroup = false): void {
		const all = Object.entries(items).flatMap(([key, ids]) => [...ids].map((id) => ({ key, id })));
		const [one] = all;
		if (all.length >= 2 || (asGroup && one)) {
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

	/** Shift+click, or a tap while selecting several: adds a card or a layer's item to the selection, or takes it out. */
	function toggleSelected(key: string, id: string): void {
		const current = selection();
		const ids = (current[key] ??= new Set());
		if (!ids.delete(id)) ids.add(id);
		setSelection(current, selecting);
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

	/** Shows another entity's details (one a reference leads to, say), selecting its card and bringing it into view if
	 * it's on this board; one that isn't stays off it. */
	function followReference(entityId: string): void {
		const card = currentBoard().cards.find((c) => c.entityId === entityId);
		select(entityId, card?.id ?? null);
		if (card) reveal(cardRects.get(card.id) ?? card);
	}

	/** Links the selected card's entity with another one, existing or new; the other one's card shows beside it. */
	const connect = connectDialog(store, (card) => {
		appearing = new Set([card.id]);
		redrawBoard();
		reveal(cardRects.get(card.id) ?? card);
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
			reveal(cardRects.get(card.id) ?? card);
		},
	});

	/** Shows the selected entity's details anew, keeping its open form (redrawing the board, moving a card, …) — or
	 * none while they're closed (see `closeDetails`). */
	function renderDetails(): void {
		const closed = detailsClosed && store.data.entities.some((e) => e.id === selected?.entityId);
		if (!details.show(closed ? null : (selected?.entityId ?? null)) && !closed) selected = null;
		liftBoard();
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
		reveal({ x, y, width: Math.max(...all.map((r) => r.x + r.width)) - x, height: Math.max(...all.map((r) => r.y + r.height)) - y });
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
		renderTouchBar();
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
			else pressCard(card);
		});
		Object.assign(node.style, {
			left: `${card.x}px`,
			top: `${card.y}px`,
			width: `${card.width}px`,
			height: `${card.height}px`,
		});
		// A reference's tag, clicked (or Enter on it), shows the entity it leads to — not after it was dragged.
		for (const tag of body?.querySelectorAll<HTMLElement>(".ref-tag[data-entity-id]") ?? []) {
			const follow = () => followReference(tag.dataset.entityId!);
			tag.setAttribute("role", "link");
			tag.addEventListener("click", (e) => {
				e.stopPropagation();
				if (tag.dataset.dragged) delete tag.dataset.dragged;
				else follow();
			});
			tag.addEventListener("keydown", (e) => {
				if (e.key !== "Enter") return;
				e.preventDefault();
				follow();
			});
		}
		// The viewer only looks: no moving.
		if (readOnly) return node;

		// A reference to an entity without a card on this board: dragging its tag puts that card here.
		for (const tag of body?.querySelectorAll<HTMLElement>(".ref-tag[data-entity-id]") ?? []) {
			const entityId = tag.dataset.entityId!;
			if (currentBoard().cards.some((c) => c.entityId === entityId)) continue;
			tag.classList.add("ref-drag");
			tag.addEventListener("pointerdown", (e) => dragReference(e, entityId, tag));
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
	function dragReference(e: PointerEvent, entityId: string, tag: HTMLElement): void {
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
					tag.dataset.dragged = "true"; // the click after the drag doesn't follow the reference
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

	canvasInput(store, {
		readOnly,
		view,
		surface,
		layer,
		viewport,
		views,
		preview,
		board: currentBoard,
		cardRects: () => cardRects,
		selection,
		setSelection,
		clearSelection: () => {
			select(null);
			deselectLayers();
		},
		// A finger moves the selection only while that is turned on, and only from one of its cards.
		onTouch: (e, node) => {
			if (!moving || !isCardSelected(node.dataset.cardId!)) return false;
			dragGroup(e, { cardNode: node }, selection());
			return true;
		},
		// A tap is a click: on a reference's tag, a card, or the background (which keeps what's being selected).
		onTap: (node, target) => {
			const tag = target.closest<HTMLElement>(".ref-tag[data-entity-id]");
			const card = node && currentBoard().cards.find((c) => c.id === node.dataset.cardId);
			if (node && tag) followReference(tag.dataset.entityId!);
			else if (card) pressCard(card);
			else if (!node && !selecting) {
				select(null);
				deselectLayers();
			}
		},
		onCardAdded: redrawBoard,
	});

	function renderFrames(): void {
		if (!readOnly) frame.render(controls.editingFrames());
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
	const toolbar = el("div", { className: "canvas-toolbar" }, el("div", { className: "toolbar-group" }, controls.element, moreButton));
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
		...(readOnly ? [] : [openPanelButton, ...[...views.values()].flatMap((view) => view.controls), touchBar]),
		toolbar,
		zoomBar,
		preview.element,
		controls.boardDialog,
		controls.exportDialog,
		connect.dialog,
		newEntity.dialog,
		conversion.dialog,
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
	return { view, refresh, follow: followReference };
}
