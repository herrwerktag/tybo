import type { Point } from "../core/index.js";
import { CLICK_TOLERANCE, el, svgEl, trackPointer } from "../../shared/ui/index.js";
import {
	MIN_BOX_SIZE,
	drawingBounds,
	imageRect,
	moveDrawing,
	normalizeRect,
	resizeBox,
	resizeImage,
	type Corner,
	type Tool,
} from "./drawings.js";
import { text } from "./i18n.js";
import { readPreference, writePreference } from "../../shared/ui/index.js";
import {
	DRAWING_COLORS,
	TEXT_SIZES,
	isArea,
	isBox,
	isImage,
	type BoxDrawing,
	type Drawing,
	type NewDrawing,
	type Rect,
} from "../core/index.js";
import type { Store } from "../core/index.js";

const TOOLS: readonly { tool: Tool; icon: string; key: string }[] = [
	{ tool: "select", icon: "↖", key: "v" },
	{ tool: "textbox", icon: "T", key: "t" },
	{ tool: "area", icon: "⬚", key: "g" },
];

/** Size of a text box or group created with a click instead of a drag. */
const DEFAULT_SIZE = {
	textbox: { width: 160, height: 100 },
	area: { width: 480, height: 312 },
};
const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];
/** Two presses on the same drawing within this time (ms) and distance (px) are a double-click. */
const DOUBLE_CLICK_TIME = 400;
const DOUBLE_CLICK_DISTANCE = 6;
/** Pictures larger than this (in pixels, on the longer side) are scaled down before they're stored. */
const MAX_STORED_IMAGE_PIXELS = 1600;
/** Boxes are filled with a light tint of their color; outlines and text use a darker shade. */
export const fillFor = (color: string) => `color-mix(in srgb, ${color} 40%, white)`;
export const strokeFor = (color: string) => `color-mix(in srgb, ${color} 55%, black)`;

/** The SVG elements showing a drawing, without any handlers. Text is left out with `withText: false` (while it's
 * being edited). */
function drawingShape(d: Drawing, withText = true): SVGElement[] {
	if (isImage(d)) {
		return [svgEl("image", { class: "drawing-image", href: d.src, x: d.x, y: d.y, width: d.width, height: d.height, preserveAspectRatio: "none" })];
	}
	const area = isArea(d);
	const shape = svgEl("rect", { x: d.x, y: d.y, width: d.width, height: d.height, rx: area ? 0 : 6 });
	shape.classList.add(area ? "drawing-area" : "drawing-shape");
	shape.style.fill = fillFor(d.color);
	shape.style.stroke = strokeFor(d.color);
	return d.text && withText ? [shape, textNode(d)] : [shape];
}

/** Text in a text box is centered; an area's name starts at the top left (as its title). */
function textPlacement(box: BoxDrawing): string {
	return box.kind === "area" ? "area-name" : "centered";
}

function textNode(box: BoxDrawing): SVGForeignObjectElement {
	const label = el(
		"div",
		{ className: `drawing-label size-${box.textSize} ${textPlacement(box)}` },
		box.text,
	);
	label.style.color = strokeFor(box.color);
	return svgEl("foreignObject", { x: box.x, y: box.y, width: box.width, height: box.height }, label);
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
	/** Selects one drawing (with its handles and style bar), or none. */
	select(id: string | null): void;
	deselect(): void;
	/** The selected drawing, if any (not those in a group, see `group`). */
	selected(): string | null;
	/** While a group is dragged: draws its drawings moved by (dx, dy) world units, not saved; null stops it. */
	previewMove(ids: ReadonlySet<string> | null, dx?: number, dy?: number): void;
}

/** Whether the drawing tools are folded (see toolsCollapsed). */
const TOOLS_COLLAPSED_KEY = "drawing-tools-collapsed";

/**
 * Text boxes, groups and images on a board: drawing them, and (unless read-only) creating, selecting, moving, resizing, recoloring, editing text and
 * deleting them.
 */
