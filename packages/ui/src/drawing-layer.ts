import type { Point } from "@bekbon/core";
import { CLICK_TOLERANCE, el, svgEl, trackPointer } from "./dom.js";
import {
	MIN_BOX_SIZE,
	arrowGeometry,
	drawingBounds,
	moveDrawing,
	moveEndpoint,
	normalizeRect,
	resizeBox,
	simplifyStroke,
	strokePath,
	type Corner,
	type Tool,
} from "./drawings.js";
import { text } from "./i18n.js";
import { DRAWING_COLORS, TEXT_SIZES, isBox, type BoxDrawing, type Drawing, type NewDrawing, type StoryPage } from "@bekbon/core";
import type { Store } from "@bekbon/core";

const TOOLS: readonly { tool: Tool; icon: string; key: string }[] = [
	{ tool: "select", icon: "↖", key: "v" },
	{ tool: "rect", icon: "▭", key: "r" },
	{ tool: "ellipse", icon: "◯", key: "o" },
	{ tool: "line", icon: "╱", key: "l" },
	{ tool: "arrow", icon: "→", key: "a" },
	{ tool: "text", icon: "T", key: "t" },
	{ tool: "pen", icon: "✎", key: "p" },
];

/** Size of a shape or text box created with a click instead of a drag. */
const DEFAULT_SIZE = { rect: { width: 160, height: 100 }, ellipse: { width: 160, height: 100 }, text: { width: 200, height: 40 } };
/** Length of a line or arrow created with a click instead of a drag. */
const DEFAULT_LINE_LENGTH = 120;
const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];
/** Two presses on the same drawing within this time (ms) and distance (px) are a double-click. */
const DOUBLE_CLICK_TIME = 400;
const DOUBLE_CLICK_DISTANCE = 6;

/** Shapes are filled with a light tint of their color; outlines, lines and text use a darker shade. */
export const fillFor = (color: string) => `color-mix(in srgb, ${color} 40%, white)`;
export const strokeFor = (color: string) => `color-mix(in srgb, ${color} 55%, black)`;

export interface DrawingLayer {
	/** The SVG with all drawings; goes into the canvas layer below connectors and cards. */
	readonly element: SVGSVGElement;
	/** Tool buttons (editor only). */
	readonly toolbar: HTMLElement;
	/** Color for new drawings or the selected one, its text size, and Delete (editor only). */
	readonly styleBar: HTMLElement;
	/** Draws the current board's drawings (skipped while text is being edited, so typing isn't interrupted). */
	render(): void;
	/** Handles a pointerdown on the canvas when a drawing tool is active; returns whether it did. */
	startCreate(e: PointerEvent): boolean;
	deselect(): void;
}

/**
 * Shapes, lines, text and pen strokes on a board: drawing them, and (unless read-only) creating, selecting,
 * moving, resizing, recoloring, editing text and deleting them.
 */
