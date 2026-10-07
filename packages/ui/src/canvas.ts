import { connector, nearest, type Rect } from "@bekbon/core";
import { createDrawingLayer } from "./drawing-layer.js";
import { CLICK_TOLERANCE, el, svgEl, trackPointer, typeDot } from "./dom.js";
import { text } from "./i18n.js";
import {
	DEFAULT_CARD_SIZE,
	GRID_SIZE,
	MIN_CARD_SIZE,
	MIN_DESCRIPTION_SIZE,
	descriptionInView,
	cardRows,
	effectiveCardDisplay,
	detailRows,
	filterEntities,
	inverseCardRows,
	referencedIds,
	snapToGrid,
	type Board,
	type CanvasCard,
	type CardRow,
	type Entity,
	type EntityType,
	type LineArrow,
	type StoryPage,
} from "@bekbon/core";
import { renderMarkdown } from "./markdown.js";
import { readPreference, writePreference } from "./preferences.js";
import type { Store } from "@bekbon/core";
import { defaultViewport, screenToWorld, snapZoom, stepZoom, zoomAt, type Viewport } from "@bekbon/core";

const ENTITY_MIME = "application/x-entity-id";
const PANEL_COLLAPSED_KEY = "canvas-panel-collapsed";
const ACTIVE_BOARD_KEY = "canvas-active-board";
/** The story mode page last shown in the editor, per board. */
const activePageKey = (boardId: string) => `canvas-active-page:${boardId}`;
/** How long the pan/zoom takes to move to another page, in ms. */
const PAGE_ANIMATION = 450;
/** How long scroll/pinch zooming must pause before the zoom settles on the nearest 10% step, and how long that takes, in ms. */
const ZOOM_SETTLE_DELAY = 150;
const ZOOM_SETTLE_ANIMATION = 120;

/**
 * The board canvas. With `readOnly` (the Viewer) it only displays: no side panel, no board editing,
 * no moving, resizing, removing or dropping cards, and pan/zoom are never saved. With `onExportView`, the
 * viewer offers to export the current board.
 *
 * A board in story mode is shown one page at a time, with a page bar at the bottom and the page's description over the
 * canvas. The editor also shows the cards and drawings of other pages, faded, so they can be shown here too.
 */
