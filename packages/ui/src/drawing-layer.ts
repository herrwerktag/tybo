import type { Point } from "@bekbon/core";
import { CLICK_TOLERANCE, el, svgEl, trackPointer } from "./dom.js";
import {
	MIN_BOX_SIZE,
	arrowGeometry,
	contentBounds,
	drawingBounds,
	imageRect,
	moveDrawing,
	moveEndpoint,
	normalizeRect,
	resizeBox,
	resizeImage,
	simplifyStroke,
	strokePath,
	type Corner,
	type Tool,
} from "./drawings.js";
import { text } from "./i18n.js";
import {
	DRAWING_COLORS,
	TEXT_SIZES,
	hasRect,
	isBox,
	isImage,
	isSymbol,
	type BoxDrawing,
	type Drawing,
	type LibraryDrawing,
	type NewDrawing,
	type Rect,
	type StoryPage,
} from "@bekbon/core";
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
/** Pictures larger than this (in pixels, on the longer side) are scaled down before they're stored. */
const MAX_STORED_IMAGE_PIXELS = 1600;
/** Room around a library drawing's content where it's shown (in its own units), so strokes and arrowheads at the
 * edge aren't cut off. */
const PICTURE_PADDING = 8;
/** The size a library drawing without any content is placed at. */
const EMPTY_SYMBOL_SIZE = 96;

/** Whose drawings a layer shows and edits: a board's, or a library drawing's (in the library's editor). */
export type DrawingOwner = { boardId: string } | { libraryId: string };

/** Shapes are filled with a light tint of their color; outlines, lines and text use a darker shade. */
export const fillFor = (color: string) => `color-mix(in srgb, ${color} 40%, white)`;
export const strokeFor = (color: string) => `color-mix(in srgb, ${color} 55%, black)`;

/** The SVG elements showing a drawing, without any handlers. A placed library drawing shows that drawing as it is now
 * in `library`, fitted into its box. Text is left out with `withText: false` (while it's being edited). */
function drawingShape(d: Drawing, library: readonly LibraryDrawing[], withText = true): SVGElement[] {
	if (isImage(d)) {
		return [svgEl("image", { class: "drawing-image", href: d.src, x: d.x, y: d.y, width: d.width, height: d.height, preserveAspectRatio: "none" })];
	}
	if (isSymbol(d)) {
		const content = library.find((item) => item.id === d.libraryId)?.drawings ?? [];
		// Invisible, but makes the whole box grabbable (and outlines a library drawing without content).
		const box = svgEl("rect", {
			class: content.length > 0 ? "drawing-symbol-box" : "drawing-symbol-box empty",
			x: d.x,
			y: d.y,
			width: d.width,
			height: d.height,
		});
		return [box, libraryPicture(content, d)];
	}
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
		return d.text && withText ? [shape, textNode(d)] : [shape];
	}
	const [from, to] = d.points as [Point, Point];
	const arrow = d.kind === "arrow" ? arrowGeometry(from, to) : null;
	const path = arrow ? strokePath([from, arrow.lineEnd], false) : strokePath(d.points, d.kind === "pen");
	const line = svgEl("path", { class: "drawing-stroke", d: path });
	line.style.stroke = stroke;
	// A wide invisible copy, so thin lines are easy to click.
	const shapes: SVGElement[] = [svgEl("path", { class: "drawing-hit", d: strokePath(d.points, d.kind === "pen") }), line];
	if (arrow) {
		const head = svgEl("polygon", { class: "drawing-arrowhead", points: arrow.head });
		head.style.fill = stroke;
		head.style.stroke = stroke;
		shapes.push(head);
	}
	return shapes;
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

/** The area a library drawing's content takes up where it's shown: its bounds with some room around them. */
function pictureArea(drawings: readonly Drawing[]): Rect | null {
	const bounds = contentBounds(drawings);
	if (!bounds) return null;
	const pad = PICTURE_PADDING;
	return { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + 2 * pad, height: bounds.height + 2 * pad };
}