export function createDrawingLayer(options: {
	store: Store;
	boardId: () => string;
	/** The storyboard page shown (only its drawings are, others faded in the editor); null on a whiteboard. */
	page: () => StoryPage | null;
	zoom: () => number;
	/** World coordinates of a point on the screen. */
	toWorld: (clientX: number, clientY: number) => Point;
	/** Element that captures the pointer while dragging (it must stay in the page, unlike the redrawn SVG). */
	captureTarget: () => Element;
	readOnly: boolean;
	/** A drawing was selected (or the selection cleared by the layer itself). */
	onSelect: (drawingId: string | null) => void;
	onToolChange: (tool: Tool) => void;
}): DrawingLayer {
	const { store, readOnly } = options;
	const svg = svgEl("svg", { class: "drawings", "aria-hidden": "true" });
	const toolbar = el("div", { className: "toolbar-group drawing-tools", role: "toolbar", ariaLabel: text.drawingTools });
	const styleBar = el("div", { className: "toolbar-group drawing-style", ariaLabel: text.drawingStyle });

	let tool: Tool = "select";
	/** The color for new drawings: the last one picked. */
	let color = DRAWING_COLORS.find((c) => c.name === "Gray")?.value ?? DRAWING_COLORS[0]!.value;
	let selectedId: string | null = null;
	let editingId: string | null = null;
	/** While dragging: the drawing as it looks right now, not saved yet (a new one has the id "draft"). */
	let draft: Drawing | null = null;

	const drawings = (): Drawing[] => store.data.boards.find((b) => b.id === options.boardId())?.drawings ?? [];
	const find = (id: string): Drawing | undefined => (draft?.id === id ? draft : drawings().find((d) => d.id === id));

	function render(): void {
		if (editingId) return;
		draw();
	}

	/** Whether the drawing is on the page shown (always, on a whiteboard). */
	const onPage = (id: string): boolean => options.page()?.drawingIds.includes(id) ?? true;

	function draw(): void {
		// The viewer leaves out other pages' drawings; the editor shows them faded (see drawingNode).
		const shown = drawings()
			.filter((d) => !readOnly || onPage(d.id))
			.map((d) => (draft?.id === d.id ? draft : d));
		if (draft && !shown.some((d) => d.id === draft!.id)) shown.push(draft);
		svg.replaceChildren(...shown.map(drawingNode), ...selectionOverlay(), ...(editingId ? [editor(editingId)] : []));
		renderToolbars();
	}

	function textNode(box: BoxDrawing): SVGForeignObjectElement {
		const label = el(
			"div",
			{ className: `drawing-label size-${box.textSize} ${box.kind === "text" ? "free" : "centered"}` },
			box.text,
		);
		label.style.color = strokeFor(box.color);
		return svgEl("foreignObject", { x: box.x, y: box.y, width: box.width, height: box.height }, label);
	}

	function drawingNode(d: Drawing): SVGGElement {
		const group = svgEl("g", { class: onPage(d.id) || d.id === "draft" ? "drawing" : "drawing ghost", "data-id": d.id });
		const stroke = strokeFor(d.color);
		if (isBox(d)) {
			const shape =
				d.kind === "ellipse"
					? svgEl("ellipse", { cx: d.x + d.width / 2, cy: d.y + d.height / 2, rx: d.width / 2, ry: d.height / 2 })
					: svgEl("rect", { x: d.x, y: d.y, width: d.width, height: d.height, rx: d.kind === "rect" ? 6 : 0 });
			if (d.kind === "text") {
				shape.classList.add("drawing-textbox"); // invisible, but makes the whole box grabbable
			} else {
				shape.classList.add("drawing-shape");
				shape.style.fill = fillFor(d.color);
				shape.style.stroke = stroke;
			}
			group.append(shape);
			if (d.text && d.id !== editingId) group.append(textNode(d));
		} else {
			const [from, to] = d.points as [Point, Point];
			const arrow = d.kind === "arrow" ? arrowGeometry(from, to) : null;
			const path = arrow ? strokePath([from, arrow.lineEnd], false) : strokePath(d.points, d.kind === "pen");
			const line = svgEl("path", { class: "drawing-stroke", d: path });
			line.style.stroke = stroke;
			// A wide invisible copy, so thin lines are easy to click.
			group.append(svgEl("path", { class: "drawing-hit", d: strokePath(d.points, d.kind === "pen") }), line);
			if (arrow) {
				const head = svgEl("polygon", { class: "drawing-arrowhead", points: arrow.head });
				head.style.fill = stroke;
				head.style.stroke = stroke;
				group.append(head);
			}
		}
		if (!readOnly) attachHandlers(group, d.id);
		return group;
	}

	/** The last press on a drawing, to recognize a double-click (see attachHandlers). */
	let lastPress: { id: string; time: number; x: number; y: number } | null = null;

	function attachHandlers(group: SVGGElement, id: string): void {
		// Select on press, move once dragged past the click tolerance; a second press soon after edits the text.
		group.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || tool !== "select") return;
			e.preventDefault();
			e.stopPropagation(); // not a pan

			// The browser's dblclick can't be used: the drag below captures the pointer on the canvas surface,
			// so the browser sends click and dblclick there instead of to this drawing.
			const now = performance.now();
			const isDoubleClick =
				lastPress?.id === id &&
				now - lastPress.time < DOUBLE_CLICK_TIME &&
				Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < DOUBLE_CLICK_DISTANCE;
			lastPress = isDoubleClick ? null : { id, time: now, x: e.clientX, y: e.clientY };
			if (isDoubleClick) {
				const d = find(id);
				if (d && isBox(d)) startEditing(id);
				return;
			}

			select(id);
			const original = find(id);
			if (!original) return;
			const zoom = options.zoom();
			let moving = false;
			trackPointer(
				e,
				(dx, dy) => {
					if (!moving && Math.hypot(dx, dy) < CLICK_TOLERANCE) return;
					moving = true;
					draft = moveDrawing(original, dx / zoom, dy / zoom);
					draw();
				},
				() => {
					if (moving && draft) store.replaceDrawing(draft);
					draft = null;
					draw();
				},
				options.captureTarget(),
			);
		});
	}

	/** Dashed outline around the selected drawing, with handles to resize boxes or move line ends. */
	function selectionOverlay(): SVGElement[] {
		const selected = selectedId ? find(selectedId) : undefined;
		if (readOnly || !selected) return [];
		const zoom = options.zoom();
		const pad = 4 / zoom;
		const size = 9 / zoom;
		const b = drawingBounds(selected);
		const outline = svgEl("rect", {
			class: "selection-outline",
			x: b.x - pad,
			y: b.y - pad,
			width: b.width + 2 * pad,
			height: b.height + 2 * pad,
		});
		outline.style.strokeWidth = String(1.5 / zoom);
		outline.style.strokeDasharray = `${4 / zoom} ${3 / zoom}`;

		const handle = (at: Point, cursor: string, onDrag: (dx: number, dy: number) => Drawing): SVGElement => {
			const node = svgEl("rect", { class: "selection-handle", x: at.x - size / 2, y: at.y - size / 2, width: size, height: size });
			node.style.strokeWidth = String(1.5 / zoom);
			node.style.cursor = cursor;
			node.addEventListener("pointerdown", (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				trackPointer(
					e,
					(dx, dy) => {
						draft = onDrag(dx / zoom, dy / zoom);
						draw();
					},
					() => {
						if (draft) store.replaceDrawing(draft);
						draft = null;
						draw();
					},
					options.captureTarget(),
				);
			});
			return node;
		};

		if (isBox(selected)) {
			const corner = (c: Corner): Point => ({
				x: c.endsWith("w") ? selected.x : selected.x + selected.width,
				y: c.startsWith("n") ? selected.y : selected.y + selected.height,
			});
			return [
				outline,
				...CORNERS.map((c) =>
					handle(corner(c), c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize", (dx, dy) => resizeBox(selected, c, dx, dy)),
				),
			];
		}
		if (selected.kind === "pen") return [outline]; // strokes can be moved, not reshaped
		return [
			outline,
			...([0, 1] as const).map((i) => handle(selected.points[i]!, "move", (dx, dy) => moveEndpoint(selected, i, dx, dy))),
		];
	}

	/** A textarea over the box; leaving it saves the text (an empty free text box is removed). */
	function editor(id: string): SVGForeignObjectElement {
		const box = find(id) as BoxDrawing;
		const input = el("textarea", {
			className: `drawing-editor size-${box.textSize} ${box.kind === "text" ? "free" : "centered"}`,
			value: box.text,
			ariaLabel: text.tools.text,
		});
		input.style.color = strokeFor(box.color);
		input.addEventListener("keydown", (e) => {
			e.stopPropagation(); // typed letters aren't tool shortcuts
			if (e.key === "Escape") input.blur();
		});
		input.addEventListener("blur", () => {
			if (editingId !== id) return;
			editingId = null;
			const latest = find(id);
			if (latest && isBox(latest)) {
				if (latest.kind === "text" && input.value.trim() === "") {
					store.removeDrawing(id);
					if (selectedId === id) selectedId = null;
				} else {
					store.replaceDrawing({ ...latest, text: input.value });
				}
			}
			draw();
		});
		// Focus once it's in the page (right after this render).
		requestAnimationFrame(() => {
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
		});
		return svgEl("foreignObject", { class: "drawing-editor-box", x: box.x, y: box.y, width: box.width, height: box.height }, input);
	}

	function startEditing(id: string): void {
		select(id);
		editingId = id;
		draw();
	}

	function select(id: string | null): void {
		if (selectedId === id) return;
		selectedId = id;
		draw();
		options.onSelect(id);
	}

	function setTool(next: Tool): void {
		tool = next;
		if (next !== "select") select(null);
		renderToolbars();
		options.onToolChange(next);
	}

	function startCreate(e: PointerEvent): boolean {
		if (readOnly || tool === "select" || e.button !== 0) return false;
		e.preventDefault();
		e.stopPropagation();
		select(null);
		const kind = tool;
		const start = options.toWorld(e.clientX, e.clientY);

		if (kind === "text") {
			const added = store.addDrawing(
				options.boardId(),
				{
					kind: "text",
					x: start.x,
					y: start.y - DEFAULT_SIZE.text.height / 2,
					...DEFAULT_SIZE.text,
					color,
					text: "",
					textSize: "m",
				},
				options.page()?.id,
			);
			setTool("select");
			startEditing(added.id);
			return true;
		}

		const zoom = options.zoom();
		const pen: Point[] = [start];
		const at = (dx: number, dy: number): Point => ({ x: start.x + dx / zoom, y: start.y + dy / zoom });
		const shape = (end: Point): NewDrawing => {
			if (kind === "rect" || kind === "ellipse") {
				return { kind, ...normalizeRect(start, end), color, text: "", textSize: "m" };
			}
			return { kind, points: kind === "pen" ? [...pen] : [start, end], color };
		};
		trackPointer(
			e,
			(dx, dy) => {
				const end = at(dx, dy);
				if (kind === "pen") pen.push(end);
				draft = { ...shape(end), id: "draft" } as Drawing;
				draw();
			},
			(dx, dy) => {
				draft = null;
				const dragged = Math.hypot(dx, dy) >= CLICK_TOLERANCE;
				let created: NewDrawing | null;
				if (kind === "pen") {
					created = dragged ? { kind, points: simplifyStroke(pen), color } : null;
				} else if (kind === "rect" || kind === "ellipse") {
					const box = dragged ? normalizeRect(start, at(dx, dy)) : { ...start, ...DEFAULT_SIZE[kind] };
					created = {
						kind,
						...box,
						width: Math.max(MIN_BOX_SIZE, box.width),
						height: Math.max(MIN_BOX_SIZE, box.height),
						color,
						text: "",
						textSize: "m",
					};
				} else {
					created = { kind, points: [start, dragged ? at(dx, dy) : { x: start.x + DEFAULT_LINE_LENGTH, y: start.y }], color };
				}
				const added = created && store.addDrawing(options.boardId(), created, options.page()?.id);
				if (kind === "pen") {
					draw(); // the pen stays active for the next stroke
				} else {
					setTool("select");
					if (added) select(added.id);
					draw();
				}
			},
			options.captureTarget(),
		);
		return true;
	}

	/** Deletes the selected drawing — with `pageId`, only takes it off that page. */
	function removeSelected(pageId?: string): void {
		if (!selectedId) return;
		store.removeDrawing(selectedId, pageId);
		selectedId = null;
		draw();
		options.onSelect(null);
	}

	function update(change: (d: Drawing) => Drawing): void {
		const selected = selectedId ? find(selectedId) : undefined;
		if (selected) store.replaceDrawing(change(selected));
		draw();
	}

	function renderToolbars(): void {
		if (readOnly) return;
		toolbar.replaceChildren(
			...TOOLS.map(({ tool: t, icon, key }) => {
				const button = el(
					"button",
					{
						type: "button",
						className: "tool-button",
						title: `${text.tools[t]} (${key.toUpperCase()})`,
						ariaLabel: text.tools[t],
						ariaPressed: String(t === tool),
						onclick: () => setTool(t),
					},
					icon,
				);
				return button;
			}),
		);

		// The color applies to the selected drawing, or else to the next one drawn. The bar is only shown
		// while drawing or with a drawing selected, so it isn't in the way while arranging cards.
		const selected = selectedId ? find(selectedId) : undefined;
		const page = options.page();
		const current = selected?.color ?? color;
		styleBar.hidden = tool === "select" && !selected;
		styleBar.replaceChildren(
			...DRAWING_COLORS.map(({ name, value }) => {
				const swatch = el("button", {
					type: "button",
					className: "swatch toolbar-swatch",
					title: text.colorNames[name] ?? name,
					ariaLabel: text.colorNames[name] ?? name,
					ariaPressed: String(value === current),
					onclick: () => {
						color = value;
						update((d) => ({ ...d, color: value }));
					},
				});
				swatch.style.background = value;
				return swatch;
			}),
			...(selected && isBox(selected)
				? TEXT_SIZES.map((size) =>
						el(
							"button",
							{
								type: "button",
								className: "tool-button",
								title: `${text.textSize}: ${text.textSizes[size]}`,
								ariaPressed: String(size === selected.textSize),
								onclick: () => update((d) => (isBox(d) ? { ...d, textSize: size } : d)),
							},
							size.toUpperCase(),
						),
					)
				: []),
			// On a storyboard: show another page's drawing here too, or take one off this page only.
			...(selected && page && !onPage(selected.id)
				? [el("button", { type: "button", onclick: () => (store.showOnPage(options.boardId(), page.id, selected.id), draw()) }, text.showOnPage)]
				: []),
			...(selected && page && onPage(selected.id)
				? [el("button", { type: "button", onclick: () => removeSelected(page.id) }, text.removeFromPage)]
				: []),
			...(selected
				? [el("button", { type: "button", title: text.deleteDrawing, onclick: () => removeSelected() }, text.delete)]
				: []),
		);
	}

	// Tool shortcuts, Delete for the selected drawing, Escape back to the select tool or to no selection.
	function onKeyDown(e: KeyboardEvent): void {
		if (!svg.isConnected) return document.removeEventListener("keydown", onKeyDown); // the canvas is gone
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if ((e.target as Element).closest?.("input, select, textarea, [contenteditable]")) return;
		if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
			e.preventDefault();
			removeSelected(options.page()?.id); // on a storyboard, like a card's ×: off this page
		} else if (e.key === "Escape") {
			if (tool !== "select") setTool("select");
			else if (selectedId) select(null);
		} else {
			const shortcut = TOOLS.find((t) => t.key === e.key.toLowerCase());
			if (shortcut) setTool(shortcut.tool);
		}
	}
	if (!readOnly) document.addEventListener("keydown", onKeyDown);

	draw();
	return {
		element: svg,
		toolbar,
		styleBar,
		render,
		startCreate,
		deselect(): void {
			if (!selectedId) return;
			selectedId = null;
			draw();
		},
	};
}
