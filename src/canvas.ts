import { connector, nearest, type Rect } from "./connectors.js";
import { el, svgEl, typeDot } from "./dom.js";
import {
	DEFAULT_CARD_SIZE,
	MIN_CARD_SIZE,
	cardRows,
	effectiveCardDisplay,
	referencedIds,
	type Board,
	type CanvasCard,
	type CardRow,
	type Entity,
	type EntityType,
} from "./model.js";
import type { Store } from "./store.js";
import { defaultViewport, screenToWorld, zoomAt, type Viewport } from "./viewport.js";

const ENTITY_MIME = "application/x-entity-id";
/** Per-browser UI preferences, kept outside the app data. */
const PANEL_COLLAPSED_KEY = "canvas-panel-collapsed";
const ACTIVE_BOARD_KEY = "canvas-active-board";

function readPreference(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writePreference(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage blocked: the choice just isn't remembered.
	}
}
/** Spacing of the background dot grid, in world units. */
const GRID = 24;

/** Follows a pointer from pointerdown until release, reporting the movement in screen pixels. */
function trackPointer(
	e: PointerEvent,
	onMove: (dx: number, dy: number) => void,
	onEnd: (dx: number, dy: number) => void,
): void {
	const target = e.currentTarget as HTMLElement;
	const startX = e.clientX;
	const startY = e.clientY;
	let dx = 0;
	let dy = 0;
	target.setPointerCapture(e.pointerId);
	const move = (ev: PointerEvent) => {
		dx = ev.clientX - startX;
		dy = ev.clientY - startY;
		onMove(dx, dy);
	};
	const end = () => {
		target.removeEventListener("pointermove", move);
		target.removeEventListener("pointerup", end);
		target.removeEventListener("pointercancel", end);
		onEnd(dx, dy);
	};
	target.addEventListener("pointermove", move);
	target.addEventListener("pointerup", end);
	target.addEventListener("pointercancel", end);
}

