import { clampZoom, filterLibrary, GRID_SIZE, parseTags, screenToWorld, stepZoom, zoomAt, type LibraryDrawing, type Store, type Viewport } from "@bekbon/core";
import { CLICK_TOLERANCE, el, trackPointer } from "./dom.js";
import { createDrawingLayer, libraryPicture } from "./drawing-layer.js";
import { contentBounds } from "./drawings.js";
import { text } from "./i18n.js";
import { readPreference, writePreference } from "./preferences.js";

/** The library drawing open in the library's editor. */
const SELECTED_KEY = "library-selected";
/** The size of the thumbnails in the library's list, in px. */
const THUMBNAIL_SIZE = 48;
/** Room around a library drawing's content when the editor fits it into view, in px. */
const FIT_MARGIN = 48;

/** Opens the library drawing in the library's editor the next time the library is shown. */
export function selectLibraryDrawing(libraryId: string): void {
	writePreference(SELECTED_KEY, libraryId);
}

/**
 * The library: its drawings in a list (searchable by name and tag) and the one chosen in an editor with the board's
 * drawing tools, its name and its tags. Boards place library drawings without copying them, so what's changed here
 * shows wherever they're placed.
 */
export function libraryView(store: Store): HTMLElement {
	let query = "";
	const selected = (): LibraryDrawing | undefined => {
		const id = readPreference(SELECTED_KEY);
		return store.data.library.find((item) => item.id === id) ?? store.data.library[0];
	};

	const view = el("div", { className: "library-view" });
	const list = el("ul", { className: "library-list" });
	const editor = el("div", { className: "library-editor" });

	// The list's thumbnails follow every change (the editor's drawing included); undo and redo redraw the whole page.
	store.onHistoryChange(() => {
		if (view.isConnected) renderList();
	});

	function renderList(): void {
		const current = selected();
		const matches = filterLibrary(store.data.library, query);
		list.replaceChildren(
			...matches.map((item) =>
				el(
					"li",
					{},
					el(
						"button",
						{
							type: "button",
							className: "library-entry",
							ariaCurrent: String(item.id === current?.id),
							onclick: () => {
								selectLibraryDrawing(item.id);
								renderList();
								renderEditor();
							},
						},
						libraryPicture(item.drawings, { x: 0, y: 0, width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }),
						el(
							"span",
							{ className: "library-item-text" },
							el("span", {}, item.name),
							...(item.tags.length > 0 ? [el("span", { className: "panel-item-note muted" }, item.tags.join(", "))] : []),
						),
					),
				),
			),
		);
		if (matches.length === 0 && store.data.library.length > 0) list.append(el("li", { className: "muted" }, text.noLibraryMatches));
	}

	function renderEditor(): void {
		const item = selected();
		if (!item) {
			editor.replaceChildren(el("p", { className: "muted library-empty" }, text.libraryEmpty));
			return;
		}
		const name = el("input", {
			value: item.name,
			ariaLabel: text.name,
			onchange: () => {
				store.updateLibraryDrawing(item.id, { name: name.value });
				name.value = selected()?.name ?? name.value; // an empty name keeps the old one
			},
		});
		const tags = el("input", {
			value: item.tags.join(", "),
			placeholder: text.tagsHint,
			ariaLabel: text.tags,
			onchange: () => {
				store.updateLibraryDrawing(item.id, { tags: parseTags(tags.value) });
				tags.value = selected()?.tags.join(", ") ?? "";
			},
		});
		const { count, boards } = store.libraryUses(item.id);
		const remove = el(
			"button",
			{
				type: "button",
				onclick: () => {
					const uses = store.libraryUses(item.id);
					if (!confirm(text.confirmDeleteLibraryDrawing(item.name, uses.count, uses.boards))) return;
					store.deleteLibraryDrawing(item.id);
					renderList();
					renderEditor();
				},
			},
			text.deleteLibraryDrawing,
		);
		editor.replaceChildren(
			el(
				"div",
				{ className: "library-meta" },
				el("label", { className: "field" }, el("span", {}, text.name), name),
				el("label", { className: "field" }, el("span", {}, text.tags), tags),
				el("p", { className: "muted library-uses" }, `${text.libraryUses(count, boards)}. ${text.libraryLinkedHint}`),
				remove,
			),
			drawingArea(item.id),
		);
	}

	/** The editor's canvas: pan and zoom of its own (not saved), the board's drawing tools, and images pasted or dropped. */
	function drawingArea(libraryId: string): HTMLElement {
		let viewport: Viewport = { x: FIT_MARGIN, y: FIT_MARGIN, zoom: 1 };
		const layer = el("div", { className: "canvas-board" });
		const surface = el("div", { className: "canvas-surface", ariaLabel: text.libraryCanvas }, layer);
		const zoomLabel = el("span", { className: "zoom-label" });
		const area = el("div", { className: "canvas-main library-canvas" });
		const toWorld = (clientX: number, clientY: number) => {
			const rect = surface.getBoundingClientRect();
			return screenToWorld(viewport, clientX - rect.left, clientY - rect.top);
		};

		const drawing = createDrawingLayer({
			store,
			readOnly: false,
			owner: () => ({ libraryId }),
			page: () => null,
			zoom: () => viewport.zoom,
			toWorld,
			captureTarget: () => surface,
			onSelect: () => {},
			onToolChange: (tool) => surface.classList.toggle("drawing-tool", tool !== "select"),
		});
		layer.append(drawing.element);

		function setViewport(next: Viewport): void {
			const zoomChanged = next.zoom !== viewport.zoom;
			viewport = next;
			layer.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
			const grid = GRID_SIZE * viewport.zoom;
			surface.style.backgroundSize = `${grid}px ${grid}px`;
			surface.style.backgroundPosition = `${viewport.x - grid / 2}px ${viewport.y - grid / 2}px`;
			zoomLabel.textContent = `${Math.round(viewport.zoom * 100)}%`;
			if (zoomChanged) drawing.render(); // selection handles keep their screen size
		}

		/** Pans (at 100%, or less if needed) so the whole drawing is in view and centered. */
		function fit(): void {
			const bounds = contentBounds(store.data.library.find((item) => item.id === libraryId)?.drawings ?? []);
			const { width, height } = surface.getBoundingClientRect();
			if (!bounds || width === 0 || height === 0) return setViewport({ x: FIT_MARGIN, y: FIT_MARGIN, zoom: 1 });
			const z = clampZoom(Math.min(1, (width - 2 * FIT_MARGIN) / bounds.width, (height - 2 * FIT_MARGIN) / bounds.height));
			setViewport({ x: width / 2 - (bounds.x + bounds.width / 2) * z, y: height / 2 - (bounds.y + bounds.height / 2) * z, zoom: z });
		}

		// With a drawing tool active, pressing anywhere starts a new drawing (before panning gets it).
		surface.addEventListener("pointerdown", (e) => drawing.startCreate(e), { capture: true });

		// Pan by dragging the empty background; a click there deselects.
		surface.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || (e.target !== surface && e.target !== layer)) return;
			const start = viewport;
			surface.classList.add("panning");
			trackPointer(
				e,
				(dx, dy) => setViewport({ ...start, x: start.x + dx, y: start.y + dy }),
				(dx, dy) => {
					surface.classList.remove("panning");
					if (Math.hypot(dx, dy) < CLICK_TOLERANCE) drawing.deselect();
				},
			);
		});

		// Scroll pans; Ctrl/⌘ + scroll (and trackpad pinch) zooms around the pointer.
		surface.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
				const rect = surface.getBoundingClientRect();
				if (e.ctrlKey || e.metaKey) {
					setViewport(zoomAt(viewport, viewport.zoom * Math.exp(-e.deltaY * scale * 0.01), e.clientX - rect.left, e.clientY - rect.top));
				} else {
					setViewport({ ...viewport, x: viewport.x - e.deltaX * scale, y: viewport.y - e.deltaY * scale });
				}
			},
			{ passive: false },
		);

		const zoomStep = (direction: 1 | -1) => {
			const rect = surface.getBoundingClientRect();
			setViewport(zoomAt(viewport, stepZoom(viewport.zoom, direction), rect.width / 2, rect.height / 2));
		};

		const imageFiles = (files: FileList | undefined): File[] => [...(files ?? [])].filter((f) => f.type.startsWith("image/"));
		surface.addEventListener("dragover", (e) => {
			if (!e.dataTransfer?.types.includes("Files")) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		});
		surface.addEventListener("drop", (e) => {
			const images = imageFiles(e.dataTransfer?.files);
			if (images.length === 0) return;
			e.preventDefault();
			const at = toWorld(e.clientX, e.clientY);
			images.forEach((file, i) => void drawing.addImage(file, { x: at.x + i * GRID_SIZE, y: at.y + i * GRID_SIZE }));
		});
		// Ctrl/⌘ + V with an image on the clipboard puts it in the middle of the view; text fields keep their pasting.
		function onPaste(e: ClipboardEvent): void {
			if (!area.isConnected) return document.removeEventListener("paste", onPaste);
			if ((e.target as Element).closest?.("input, select, textarea, [contenteditable]")) return;
			const images = imageFiles(e.clipboardData?.files);
			if (images.length === 0) return;
			e.preventDefault();
			const rect = surface.getBoundingClientRect();
			const at = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
			images.forEach((file, i) => void drawing.addImage(file, { x: at.x + i * GRID_SIZE, y: at.y + i * GRID_SIZE }));
		}
		document.addEventListener("paste", onPaste);

		const zoomBar = el(
			"div",
			{ className: "toolbar-group canvas-zoom" },
			el("button", { type: "button", ariaLabel: text.zoomOut, title: text.zoomOut, onclick: () => zoomStep(-1) }, "−"),
			zoomLabel,
			el("button", { type: "button", ariaLabel: text.zoomIn, title: text.zoomIn, onclick: () => zoomStep(1) }, "+"),
			el("button", { type: "button", onclick: fit }, text.resetView),
		);
		area.append(surface, drawing.toolbar, drawing.styleBar, zoomBar);
		setViewport(viewport);
		// Once it's in the page and has a size.
		requestAnimationFrame(fit);
		return area;
	}

	const search = el("input", {
		type: "search",
		placeholder: text.searchLibrary,
		ariaLabel: text.searchLibrary,
		oninput: () => {
			query = search.value;
			renderList();
		},
	});
	const add = el(
		"button",
		{
			type: "button",
			className: "primary",
			onclick: () => {
				const item = store.addLibraryDrawing(text.defaultLibraryName(store.data.library.length + 1));
				selectLibraryDrawing(item.id);
				renderList();
				renderEditor();
				editor.querySelector<HTMLInputElement>(".library-meta input")?.select();
			},
		},
		text.newLibraryDrawing,
	);

	renderList();
	renderEditor();
	view.append(
		el(
			"aside",
			{ className: "canvas-panel library-panel" },
			el("div", { className: "panel-header" }, el("h2", {}, text.library), add),
			el("div", { className: "panel-filters" }, search),
			list,
		),
		editor,
	);
	return view;
}