/** The size a library drawing is placed at: the size of its content (or a square while it has none). */
function symbolSize(item: LibraryDrawing): { width: number; height: number } {
	const area = pictureArea(item.drawings);
	return area ? { width: area.width, height: area.height } : { width: EMPTY_SYMBOL_SIZE, height: EMPTY_SYMBOL_SIZE };
}

/**
 * A library drawing's content fitted into `rect`, keeping its aspect ratio (centered): in a placed library drawing on a
 * board, or as a thumbnail in the library lists (where the CSS sizes it).
 */
export function libraryPicture(drawings: readonly Drawing[], rect: Rect): SVGSVGElement {
	const area = pictureArea(drawings) ?? { x: 0, y: 0, width: 1, height: 1 };
	return svgEl(
		"svg",
		{
			class: "library-picture",
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: rect.height,
			viewBox: `${area.x} ${area.y} ${area.width} ${area.height}`,
			preserveAspectRatio: "xMidYMid meet",
			"aria-hidden": "true",
		},
		...drawings.flatMap((d) => drawingShape(d, [])),
	);
}

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
	/** Puts an image file on the board, centered on `center` (world coordinates), and selects it. */
	addImage(file: File, center: Point): Promise<void>;
	/** Places a library drawing on the board, centered on `center` (world coordinates), and selects it. */
	addSymbol(libraryId: string, center: Point): void;
	deselect(): void;
}

/**
 * Shapes, lines, text, pen strokes, images and placed library drawings on a board, or the content of a library
 * drawing: drawing them, and (unless read-only) creating, selecting, moving, resizing, recoloring, editing text and
 * deleting them.
 */