export function canvasView(store: Store): HTMLElement {
	let boardId = readPreference(ACTIVE_BOARD_KEY) ?? "";
	const currentBoard = (): Board => store.data.boards.find((b) => b.id === boardId) ?? store.data.boards[0]!;
	boardId = currentBoard().id;

	let viewport: Viewport = { ...currentBoard().viewport };
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let pendingSave: (() => void) | null = null;
	let panelCollapsed = readPreference(PANEL_COLLAPSED_KEY) === "true";

	const view = el("div", { className: panelCollapsed ? "canvas-view panel-collapsed" : "canvas-view" });

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
			title: "Show entities",
			ariaLabel: "Show entities",
			ariaExpanded: String(!panelCollapsed),
			onclick: () => setPanelCollapsed(false),
		},
		"»",
	);

	const panel = el("aside", { className: "canvas-panel" });
	const layer = el("div", { className: "canvas-board" });
	const surface = el("div", { className: "canvas-surface" }, layer);
	const zoomLabel = el("span", { className: "zoom-label" });

	function applyViewport(): void {
		layer.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
		const grid = GRID * viewport.zoom;
		surface.style.backgroundSize = `${grid}px ${grid}px`;
		surface.style.backgroundPosition = `${viewport.x}px ${viewport.y}px`;
		zoomLabel.textContent = `${Math.round(viewport.zoom * 100)}%`;
	}

	/** Panning and zooming fire many events; save once they settle. */
	function saveViewportSoon(): void {
		clearTimeout(saveTimer);
		const id = boardId;
		const next = viewport;
		pendingSave = () => {
			pendingSave = null;
			store.setViewport(id, next);
		};
		saveTimer = setTimeout(() => pendingSave?.(), 250);
	}

	/** Saves a scheduled viewport change right away, e.g. before switching boards. */
	function flushViewport(): void {
		clearTimeout(saveTimer);
		pendingSave?.();
	}

	function switchBoard(id: string): void {
		flushViewport();
		boardId = id;
		writePreference(ACTIVE_BOARD_KEY, id);
		viewport = { ...currentBoard().viewport };
		applyViewport();
		renderBoardControls();
		renderPanel();
		renderCards();
	}

	const boardControls = el("div", { className: "board-controls" });

	function renderBoardControls(): void {
		const boards = store.data.boards;
		const select = el(
			"select",
			{ ariaLabel: "Board", onchange: () => switchBoard(select.value) },
			...boards.map((b) => el("option", { value: b.id, selected: b.id === boardId }, b.name)),
		);
		boardControls.replaceChildren(
			select,
			el(
				"button",
				{
					type: "button",
					title: "New board",
					onclick: () => {
						const name = prompt("Name of the new board", `Board ${boards.length + 1}`);
						if (name !== null) switchBoard(store.addBoard(name).id);
					},
				},
				"New",
			),
			el(
				"button",
				{
					type: "button",
					title: "Rename board",
					onclick: () => {
						const name = prompt("Rename board", currentBoard().name);
						if (name === null) return;
						store.renameBoard(boardId, name);
						renderBoardControls();
					},
				},
				"Rename",
			),
			el(
				"button",
				{
					type: "button",
					disabled: boards.length <= 1,
					title: boards.length <= 1 ? "The last board can't be deleted" : "Delete board",
					onclick: () => {
						const board = currentBoard();
						const cards = board.cards.length;
						if (!confirm(`Delete board "${board.name}" and its ${cards} cards? The entities stay.`)) return;
						flushViewport();
						store.deleteBoard(board.id);
						switchBoard(store.data.boards[0]!.id);
					},
				},
				"Delete",
			),
		);
	}

	function setViewport(next: Viewport): void {
		viewport = next;
		applyViewport();
		saveViewportSoon();
	}

	function zoomBy(factor: number, sx = surface.clientWidth / 2, sy = surface.clientHeight / 2): void {
		setViewport(zoomAt(viewport, viewport.zoom * factor, sx, sy));
	}

	function renderPanel(): void {
		const cardCounts = new Map<string, number>();
		for (const card of currentBoard().cards) cardCounts.set(card.entityId, (cardCounts.get(card.entityId) ?? 0) + 1);
		const groups = store.data.types
			.map((type) => ({ type, entities: store.data.entities.filter((e) => e.typeId === type.id) }))
			.filter((g) => g.entities.length > 0);

		const toggle = el(
			"button",
			{
				type: "button",
				className: "panel-toggle",
				title: "Hide entities",
				ariaLabel: "Hide entities",
				onclick: () => setPanelCollapsed(true),
			},
			"«",
		);

		panel.replaceChildren(
			el("div", { className: "panel-header" }, el("h2", {}, "Entities"), toggle),
			el("p", { className: "muted" }, "Drag onto the canvas."),
			...(groups.length === 0 ? [el("p", { className: "muted" }, "No entities yet. Create some in the Data view.")] : []),
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
								entity.name,
								...(count > 0 ? [el("span", { className: "muted" }, count > 1 ? ` · on canvas ×${count}` : " · on canvas")] : []),
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

	/** Lines from `line` reference properties, under the cards. */
	const connectorLayer = svgEl("svg", { class: "connectors", "aria-hidden": "true" });
	/** Card positions and sizes by card id; updated live while dragging or resizing. */
	let cardRects = new Map<string, Rect>();
	/** One entry per drawn reference: from a card to the nearest of the target entity's cards. */
	let links: { fromCardId: string; targetCardIds: string[]; label: string; color: string }[] = [];

	function renderCards(): void {
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
				const color = types.get(prop.reference?.typeId ?? "")?.color ?? "";
				for (const id of referencedIds(prop, entity.values[prop.id])) {
					const targets = targetCards(id);
					if (targets.length > 0) {
						links.push({ fromCardId: card.id, targetCardIds: targets.map((c) => c.id), label: prop.name, color });
					}
				}
			}
			return [cardElement(card, entity, type, entityNames, (id) => targetCards(id).length > 0)];
		});
		layer.replaceChildren(connectorLayer, ...cardNodes);
		drawConnectors();
	}

	function drawConnectors(): void {
		connectorLayer.replaceChildren(
			...links.flatMap(({ fromCardId, targetCardIds, label, color }) => {
				const from = cardRects.get(fromCardId);
				const to = from && nearest(from, targetCardIds.flatMap((id) => cardRects.get(id) ?? []));
				if (!from || !to) return [];
				const { path, mid, arrow } = connector(from, to);
				return [
					svgEl(
						"g",
						{ class: "connector" },
						svgEl("path", { class: "connector-line", d: path }),
						svgEl("polygon", { class: "connector-arrow", points: arrow, fill: color || "currentColor" }),
						svgEl("text", { class: "connector-label", x: mid.x, y: mid.y }, label),
					),
				];
			}),
		);
	}

	/** Label/value rows: text as plain text, options as a grey chip, references as tags in the target type's color. */
	function propertyList(rows: CardRow[]): HTMLElement {
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
								...row.values.map((v) => {
									if (row.kind !== "reference") return el("span", { className: "chip" }, v);
									// Same color as the top bar of the card it points to.
									const tag = el("span", { className: "ref-tag" }, v);
									if (color) tag.style.background = color;
									return tag;
								}),
							);
				return [el("dt", { title: row.label }, row.label), value];
			}),
		);
	}

	function cardElement(
		card: CanvasCard,
		entity: Entity,
		type: EntityType | undefined,
		entityNames: ReadonlyMap<string, string>,
		isLinked: (entityId: string) => boolean,
	): HTMLElement {
		// Top bar in the type's color: type label and ×.
		const bar = el(
			"div",
			{ className: "card-bar" },
			el("span", { className: "card-type" }, type?.name ?? ""),
			el(
				"button",
				{
					type: "button",
					className: "card-remove",
					ariaLabel: `Remove ${entity.name} from canvas`,
					title: "Remove from canvas",
					onclick: () => {
						store.removeCard(card.id);
						renderCards();
						renderPanel();
					},
				},
				"×",
			),
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
		const rows = type ? cardRows(type, entity, entityNames, isLinked) : [];
		const body = el(
			"div",
			{ className: "card-body" },
			...(rows.length > 0 ? [propertyList(rows)] : []),
			...(entity.content.trim()
				? [el("div", { className: "card-content" }, entity.content)]
				: rows.length === 0
					? [el("div", { className: "card-content muted" }, "No content")]
					: []),
		);
		const resize = el("div", { className: "card-resize", title: "Resize" });
		const node = el("article", { className: "canvas-card" }, header, body, resize);
		Object.assign(node.style, {
			left: `${card.x}px`,
			top: `${card.y}px`,
			width: `${card.width}px`,
			height: `${card.height}px`,
		});

		header.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || (e.target as Element).closest("button")) return;
			e.preventDefault();
			layer.append(node); // on top while dragging
			const { zoom } = viewport;
			trackPointer(
				e,
				(dx, dy) => {
					const x = card.x + dx / zoom;
					const y = card.y + dy / zoom;
					node.style.left = `${x}px`;
					node.style.top = `${y}px`;
					cardRects.set(card.id, { x, y, width: card.width, height: card.height });
					drawConnectors();
				},
				(dx, dy) => {
					store.moveCard(card.id, card.x + dx / zoom, card.y + dy / zoom);
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
				width: Math.max(MIN_CARD_SIZE.width, card.width + dx / zoom),
				height: Math.max(MIN_CARD_SIZE.height, card.height + dy / zoom),
			});
			trackPointer(
				e,
				(dx, dy) => {
					const { width, height } = size(dx, dy);
					node.style.width = `${width}px`;
					node.style.height = `${height}px`;
					cardRects.set(card.id, { x: card.x, y: card.y, width, height });
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

	// Pan by dragging the empty background.
	surface.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 || (e.target !== surface && e.target !== layer)) return;
		const start = viewport;
		surface.classList.add("panning");
		trackPointer(
			e,
			(dx, dy) => {
				viewport = { ...start, x: start.x + dx, y: start.y + dy };
				applyViewport();
			},
			() => {
				surface.classList.remove("panning");
				saveViewportSoon();
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
				zoomBy(Math.exp(-e.deltaY * scale * 0.01), e.clientX - rect.left, e.clientY - rect.top);
				return;
			}
			const body = (e.target as Element).closest(".card-body");
			if (body && body.scrollHeight > body.clientHeight) return; // let long card bodies scroll
			e.preventDefault();
			setViewport({ ...viewport, x: viewport.x - e.deltaX * scale, y: viewport.y - e.deltaY * scale });
		},
		{ passive: false },
	);

	// Drop entities from the side panel.
	surface.addEventListener("dragover", (e) => {
		if (!e.dataTransfer?.types.includes(ENTITY_MIME)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	});
	surface.addEventListener("drop", (e) => {
		const entityId = e.dataTransfer?.getData(ENTITY_MIME);
		if (!entityId) return;
		e.preventDefault();
		const rect = surface.getBoundingClientRect();
		const world = screenToWorld(viewport, e.clientX - rect.left, e.clientY - rect.top);
		// Drop so the pointer ends up on the card's header.
		store.addCard(boardId, entityId, world.x - DEFAULT_CARD_SIZE.width / 2, world.y - 16);
		renderCards();
		renderPanel();
	});

	// Two groups that each stay on one line; on a narrow canvas the zoom group moves below.
	const toolbar = el(
		"div",
		{ className: "canvas-toolbar" },
		el("div", { className: "toolbar-group" }, boardControls),
		el(
			"div",
			{ className: "toolbar-group" },
			el("button", { type: "button", ariaLabel: "Zoom out", onclick: () => zoomBy(1 / 1.2) }, "−"),
			zoomLabel,
			el("button", { type: "button", ariaLabel: "Zoom in", onclick: () => zoomBy(1.2) }, "+"),
			el("button", { type: "button", onclick: () => setViewport(defaultViewport()) }, "Reset view"),
		),
	);

	applyViewport();
	renderBoardControls();
	renderPanel();
	renderCards();
	view.append(panel, el("div", { className: "canvas-main" }, surface, openPanelButton, toolbar));
	return view;
}