export function canvasView(
	store: Store,
	{
		readOnly,
		onEditEntity,
		onExportView,
	}: { readOnly: boolean; onEditEntity?: (entityId: string) => void; onExportView?: (boardId: string) => void },
): HTMLElement {
	let boardId = readPreference(ACTIVE_BOARD_KEY) ?? "";
	const currentBoard = (): Board => store.data.boards.find((b) => b.id === boardId) ?? store.data.boards[0]!;
	boardId = currentBoard().id;

	/** The page shown, in story mode; the viewer always starts on the first. */
	let pageId = readOnly ? "" : (readPreference(activePageKey(boardId)) ?? "");
	/** In the viewer, whether a board in story mode is shown step by step: it starts as the whole board, and its
	 * Story mode button switches (not saved). The editor always shows the steps of a board in story mode. */
	let presenting = false;
	const currentPage = (): StoryPage | null => {
		const { story, pages } = currentBoard();
		return story && (presenting || !readOnly) ? (pages.find((p) => p.id === pageId) ?? pages[0] ?? null) : null;
	};
	/** The pan/zoom saved for what's shown: the page's in story mode, else the board's. */
	const savedViewport = (): Viewport => ({ ...(currentPage()?.viewport ?? currentBoard().viewport) });
	/** Whether a card or drawing is shown on the current page (everything is, outside story mode). */
	const onPage = (id: string): boolean => {
		const page = currentPage();
		return !page || page.cardIds.includes(id) || page.drawingIds.includes(id);
	};

	let viewport: Viewport = savedViewport();
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** Settles scroll/pinch zooming on a step once it pauses (see zoomSmoothly). */
	let zoomSettleTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingSave: (() => void) | null = null;
	let panelCollapsed = readPreference(PANEL_COLLAPSED_KEY) === "true";

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

	view.classList.toggle("story-mode", currentPage() !== null);

	const panel = el("aside", { className: "canvas-panel" });
	const layer = el("div", { className: "canvas-board" });
	const surface = el("div", { className: "canvas-surface" }, layer);
	const zoomLabel = el("span", { className: "zoom-label" });

	// Shapes, lines, text and pen strokes: below the connector lines and cards.
	const drawing = createDrawingLayer({
		store,
		readOnly,
		boardId: () => boardId,
		page: currentPage,
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
		onToolChange: (tool) => surface.classList.toggle("drawing-tool", tool !== "select"),
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
	function saveViewportSoon(): void {
		if (readOnly) return; // the viewer never saves pan or zoom
		clearTimeout(saveTimer);
		const id = boardId;
		const page = currentPage()?.id;
		const next = viewport;
		pendingSave = () => {
			pendingSave = null;
			if (page) store.setPageViewport(id, page, next);
			else store.setViewport(id, next);
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
		stopAnimation();
		if (id !== boardId) presenting = false;
		boardId = id;
		writePreference(ACTIVE_BOARD_KEY, id);
		pageId = readOnly ? "" : (readPreference(activePageKey(id)) ?? "");
		view.classList.toggle("story-mode", currentPage() !== null);
		viewport = savedViewport();
		drawing.deselect();
		applyViewport();
		renderBoardControls();
		renderPanel();
		renderCards();
		renderPageBar();
		renderDescription();
	}

	/** Shows another page in story mode: what it shows fades in, and the pan/zoom moves to the page's. */
	function goToPage(id: string): void {
		flushViewport();
		const before = new Set(currentPage()?.cardIds);
		pageId = id;
		if (!readOnly) writePreference(activePageKey(boardId), id);
		appearing = new Set(currentPage()?.cardIds.filter((cardId) => !before.has(cardId)));
		drawing.deselect();
		renderPanel();
		renderCards();
		renderPageBar();
		renderDescription();
		animateViewport(savedViewport());
	}

	/** The page `step` pages before (negative) or after the current one, if there is one. */
	function stepPage(step: number): void {
		const { pages } = currentBoard();
		const next = pages[pages.findIndex((p) => p.id === currentPage()?.id) + step];
		if (next && currentPage()) goToPage(next.id);
	}

	let animation = 0;

	function stopAnimation(): void {
		cancelAnimationFrame(animation);
	}

	/** Moves the pan/zoom smoothly to `target` (at once if the user prefers less motion), keeping the canvas
	 * center on a straight path. Nothing is saved: the page already has this viewport. */
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
			const t = Math.min(1, (now - start) / PAGE_ANIMATION);
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

	const boardControls = el("div", { className: "board-controls" });

	function renderBoardControls(): void {
		const boards = store.data.boards;
		const select = el(
			"select",
			{ ariaLabel: text.board, onchange: () => switchBoard(select.value) },
			...boards.map((b) => el("option", { value: b.id, selected: b.id === boardId }, b.name)),
		);
		// The viewer only switches boards, and maybe exports the current one.
		if (readOnly) {
			const exportButton = el("button", { type: "button", title: text.exportView, onclick: () => onExportView?.(boardId) }, text.exportButton);
			// A board with steps: shown whole, or step by step from its first step.
			const presentButton = el(
				"button",
				{
					type: "button",
					className: "tool-button",
					title: text.presentHint,
					ariaPressed: String(presenting),
					onclick: () => {
						presenting = !presenting;
						switchBoard(boardId);
					},
				},
				text.storyMode,
			);
			return boardControls.replaceChildren(
				select,
				...(currentBoard().story ? [presentButton] : []),
				...(onExportView ? [exportButton] : []),
			);
		}
		boardControls.replaceChildren(
			select,
			el(
				"button",
				{
					type: "button",
					title: text.newBoard,
					onclick: () => {
						const name = prompt(text.newBoardPrompt, text.defaultBoardName(boards.length + 1));
						if (name !== null) switchBoard(store.addBoard(name).id);
					},
				},
				text.newBoardButton,
			),
			el(
				"button",
				{
					type: "button",
					title: text.renameBoard,
					onclick: () => {
						const name = prompt(text.renameBoard, currentBoard().name);
						if (name === null) return;
						store.renameBoard(boardId, name);
						renderBoardControls();
					},
				},
				text.renameButton,
			),
			el(
				"button",
				{
					type: "button",
					disabled: boards.length <= 1,
					title: boards.length <= 1 ? text.lastBoard : text.deleteBoard,
					onclick: () => {
						const board = currentBoard();
						const cards = board.cards.length;
						if (!confirm(text.confirmDeleteBoard(board.name, cards))) return;
						flushViewport();
						store.deleteBoard(board.id);
						switchBoard(store.data.boards[0]!.id);
					},
				},
				text.delete,
			),
			// Shows the board step by step, like a presentation; switched off, its steps stay for next time.
			el(
				"button",
				{
					type: "button",
					className: "tool-button",
					title: text.storyModeHint,
					ariaPressed: String(currentBoard().story),
					onclick: () => {
						flushViewport();
						store.setStoryMode(boardId, !currentBoard().story, text.defaultPageName(1));
						switchBoard(boardId);
					},
				},
				text.storyMode,
			),
		);
	}

	function setViewport(next: Viewport): void {
		stopAnimation();
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

	// Search and type filter for the side panel; kept for this visit only.
	let panelQuery = "";
	let panelTypeId: string | null = null;
	/** The entity list below the panel's controls; re-rendered on its own, so typing in the search keeps focus. */
	const panelList = el("div", { className: "panel-list" });

	/** Builds the panel once (header, hint, search, type filter); the list itself is drawn by renderPanel. */
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
		panel.replaceChildren(
			el("div", { className: "panel-header" }, el("h2", {}, text.entities), toggle),
			el("p", { className: "muted" }, text.dragOntoCanvas),
			el("div", { className: "panel-filters" }, search, typeFilter),
			panelList,
		);
	}

	function renderPanel(): void {
		if (readOnly) return; // no side panel in the viewer
		const cardCounts = new Map<string, number>();
		for (const card of currentBoard().cards.filter((c) => onPage(c.id))) cardCounts.set(card.entityId, (cardCounts.get(card.entityId) ?? 0) + 1);
		const matches = filterEntities(store.data.entities, { query: panelQuery, typeId: panelTypeId });
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
	const preview = el("article", { className: "canvas-card card-preview", role: "tooltip", id: "card-preview" });
	preview.hidden = true;
	let previewTimer: ReturnType<typeof setTimeout> | undefined;

	function attachPreview(tag: HTMLElement, entityId: string): void {
		tag.tabIndex = 0;
		tag.setAttribute("aria-describedby", preview.id);
		tag.addEventListener("pointerenter", () => {
			clearTimeout(previewTimer);
			// A short delay, so moving across a card doesn't flash previews.
			previewTimer = setTimeout(() => showPreview(tag, entityId), 250);
		});
		tag.addEventListener("pointerleave", hidePreview);
		tag.addEventListener("focus", () => showPreview(tag, entityId));
		tag.addEventListener("blur", hidePreview);
	}

	function showPreview(anchor: HTMLElement, entityId: string): void {
		const entity = store.data.entities.find((e) => e.id === entityId);
		if (!entity || !anchor.isConnected) return;
		const type = store.data.types.find((t) => t.id === entity.typeId);
		const entityNames = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const { header, body } = cardParts(entity, type, entityNames, () => false, { previews: false });
		preview.replaceChildren(header, ...(body ? [body] : []));
		preview.hidden = false;

		// The whole card, as tall as the canvas allows.
		const gap = 6;
		const margin = 8;
		const area = canvasMain.getBoundingClientRect();
		const tag = anchor.getBoundingClientRect();
		preview.style.maxHeight = `${area.height - 2 * margin}px`;
		const { offsetWidth: width, offsetHeight: height } = preview;
		// Fade the bottom only if even the full canvas height isn't enough.
		preview.classList.toggle("clipped", !!body && body.scrollHeight > body.clientHeight);

		// Below the tag if it fits, else above; otherwise as low as fits inside the canvas (it may cover the tag,
		// which is fine because the preview never catches the pointer).
		const tagTop = tag.top - area.top;
		const tagBottom = tag.bottom - area.top;
		let top: number;
		if (tagBottom + gap + height <= area.height - margin) top = tagBottom + gap;
		else if (tagTop - gap - height >= margin) top = tagTop - gap - height;
		else top = Math.max(margin, area.height - margin - height);
		const left = Math.min(Math.max(margin, tag.left - area.left), area.width - width - margin);
		Object.assign(preview.style, { left: `${left}px`, top: `${top}px` });
	}

	function hidePreview(): void {
		clearTimeout(previewTimer);
		preview.hidden = true;
	}

	/** The entity shown in the details panel, and the card that was selected for it (if it's on this board). */
	let selected: { entityId: string; cardId: string | null } | null = null;
	const details = el("aside", { className: "details-panel", ariaLabel: text.details });
	details.hidden = true;

	function select(entityId: string | null, cardId: string | null = null): void {
		selected = entityId ? { entityId, cardId } : null;
		if (entityId) drawing.deselect();
		for (const node of layer.querySelectorAll<HTMLElement>(".canvas-card")) {
			node.classList.toggle("selected", cardId !== null && node.dataset.cardId === cardId);
		}
		renderDetails();
	}

	/** Shows another entity's details, selecting its card if it's on this board. */
	function selectEntity(entityId: string): void {
		select(entityId, currentBoard().cards.find((c) => c.entityId === entityId && onPage(c.id))?.id ?? null);
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
		const types = new Map(store.data.types.map((t) => [t.id, t]));
		const type = types.get(entity.typeId);
		const entityNames = new Map(store.data.entities.map((e) => [e.id, e.name]));

		const bar = el(
			"div",
			{ className: "card-bar" },
			el("span", { className: "card-type" }, type?.name ?? ""),
			el(
				"button",
				{ type: "button", className: "card-remove", title: text.closeDetails, ariaLabel: text.closeDetails, onclick: () => select(null) },
				"×",
			),
		);
		if (type) bar.style.background = type.color;
		const header = el(
			"header",
			{ className: "details-header" },
			bar,
			el("h2", { className: "details-title" }, entity.name),
			...(!readOnly && onEditEntity
				? [
						el(
							"div",
							{ className: "details-actions" },
							el("button", { type: "button", title: text.editInData, onclick: () => onEditEntity(entity.id) }, text.edit),
						),
					]
				: []),
		);

		const section = (title: string, ...content: Node[]) =>
			el("section", { className: "details-section" }, el("h3", {}, title), ...content);
		const rows = detailRows(store.data, entity, entityNames);
		const value = (row: CardRow): HTMLElement => {
			if (row.values.length === 0) return el("dd", { className: "muted" }, "—");
			if (row.kind === "text") return el("dd", { className: "details-text" }, ...row.values);
			if (row.kind === "options") return el("dd", { className: "prop-chips" }, ...row.values.map((v) => el("span", { className: "chip" }, v)));
			// References: tags in the target type's color; clicking one shows that entity's details.
			const color = types.get(row.targetTypeId ?? "")?.color;
			return el(
				"dd",
				{ className: "prop-chips" },
				...row.values.map((name, i) => {
					const tag = el("button", { type: "button", className: "ref-tag", onclick: () => selectEntity(row.entityIds[i]!) }, name);
					if (color) tag.style.background = color;
					return tag;
				}),
			);
		};

		details.replaceChildren(
			header,
			el(
				"div",
				{ className: "details-body" },
				section(
					text.description,
					entity.description.trim()
						? renderMarkdown(entity.description)
						: el("p", { className: "muted" }, text.noDescription),
				),
				...(rows.length > 0
					? [section(text.properties, el("dl", { className: "details-props" }, ...rows.flatMap((row) => [el("dt", {}, row.label), value(row)])))]
					: []),
				...(entity.content.trim() ? [section(text.content, el("p", { className: "details-text" }, entity.content))] : []),
				el("p", { className: "details-id" }, `${text.id}: `, el("span", { className: "mono" }, entity.id)),
			),
		);
	}

	// Escape closes the details panel, the arrow keys page through story mode (the listener removes itself
	// once this view is gone).
	function onKeyDown(e: KeyboardEvent): void {
		if (!view.isConnected) return document.removeEventListener("keydown", onKeyDown);
		if ((e.target as Element).closest("input, select, textarea")) return;
		if (e.key === "Escape" && selected) select(null);
		if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.ctrlKey && !e.metaKey && !e.altKey && currentPage()) {
			e.preventDefault();
			stepPage(e.key === "ArrowLeft" ? -1 : 1);
		}
	}
	document.addEventListener("keydown", onKeyDown);

	/** Lines from `line` reference properties, under the cards. */
	const connectorLayer = svgEl("svg", { class: "connectors", "aria-hidden": "true" });
	/** Property-name labels at the lines' midpoints: above the lines, below the cards. */
	const connectorLabels = el("div", { className: "connector-labels", ariaHidden: "true" });
	/** Card positions and sizes by card id; updated live while dragging or resizing. */
	let cardRects = new Map<string, Rect>();
	/** One entry per drawn reference: from a card to the nearest of the target entity's cards. */
	let links: { fromCardId: string; targetCardIds: string[]; label: string; color: string; arrow: LineArrow }[] = [];
	/** Cards that just came onto the page shown, so they fade in; set when changing pages. */
	let appearing = new Set<string>();

	function renderCards(): void {
		hidePreview(); // its tag is about to be replaced
		const board = currentBoard();
		const entities = new Map(store.data.entities.map((e) => [e.id, e]));
		const entityNames = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const types = new Map(store.data.types.map((t) => [t.id, t]));
		// Lines only connect the cards the page shows.
		const shown = board.cards.filter((c) => onPage(c.id));
		const cardsByEntity = new Map<string, CanvasCard[]>();
		for (const card of shown) cardsByEntity.set(card.entityId, [...(cardsByEntity.get(card.entityId) ?? []), card]);

		cardRects = new Map(shown.map((c) => [c.id, { x: c.x, y: c.y, width: c.width, height: c.height }]));
		links = [];
		const cardNodes = board.cards.flatMap((card) => {
			const entity = entities.get(card.entityId);
			// The editor shows other pages' cards faded (ghosts); the viewer only what the page shows.
			const ghost = !onPage(card.id);
			if (!entity || (ghost && readOnly)) return [];
			const type = types.get(entity.typeId);
			if (ghost) return [cardElement(card, entity, type, entityNames, () => false, true)];
			// Other cards on this board showing the given entity.
			const targetCards = (entityId: string) => (cardsByEntity.get(entityId) ?? []).filter((c) => c.id !== card.id);
			for (const prop of type?.properties ?? []) {
				if (effectiveCardDisplay(prop) !== "line") continue;
				const color = types.get(prop.reference?.typeId ?? "")?.color ?? "";
				for (const id of referencedIds(prop, entity.values[prop.id])) {
					const targets = targetCards(id);
					if (targets.length > 0) {
						links.push({
							fromCardId: card.id,
							targetCardIds: targets.map((c) => c.id),
							label: prop.reference?.lineLabel || prop.name,
							color,
							arrow: prop.reference?.arrow ?? "to",
						});
					}
				}
			}
			return [cardElement(card, entity, type, entityNames, (id) => targetCards(id).length > 0, false)];
		});
		appearing = new Set();
		// The page's description stays on top of the cards. It isn't redrawn with them (so its text keeps focus and
		// whatever was typed): only the nodes before it are replaced.
		if (description.parentNode !== layer) layer.append(description);
		for (const node of [...layer.childNodes]) if (node !== description) node.remove();
		description.before(drawing.element, connectorLayer, connectorLabels, ...cardNodes);
		drawing.render();
		measureCompactCards();
		drawConnectors();
		// On the first render the canvas isn't on the page yet, so heights can only be measured a frame later.
		requestAnimationFrame(() => {
			if (measureCompactCards()) drawConnectors();
		});
		if (selected?.cardId && !shown.some((c) => c.id === selected!.cardId)) selected = { ...selected, cardId: null };
		renderDetails(); // the entity may have changed or been removed
	}

	/**
	 * Sets a compact card's height to what its contents need, rounded up to the grid, so its bottom edge is
	 * on the grid too. Returns that height, or 0 while the card isn't laid out. (offsetHeight ignores the zoom,
	 * so it's in world units.)
	 */
	function fitCompactCard(node: HTMLElement): number {
		node.style.height = "";
		if (node.offsetHeight === 0) return 0;
		const height = Math.ceil(node.offsetHeight / GRID_SIZE) * GRID_SIZE;
		node.style.height = `${height}px`;
		return height;
	}

	/**
	 * Compact cards are as tall as their contents need, not their saved height, so lines must attach to the
	 * fitted height. Returns whether any height changed.
	 */
	function measureCompactCards(): boolean {
		let changed = false;
		for (const node of layer.querySelectorAll<HTMLElement>(".canvas-card.compact")) {
			const id = node.dataset.cardId ?? "";
			const rect = cardRects.get(id);
			const height = fitCompactCard(node);
			if (rect && height > 0 && rect.height !== height) {
				cardRects.set(id, { ...rect, height });
				changed = true;
			}
		}
		return changed;
	}

	function drawConnectors(): void {
		const lines: SVGElement[] = [];
		const labels: HTMLElement[] = [];
		// A line touching a dimmed card is dimmed with it.
		const dimmed = new Set(currentPage()?.dimmedCardIds);
		for (const { fromCardId, targetCardIds, label, color, arrow } of links) {
			const from = cardRects.get(fromCardId);
			const to = from && nearest(from, targetCardIds.flatMap((id) => cardRects.get(id) ?? []));
			if (!from || !to) continue;
			const toCardId = targetCardIds.find((id) => cardRects.get(id) === to);
			const faded = dimmed.has(fromCardId) || (toCardId !== undefined && dimmed.has(toCardId));
			// "from" draws the same curve the other way round, so the arrowhead lands on this card.
			const shape = arrow === "from" ? connector(to, from) : connector(from, to, arrow === "to");
			const { path, mid } = shape;
			lines.push(
				svgEl(
					"g",
					{ class: faded ? "connector dimmed" : "connector" },
					svgEl("path", { class: "connector-line", d: path }),
					...(shape.arrow
						? [svgEl("polygon", { class: "connector-arrow", points: shape.arrow, fill: color || "currentColor" })]
						: []),
				),
			);
			const tag = el("span", { className: faded ? "connector-label dimmed" : "connector-label" }, label);
			Object.assign(tag.style, { left: `${mid.x}px`, top: `${mid.y}px` });
			labels.push(tag);
		}
		connectorLayer.replaceChildren(...lines);
		connectorLabels.replaceChildren(...labels);
	}

	/**
	 * Label/value rows: text as plain text, options as a grey chip, references as tags in the target type's color.
	 * With `previews`, hovering or focusing a reference tag shows that entity's card.
	 */
	function propertyList(rows: CardRow[], previews: boolean): HTMLElement {
		return el(
			"dl",
			{ className: "card-props" },
			...rows.flatMap((row) => {
				const color = store.data.types.find((t) => t.id === row.targetTypeId)?.color;
				const value =
					row.kind === "text"
						? el("dd", { className: "prop-text", title: row.values.join("") }, ...row.values)
						: el(
								"dd",
								{ className: "prop-chips" },
								...row.values.map((v, i) => {
									if (row.kind !== "reference") return el("span", { className: "chip" }, v);
									// Same color as the top bar of the card it points to.
									const tag = el("span", { className: "ref-tag" }, v);
									if (color) tag.style.background = color;
									const entityId = row.entityIds[i];
									if (previews && entityId) attachPreview(tag, entityId);
									return tag;
								}),
							);
				return [el("dt", { title: row.label }, row.label), value];
			}),
		);
	}

	/** Header (colored bar, name) and scrolling body (properties, content) shared by cards and previews. */
	function cardParts(
		entity: Entity,
		type: EntityType | undefined,
		entityNames: ReadonlyMap<string, string>,
		isLinked: (entityId: string) => boolean,
		options: { buttons?: HTMLElement[]; previews: boolean },
	): { header: HTMLElement; body: HTMLElement | null } {
		// Top bar in the type's color: type label (and × on real cards).
		const bar = el(
			"div",
			{ className: "card-bar" },
			el("span", { className: "card-type" }, type?.name ?? ""),
			...(options.buttons ?? []),
		);
		if (type) bar.style.background = type.color;
		const header = el(
			"header",
			{},
			bar,
			// Wraps up to three lines; the full name is in the tooltip.
			el("strong", { className: "card-title", title: entity.name }, entity.name),
		);
		// Properties and content scroll together below the fixed header.
		// Own properties first, then the reverse side of references to this entity (e.g. "responsible for").
		const rows = [
			...(type ? cardRows(type, entity, entityNames, isLinked) : []),
			...inverseCardRows(store.data, entity, entityNames, isLinked),
		];
		// Nothing to show below the name: no body at all (a compact card).
		const content = entity.content.trim();
		const body =
			rows.length > 0 || content
				? el(
						"div",
						{ className: "card-body" },
						...(rows.length > 0 ? [propertyList(rows, options.previews)] : []),
						...(content ? [el("div", { className: "card-content" }, entity.content)] : []),
					)
				: null;
		return { header, body };
	}

	function cardElement(
		card: CanvasCard,
		entity: Entity,
		type: EntityType | undefined,
		entityNames: ReadonlyMap<string, string>,
		isLinked: (entityId: string) => boolean,
		ghost: boolean,
	): HTMLElement {
		const page = currentPage();
		// In story mode, × only takes the card off this page, and + shows another page's card here too.
		const removeButton = readOnly
			? undefined
			: ghost
				? el(
						"button",
						{
							type: "button",
							className: "card-remove",
							ariaLabel: text.showNamedOnPage(entity.name),
							title: text.showOnPage,
							onclick: () => {
								store.showOnPage(boardId, page!.id, card.id);
								renderCards();
								renderPanel();
							},
						},
						"+",
					)
				: el(
						"button",
						{
							type: "button",
							className: "card-remove",
							ariaLabel: page ? text.removeNamedFromPage(entity.name) : text.removeNamedFromCanvas(entity.name),
							title: page ? text.removeFromPage : text.removeFromCanvas,
							onclick: () => {
								store.removeCard(card.id, page?.id);
								renderCards();
								renderPanel();
							},
						},
						"×",
					);
		// In story mode, a card on the page can be dimmed there: shown faded, out of focus.
		const dimmed = !ghost && !!page?.dimmedCardIds.includes(card.id);
		const dimButton =
			readOnly || ghost || !page
				? []
				: [
						el(
							"button",
							{
								type: "button",
								className: "card-dim",
								ariaLabel: text.dimNamedOnPage(entity.name),
								title: text.dimOnPage,
								ariaPressed: String(dimmed),
								onclick: () => {
									store.setDimmed(boardId, page.id, card.id, !dimmed);
									renderCards();
								},
							},
							"◐",
						),
					];
		const { header, body } = cardParts(entity, type, entityNames, isLinked, {
			buttons: [...dimButton, ...(removeButton ? [removeButton] : [])],
			previews: true,
		});
		// Without content a card is as tall as what it shows (bar, name, maybe properties), rounded up to the
		// grid: only its width can be changed. Only cards with content keep a saved height, so long text can be given more or less room.
		const compact = !entity.content.trim();
		const node = el("article", { className: "canvas-card" }, header, ...(body ? [body] : []));
		node.classList.toggle("compact", compact);
		node.classList.toggle("selected", selected?.cardId === card.id);
		node.classList.toggle("ghost", ghost);
		node.classList.toggle("dimmed", dimmed);
		node.classList.toggle("appear", appearing.has(card.id));
		node.dataset.cardId = card.id;
		// Only a click shows the card's details; the browser also fires a click after dragging or resizing,
		// which the drag handlers mark on the card so it can be ignored here.
		node.addEventListener("click", (e) => {
			if (node.dataset.dragged) {
				delete node.dataset.dragged;
				return;
			}
			if (!(e.target as Element).closest("button, .ref-tag, .card-resize")) select(entity.id, card.id);
		});
		Object.assign(node.style, {
			left: `${card.x}px`,
			top: `${card.y}px`,
			width: `${card.width}px`,
			...(compact ? {} : { height: `${card.height}px` }),
		});
		// The viewer only looks: no moving or resizing; nor are other pages' cards moved from here.
		if (readOnly || ghost) return node;

		const resize = el("div", { className: "card-resize", title: text.resize });
		node.append(resize);

		header.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || (e.target as Element).closest("button")) return;
			e.preventDefault();
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
					cardRects.set(card.id, { x, y, width: card.width, height: compact ? node.offsetHeight : card.height });
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

		resize.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			const { zoom } = viewport;
			const size = (dx: number, dy: number) => ({
				width: Math.max(MIN_CARD_SIZE.width, snapToGrid(card.width + dx / zoom)),
				height: compact ? card.height : Math.max(MIN_CARD_SIZE.height, snapToGrid(card.height + dy / zoom)),
			});
			trackPointer(
				e,
				(dx, dy) => {
					const { width, height } = size(dx, dy);
					node.style.width = `${width}px`;
					if (!compact) node.style.height = `${height}px`;
					cardRects.set(card.id, { x: card.x, y: card.y, width, height: compact ? fitCompactCard(node) : height });
					drawConnectors();
				},
				(dx, dy) => {
					const { width, height } = size(dx, dy);
					store.resizeCard(card.id, width, height);
					renderCards();
				},
			);
		});

		return node;
	}

	// With a drawing tool active, pressing anywhere on the canvas except on a card starts a new drawing
	// (in the capture phase, so it wins over panning and selecting).
	if (!readOnly) {
		surface.addEventListener(
			"pointerdown",
			(e) => {
				if (!(e.target as Element).closest(".canvas-card, .page-description")) drawing.startCreate(e);
			},
			{ capture: true },
		);
	}

	// Any drag, pan or zoom on the canvas closes the preview.
	surface.addEventListener("pointerdown", hidePreview, { capture: true });
	surface.addEventListener("wheel", hidePreview, { capture: true, passive: true });

	// Pan by dragging the empty background.
	surface.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 || (e.target !== surface && e.target !== layer)) return;
		stopAnimation();
		const start = viewport;
		surface.classList.add("panning");
		trackPointer(
			e,
			(dx, dy) => {
				viewport = { ...start, x: start.x + dx, y: start.y + dy };
				applyViewport();
			},
			(dx, dy) => {
				surface.classList.remove("panning");
				saveViewportSoon();
				// A click on the empty canvas (no real pan) closes the details and deselects any drawing.
				if (Math.hypot(dx, dy) < CLICK_TOLERANCE) {
					select(null);
					drawing.deselect();
				}
			},
		);
	});

	// Scroll pans; Ctrl/⌘ + scroll (and trackpad pinch) zooms around the pointer.
	surface.addEventListener(
		"wheel",
		(e) => {
			const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
			const rect = surface.getBoundingClientRect();
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				zoomSmoothly(Math.exp(-e.deltaY * scale * 0.01), e.clientX - rect.left, e.clientY - rect.top);
				return;
			}
			const body = (e.target as Element).closest(".card-body");
			if (body && body.scrollHeight > body.clientHeight) return; // let long card bodies scroll
			e.preventDefault();
			setViewport({ ...viewport, x: viewport.x - e.deltaX * scale, y: viewport.y - e.deltaY * scale });
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

	// Drop entities from the side panel, or image files (editor only).
	if (!readOnly) {
		surface.addEventListener("dragover", (e) => {
			if (!e.dataTransfer?.types.includes(ENTITY_MIME) && !e.dataTransfer?.types.includes("Files")) return;
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
			const entityId = e.dataTransfer?.getData(ENTITY_MIME);
			if (!entityId) return;
			e.preventDefault();
			const rect = surface.getBoundingClientRect();
			const world = screenToWorld(viewport, e.clientX - rect.left, e.clientY - rect.top);
			// Drop so the pointer ends up on the card's header, on the grid.
			const x = snapToGrid(world.x - DEFAULT_CARD_SIZE.width / 2);
			store.addCard(boardId, entityId, x, snapToGrid(world.y - 16), currentPage()?.id);
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

	/** Story mode only: bottom center. The viewer only steps back and forth; the editor also names, adds and
	 * deletes pages. */
	const pageBar = el("div", { className: "toolbar-group page-bar", role: "navigation", ariaLabel: text.pages });

	function renderPageBar(): void {
		const page = currentPage();
		pageBar.hidden = !page;
		if (!page) return void pageBar.replaceChildren();
		const { pages } = currentBoard();
		const index = pages.findIndex((p) => p.id === page.id);
		const counter = el("span", { className: "page-counter muted" }, `${index + 1} / ${pages.length}`);
		const prev = el(
			"button",
			{ type: "button", ariaLabel: text.previousPage, title: text.previousPage, disabled: index === 0, onclick: () => stepPage(-1) },
			"‹",
		);
		const next = el(
			"button",
			{ type: "button", ariaLabel: text.nextPage, title: text.nextPage, disabled: index === pages.length - 1, onclick: () => stepPage(1) },
			"›",
		);
		if (readOnly) return pageBar.replaceChildren(prev, el("strong", { className: "page-name" }, page.name), counter, next);

		const name = el("input", {
			className: "page-name",
			value: page.name,
			ariaLabel: text.stepName,
			placeholder: text.stepName,
			onchange: () => store.updatePage(boardId, page.id, { name: name.value.trim() }),
		});
		const copy = el("input", { type: "checkbox", checked: true });
		pageBar.replaceChildren(
			prev,
			counter,
			name,
			next,
			el(
				"button",
				{
					type: "button",
					title: text.addPage,
					onclick: () => {
						const added = store.addPage(boardId, page.id, text.defaultPageName(pages.length + 1), copy.checked);
						if (added) goToPage(added.id);
					},
				},
				text.addPageButton,
			),
			el("label", { className: "page-copy", title: text.copyPageHint }, copy, text.copyPage),
			// The description may be far off after panning (or placed before the page was looked at from here).
			el(
				"button",
				{
					type: "button",
					title: text.descriptionHereHint,
					onclick: () => {
						store.updatePage(boardId, page.id, { descriptionPosition: descriptionInView(viewport) });
						renderDescription();
					},
				},
				text.descriptionHere,
			),
			el(
				"button",
				{
					type: "button",
					disabled: pages.length <= 1,
					title: pages.length <= 1 ? text.lastPage : text.deletePage,
					onclick: () => {
						if (!confirm(text.confirmDeletePage(page.name))) return;
						flushViewport();
						store.removePage(boardId, page.id);
						goToPage((pages[index + 1] ?? pages[index - 1])!.id);
					},
				},
				text.delete,
			),
		);
	}

	/** The page's description on the canvas, like a card: at its saved place in world coordinates, so it pans and
	 * zooms with the cards. The editor edits it and moves it by its handle; the viewer shows it as Markdown, or
	 * nothing when there is none. */
	const description = el("div", { className: "page-description" });

	function placeDescription({ x, y }: { x: number; y: number }): void {
		Object.assign(description.style, { left: `${x}px`, top: `${y}px` });
	}

	/** Width and height in world units, the same in the editor and the viewer (which scrolls longer text). */
	function sizeDescription({ width, height }: { width: number; height: number }): void {
		Object.assign(description.style, { width: `${width}px`, height: `${height}px` });
	}

	function renderDescription(): void {
		const page = currentPage();
		description.hidden = !page || (readOnly && page.description.trim() === "");
		if (!page || description.hidden) return void description.replaceChildren();
		placeDescription(page.descriptionPosition);
		sizeDescription(page.descriptionSize);
		if (readOnly) return void description.replaceChildren(renderMarkdown(page.description));

		const input = el("textarea", {
			value: page.description,
			ariaLabel: text.stepDescription,
			placeholder: text.stepDescription,
			onchange: () => store.updatePage(boardId, page.id, { description: input.value }),
		});
		const handle = el("div", { className: "page-description-handle", title: text.moveDescription }, "⠿");
		handle.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			// From where it is saved now: `page` is the page as it was when the box was drawn, before any drag.
			const start = currentPage()?.descriptionPosition ?? page.descriptionPosition;
			const { zoom } = viewport;
			const at = (dx: number, dy: number) => ({ x: snapToGrid(start.x + dx / zoom), y: snapToGrid(start.y + dy / zoom) });
			trackPointer(
				e,
				(dx, dy) => placeDescription(at(dx, dy)),
				(dx, dy) => {
					if (Math.hypot(dx, dy) >= CLICK_TOLERANCE) store.updatePage(boardId, page.id, { descriptionPosition: at(dx, dy) });
				},
			);
		});
		// Resized at its corner like a card.
		const resize = el("div", { className: "card-resize", title: text.resize });
		resize.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const start = currentPage()?.descriptionSize ?? page.descriptionSize;
			const { zoom } = viewport;
			const size = (dx: number, dy: number) => ({
				width: Math.max(MIN_DESCRIPTION_SIZE.width, snapToGrid(start.width + dx / zoom)),
				height: Math.max(MIN_DESCRIPTION_SIZE.height, snapToGrid(start.height + dy / zoom)),
			});
			trackPointer(
				e,
				(dx, dy) => sizeDescription(size(dx, dy)),
				(dx, dy) => store.updatePage(boardId, page.id, { descriptionSize: size(dx, dy) }),
			);
		});
		description.replaceChildren(handle, input, resize);
	}

	// Each control group has its own place: boards top right, drawing tools on the left edge with their style
	// bar at the bottom left (see CSS), zoom bottom right.
	const toolbar = el("div", { className: "canvas-toolbar" }, el("div", { className: "toolbar-group" }, boardControls));
	const zoomBar = el(
		"div",
		{ className: "toolbar-group canvas-zoom" },
		el("button", { type: "button", ariaLabel: text.zoomOut, title: text.zoomOut, onclick: () => zoomStep(-1) }, "−"),
		zoomLabel,
		el("button", { type: "button", ariaLabel: text.zoomIn, title: text.zoomIn, onclick: () => zoomStep(1) }, "+"),
		// The viewer resets to the board's saved view; the editor to the default.
		el(
			"button",
			{ type: "button", onclick: () => setViewport(readOnly ? savedViewport() : defaultViewport()) },
			text.resetView,
		),
	);

	applyViewport();
	renderBoardControls();
	if (!readOnly) buildPanel();
	renderPanel();
	renderCards();
	renderPageBar();
	renderDescription();
	canvasMain.append(
		surface,
		...(readOnly ? [] : [openPanelButton, drawing.toolbar, drawing.styleBar]),
		toolbar,
		pageBar,
		zoomBar,
		preview,
	);
	view.append(...(readOnly ? [] : [panel]), canvasMain, details);
	return view;
}
