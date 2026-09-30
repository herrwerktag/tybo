import { el } from "./dom.js";
import { DEFAULT_CARD_SIZE, MIN_CARD_SIZE, type CanvasCard, type Entity } from "./model.js";
import type { Store } from "./store.js";
import { defaultViewport, screenToWorld, zoomAt, type Viewport } from "./viewport.js";

const ENTITY_MIME = "application/x-entity-id";
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
	let viewport: Viewport = { ...store.data.canvas.viewport };
	let saveTimer: ReturnType<typeof setTimeout> | undefined;

	const panel = el("aside", { className: "canvas-panel" });
	const board = el("div", { className: "canvas-board" });
	const surface = el("div", { className: "canvas-surface" }, board);
	const zoomLabel = el("span", { className: "zoom-label" });

	function applyViewport(): void {
		board.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
		const grid = GRID * viewport.zoom;
		surface.style.backgroundSize = `${grid}px ${grid}px`;
		surface.style.backgroundPosition = `${viewport.x}px ${viewport.y}px`;
		zoomLabel.textContent = `${Math.round(viewport.zoom * 100)}%`;
	}

	/** Panning and zooming fire many events; save once they settle. */
	function saveViewportSoon(): void {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => store.setViewport(viewport), 250);
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
		const placed = new Set(store.data.canvas.cards.map((c) => c.entityId));
		const groups = store.data.types
			.map((type) => ({ type, entities: store.data.entities.filter((e) => e.typeId === type.id) }))
			.filter((g) => g.entities.length > 0);

		panel.replaceChildren(
			el("h2", {}, "Entities"),
			el("p", { className: "muted" }, "Drag onto the canvas."),
			...(groups.length === 0 ? [el("p", { className: "muted" }, "No entities yet. Create some in the Data view.")] : []),
			...groups.map(({ type, entities }) =>
				el(
					"div",
					{ className: "panel-group" },
					el("h3", {}, type.name),
					el(
						"ul",
						{},
						...entities.map((entity) => {
							const onCanvas = placed.has(entity.id);
							const item = el(
								"li",
								{ className: onCanvas ? "panel-item placed" : "panel-item", draggable: true },
								entity.name,
								...(onCanvas ? [el("span", { className: "muted" }, " · on canvas")] : []),
							);
							item.addEventListener("dragstart", (e) => {
								if (!e.dataTransfer) return;
								e.dataTransfer.setData(ENTITY_MIME, entity.id);
								e.dataTransfer.effectAllowed = "copyMove";
							});
							return item;
						}),
					),
				),
			),
		);
	}

	function renderCards(): void {
		const entities = new Map(store.data.entities.map((e) => [e.id, e]));
		const typeNames = new Map(store.data.types.map((t) => [t.id, t.name]));
		board.replaceChildren(
			...store.data.canvas.cards.flatMap((card) => {
				const entity = entities.get(card.entityId);
				return entity ? [cardElement(card, entity, typeNames.get(entity.typeId) ?? "")] : [];
			}),
		);
	}

	function cardElement(card: CanvasCard, entity: Entity, typeName: string): HTMLElement {
		const header = el(
			"header",
			{},
			el("strong", {}, entity.name),
			el("span", { className: "muted" }, typeName),
			el(
				"button",
				{
					type: "button",
					className: "card-remove",
					ariaLabel: `Remove ${entity.name} from canvas`,
					title: "Remove from canvas",
					onclick: () => {
						store.removeCard(entity.id);
						renderCards();
						renderPanel();
					},
				},
				"×",
			),
		);
		const content = entity.content.trim()
			? el("div", { className: "card-content" }, entity.content)
			: el("div", { className: "card-content muted" }, "No content");
		const resize = el("div", { className: "card-resize", title: "Resize" });
		const node = el("article", { className: "canvas-card" }, header, content, resize);
		Object.assign(node.style, {
			left: `${card.x}px`,
			top: `${card.y}px`,
			width: `${card.width}px`,
			height: `${card.height}px`,
		});

		header.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || (e.target as Element).closest("button")) return;
			e.preventDefault();
			board.append(node); // on top while dragging
			const { zoom } = viewport;
			trackPointer(
				e,
				(dx, dy) => {
					node.style.left = `${card.x + dx / zoom}px`;
					node.style.top = `${card.y + dy / zoom}px`;
				},
				(dx, dy) => {
					store.placeCard(entity.id, card.x + dx / zoom, card.y + dy / zoom);
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
				},
				(dx, dy) => {
					const { width, height } = size(dx, dy);
					store.resizeCard(entity.id, width, height);
					renderCards();
				},
			);
		});

		return node;
	}

	// Pan by dragging the empty background.
	surface.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 || (e.target !== surface && e.target !== board)) return;
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
			const content = (e.target as Element).closest(".card-content");
			if (content && content.scrollHeight > content.clientHeight) return; // let long content scroll
			e.preventDefault();
			setViewport({ ...viewport, x: viewport.x - e.deltaX * scale, y: viewport.y - e.deltaY * scale });
		},
		{ passive: false },
	);

	// Drop entities from the side panel.
	surface.addEventListener("dragover", (e) => {
		if (!e.dataTransfer?.types.includes(ENTITY_MIME)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
	});
	surface.addEventListener("drop", (e) => {
		const entityId = e.dataTransfer?.getData(ENTITY_MIME);
		if (!entityId) return;
		e.preventDefault();
		const rect = surface.getBoundingClientRect();
		const world = screenToWorld(viewport, e.clientX - rect.left, e.clientY - rect.top);
		// Drop so the pointer ends up on the card's header.
		store.placeCard(entityId, world.x - DEFAULT_CARD_SIZE.width / 2, world.y - 16);
		renderCards();
		renderPanel();
	});

	const toolbar = el(
		"div",
		{ className: "canvas-toolbar" },
		el("button", { type: "button", ariaLabel: "Zoom out", onclick: () => zoomBy(1 / 1.2) }, "−"),
		zoomLabel,
		el("button", { type: "button", ariaLabel: "Zoom in", onclick: () => zoomBy(1.2) }, "+"),
		el("button", { type: "button", onclick: () => setViewport(defaultViewport()) }, "Reset view"),
	);

	applyViewport();
	renderPanel();
	renderCards();
	return el("div", { className: "canvas-view" }, panel, el("div", { className: "canvas-main" }, surface, toolbar));
}