export function createDrawingLayer(options: {
	store: Store;
	owner: () => DrawingOwner;
	/** The story mode page shown (only its drawings are, others faded in the editor); null outside story mode. */
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
	/** Opens a placed library drawing in the library (its style bar button, or a double-click). */
	onEditSymbol?: (libraryId: string) => void;
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

	const drawings = (): Drawing[] => {
		const owner = options.owner();
		return "boardId" in owner
			? (store.data.boards.find((b) => b.id === owner.boardId)?.drawings ?? [])
			: (store.data.library.find((item) => item.id === owner.libraryId)?.drawings ?? []);
	};
	/** Adds a drawing to the owner (on a board in story mode, shown on the page shown). */
	const add = (drawing: NewDrawing): Drawing => {
		const owner = options.owner();
		return "boardId" in owner
			? store.addDrawing(owner.boardId, drawing, options.page()?.id)
			: store.addToLibraryDrawing(owner.libraryId, drawing);
	};
	const find = (id: string): Drawing | undefined => (draft?.id === id ? draft : drawings().find((d) => d.id === id));

	function render(): void {
		if (editingId) return;
		draw();
	}

	/** Whether the drawing is on the page shown (always, outside story mode). */
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

	function drawingNode(d: Drawing): SVGGElement {
		const group = svgEl(
			"g",
			{ class: onPage(d.id) || d.id === "draft" ? "drawing" : "drawing ghost", "data-id": d.id },
			...drawingShape(d, store.data.library, d.id !== editingId),
		);
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
				if (d && isSymbol(d)) options.onEditSymbol?.(d.libraryId);
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

		if (hasRect(selected)) {
			const corner = (c: Corner): Point => ({
				x: c.endsWith("w") ? selected.x : selected.x + selected.width,
				y: c.startsWith("n") ? selected.y : selected.y + selected.height,
			});
			const resize = (c: Corner, dx: number, dy: number): Drawing =>
				isBox(selected) ? resizeBox(selected, c, dx, dy) : resizeImage(selected, c, dx, dy);
			return [
				outline,
				...CORNERS.map((c) =>
					handle(corner(c), c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize", (dx, dy) => resize(c, dx, dy)),
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
			const added = add({
				kind: "text",
				x: start.x,
				y: start.y - DEFAULT_SIZE.text.height / 2,
				...DEFAULT_SIZE.text,
				color,
				text: "",
				textSize: "m",
			});
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
				const added = created && add(created);
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

	async function addImage(file: File, center: Point): Promise<void> {
		if (readOnly) return;
		const image = await readImage(file);
		if (!image) return;
		placed(add({ kind: "image", ...imageRect(center, image.width, image.height), src: image.src }));
	}

	function addSymbol(libraryId: string, center: Point): void {
		const item = store.data.library.find((i) => i.id === libraryId);
		if (readOnly || !item) return;
		const { width, height } = symbolSize(item);
		placed(add({ kind: "symbol", libraryId, ...imageRect(center, width, height) }));
	}

	/** Selects a drawing just put there (with the select tool, to move it right away). */
	function placed(added: Drawing): void {
		if (tool !== "select") setTool("select");
		select(added.id);
		draw();
	}

	/** Deletes the selected drawing — with `pageId`, only takes it off that page. */
	function removeSelected(pageId?: string): void {
		if (!selectedId) return;
		store.removeDrawing(selectedId, pageId);
		selectedId = null;
		draw();
		options.onSelect(null);
	}

	function showOnPage(pageId: string, drawingId: string): void {
		const owner = options.owner();
		if ("boardId" in owner) store.showOnPage(owner.boardId, pageId, drawingId);
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
		// Images and library drawings have no color of their own.
		const colorless = selected !== undefined && (isImage(selected) || isSymbol(selected));
		const current = selected && "color" in selected ? selected.color : color;
		styleBar.hidden = tool === "select" && !selected;
		styleBar.replaceChildren(
			...(colorless ? [] : DRAWING_COLORS).map(({ name, value }) => {
				const swatch = el("button", {
					type: "button",
					className: "swatch toolbar-swatch",
					title: text.colorNames[name] ?? name,
					ariaLabel: text.colorNames[name] ?? name,
					ariaPressed: String(value === current),
					onclick: () => {
						color = value;
						update((d) => ("color" in d ? { ...d, color: value } : d));
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
			...(selected && isSymbol(selected) && options.onEditSymbol
				? [el("button", { type: "button", onclick: () => options.onEditSymbol?.(selected.libraryId) }, text.editInLibrary)]
				: []),
			// In story mode: show another page's drawing here too, or take one off this page only.
			...(selected && page && !onPage(selected.id)
				? [el("button", { type: "button", onclick: () => (showOnPage(page.id, selected.id), draw()) }, text.showOnPage)]
				: []),
			...(selected && page && onPage(selected.id)
				? [el("button", { type: "button", onclick: () => removeSelected(page.id) }, text.removeFromPage)]
				: []),
			// Deleting from the board only outside story mode, which never deletes.
			...(selected && !page
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
			removeSelected(options.page()?.id); // in story mode, like a card's ×: off this page
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
		addImage,
		addSymbol,
		deselect(): void {
			if (!selectedId) return;
			selectedId = null;
			draw();
		},
	};
}

/**
 * An image file as a data URL with its size in pixels, or null when the browser can't read it as an image. Large
 * pictures are scaled down to MAX_STORED_IMAGE_PIXELS first, so the board's data stays small enough to load.
 */
async function readImage(file: File): Promise<{ src: string; width: number; height: number } | null> {
	const url = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		const { naturalWidth: width, naturalHeight: height } = image;
		if (width === 0 || height === 0) return null;
		const scale = Math.min(1, MAX_STORED_IMAGE_PIXELS / Math.max(width, height));
		if (scale === 1) return { src: await dataUrl(file), width, height };
		const canvas = el("canvas", { width: Math.round(width * scale), height: Math.round(height * scale) });
		canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
		// WebP keeps transparency at a fraction of PNG's size; browsers that can't write it fall back to PNG.
		return { src: canvas.toDataURL("image/webp", 0.85), width: canvas.width, height: canvas.height };
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(url);
	}
}

function dataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}