export function createDrawingLayer(options: {
	store: Store;
	boardId: () => string;
	zoom: () => number;
	/** World coordinates of a point on the screen. */
	toWorld: (clientX: number, clientY: number) => Point;
	/** Element that captures the pointer while dragging (it must stay in the page, unlike the redrawn SVG). */
	captureTarget: () => Element;
	readOnly: boolean;
	/** A drawing was selected (or the selection cleared by the layer itself). */
	onSelect: (drawingId: string | null) => void;
	/** Drawings selected together with others (several items to move at once): outlined, without handles. */
	group?: () => ReadonlySet<string>;
	/** With a card selected, the rest of the board fades: the drawings that don't (the areas the card lies in). */
	inFocus?: () => ReadonlySet<string>;
	/** A press on a drawing with Shift, or on one in the group: handled by the owner (adding it to the selection
	 * or moving the group) instead of selecting and moving the drawing alone. */
	onGroupPress?: (e: PointerEvent, drawingId: string) => void;
	/** A press on an area (a named group) alone: handled by the owner, moving it together with what lies in it. */
	onAreaPress?: (e: PointerEvent, drawingId: string) => void;
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
	/** Whether the tool column is folded to the current tool, out of the way of the board; remembered. */
	let toolsCollapsed = readPreference(TOOLS_COLLAPSED_KEY) === "true";
	let editingId: string | null = null;
	/** While dragging: the drawing as it looks right now, not saved yet (a new one has the id "draft"). */
	let draft: Drawing | null = null;
	/** While a group is dragged: its drawings and how far they've moved so far (see previewMove). */
	let groupMove: { ids: ReadonlySet<string>; dx: number; dy: number } | null = null;

	const drawings = (): Drawing[] => store.data.boards.find((b) => b.id === options.boardId())?.drawings ?? [];
	const add = (drawing: NewDrawing): Drawing => store.addDrawing(options.boardId(), drawing);
	const find = (id: string): Drawing | undefined => (draft?.id === id ? draft : drawings().find((d) => d.id === id));

	function render(): void {
		if (editingId) return;
		draw();
	}

	function draw(): void {
		// Areas lie below the other drawings, so they never cover what's in them.
		const all = drawings();
		const shown = [...all.filter(isArea), ...all.filter((d) => !isArea(d))]
			.map((d) => (draft?.id === d.id ? draft : groupMove?.ids.has(d.id) ? moveDrawing(d, groupMove.dx, groupMove.dy) : d));
		if (draft && !shown.some((d) => d.id === draft!.id)) shown.push(draft);
		svg.replaceChildren(
			...shown.map(drawingNode),
			...(readOnly ? [] : shown.filter((d) => options.group?.().has(d.id)).map(outlineOf)),
			...selectionOverlay(),
			...(editingId ? [editor(editingId)] : []),
		);
		renderToolbars();
	}

	function drawingNode(d: Drawing): SVGGElement {
		const group = svgEl(
			"g",
			{ class: "drawing", "data-id": d.id },
			...drawingShape(d, d.id !== editingId),
		);
		if (options.inFocus?.().has(d.id)) group.classList.add("in-chain");
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
			if (options.onGroupPress && (e.shiftKey || options.group?.().has(id))) return options.onGroupPress(e, id);

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

			const original = find(id);
			if (original && isArea(original) && options.onAreaPress) return options.onAreaPress(e, id);
			select(id);
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

	/** A dashed outline around a drawing, keeping its screen size at any zoom. */
	function outlineOf(d: Drawing): SVGElement {
		const zoom = options.zoom();
		const pad = 4 / zoom;
		const b = drawingBounds(d);
		const node = svgEl("rect", {
			class: "selection-outline",
			x: b.x - pad,
			y: b.y - pad,
			width: b.width + 2 * pad,
			height: b.height + 2 * pad,
		});
		node.style.strokeWidth = String(1.5 / zoom);
		node.style.strokeDasharray = `${4 / zoom} ${3 / zoom}`;
		return node;
	}

	/** Outline around the selected drawing, with handles to resize it. */
	function selectionOverlay(): SVGElement[] {
		const found = selectedId ? find(selectedId) : undefined;
		if (readOnly || !found) return [];
		// A selected area moves with what lies in it (see previewMove), its handles along with it.
		const selected = groupMove?.ids.has(found.id) ? moveDrawing(found, groupMove.dx, groupMove.dy) : found;
		const zoom = options.zoom();
		const size = 9 / zoom;
		const outline = outlineOf(selected);

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

	/** A textarea over the box; leaving it saves the text. */
	function editor(id: string): SVGForeignObjectElement {
		const box = find(id) as BoxDrawing;
		const input = el("textarea", {
			className: `drawing-editor size-${box.textSize} ${textPlacement(box)}`,
			value: box.text,
			ariaLabel: text.tools.textbox,
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
			if (latest && isBox(latest)) store.replaceDrawing({ ...latest, text: input.value });
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
		const zoom = options.zoom();
		const at = (dx: number, dy: number): Point => ({ x: start.x + dx / zoom, y: start.y + dy / zoom });
		const box = (rect: Rect): NewDrawing => ({ kind, ...rect, color, text: "", textSize: "m" });
		trackPointer(
			e,
			(dx, dy) => {
				draft = { ...box(normalizeRect(start, at(dx, dy))), id: "draft" } as Drawing;
				draw();
			},
			(dx, dy) => {
				draft = null;
				const dragged = Math.hypot(dx, dy) >= CLICK_TOLERANCE;
				const rect = dragged ? normalizeRect(start, at(dx, dy)) : { ...start, ...DEFAULT_SIZE[kind] };
				const added = add(box({ ...rect, width: Math.max(MIN_BOX_SIZE, rect.width), height: Math.max(MIN_BOX_SIZE, rect.height) }));
				setTool("select");
				if (kind === "area") {
					startEditing(added.id); // name it right away
				} else {
					select(added.id);
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

	/** Selects a drawing just put there (with the select tool, to move it right away). */
	function placed(added: Drawing): void {
		if (tool !== "select") setTool("select");
		select(added.id);
		draw();
	}

	/** Deletes the selected drawing. */
	function removeSelected(): void {
		if (!selectedId) return;
		store.removeDrawing(selectedId);
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
		toolbar.classList.toggle("collapsed", toolsCollapsed);
		toolbar.replaceChildren(
			el(
				"button",
				{
					type: "button",
					className: "tool-button tools-toggle",
					title: toolsCollapsed ? text.showDrawingTools : text.hideDrawingTools,
					ariaLabel: toolsCollapsed ? text.showDrawingTools : text.hideDrawingTools,
					ariaExpanded: String(!toolsCollapsed),
					onclick: () => {
						toolsCollapsed = !toolsCollapsed;
						writePreference(TOOLS_COLLAPSED_KEY, String(toolsCollapsed));
						renderToolbars();
					},
				},
				toolsCollapsed ? "▾" : "▴",
			),
			// Folded, CSS shows only the current tool (the shortcut keys still switch tools).
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
		// Images have no color of their own.
		const colorless = selected !== undefined && isImage(selected);
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
			removeSelected();
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
		select,
		deselect(): void {
			if (!selectedId) return;
			selectedId = null;
			draw();
		},
		selected: () => selectedId,
		previewMove(ids, dx = 0, dy = 0): void {
			groupMove = ids && { ids, dx, dy };
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
