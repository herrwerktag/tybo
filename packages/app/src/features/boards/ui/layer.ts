import type { Point, Rect } from "../../../shared/core/index.js";
import type { BoardStore } from "../core.js";

/**
 * The things on a board to select or move together, by list: `cards`, and each layer's `key` (the key of the board
 * list it shows, see `BoardList`).
 */
export type BoardItems = Record<string, ReadonlySet<string>>;

/** What the canvas offers a layer (see `CanvasLayer`). */
export interface LayerHost {
	store: BoardStore;
	readOnly: boolean;
	boardId(): string;
	zoom(): number;
	/** World coordinates of a point on the screen. */
	toWorld(clientX: number, clientY: number): Point;
	/** The element that captures the pointer while dragging (it stays in the page, unlike the layer's own). */
	captureTarget(): Element;
	/** Where the cards on the board are now, by card id (moved or sized live, before it's saved). */
	cardRects(): ReadonlyMap<string, Rect>;
	/** The layer's items selected together with others (to move at once): outlined, without handles. */
	group(): ReadonlySet<string>;
	/** One of the layer's items was selected (null: the layer cleared its selection itself). */
	onSelect(id: string | null): void;
	/** A press on an item with Shift, or on one in the group: the canvas adds it to the selection or moves the group. */
	onGroupPress(e: PointerEvent, id: string): void;
	/** Moves `items` along with the pointer from a press on the layer's item `id`, as one change; a click without
	 * moving selects just that item. */
	dragItems(e: PointerEvent, id: string, items: BoardItems): void;
	/** A tool of the layer was picked (`true`) or put down: while one is, pressing the canvas uses it. */
	onToolChange(active: boolean): void;
}

/** A layer on the canvas, made for one canvas (see `CanvasLayer`). */
export interface LayerView {
	/** Drawn into the board below the lines and cards. */
	readonly element: Element;
	/** Its controls over the canvas, e.g. tools (editor only). */
	readonly controls: readonly HTMLElement[];
	/** Draws the current board's items. */
	render(): void;
	/** A press on the canvas (not on a card or the frame), before anything else gets it: true if a tool took it. */
	press(e: PointerEvent): boolean;
	/** Files dropped or pasted onto the board around `center` (world coordinates): true if it took any. */
	drop(files: readonly File[], center: Point): boolean;
	/** Selects one item (with its handles); the layer tells `onSelect`. */
	select(id: string): void;
	/** Clears the layer's selection, without telling `onSelect`. */
	deselect(): void;
	/** The selected item, if any (not those in a group). */
	selected(): string | null;
	/** The items touching `rect` (world coordinates), for a frame dragged around them. */
	touching(rect: Rect): string[];
	/** With the card `cardId` selected the rest of the board fades: the items that don't (or none, with null). */
	focus(cardId: string | null): void;
	/** While a group is dragged: draws these items moved by (dx, dy) world units, not saved; null stops it. */
	previewMove(ids: ReadonlySet<string> | null, dx?: number, dy?: number): void;
}

/**
 * A feature's layer on the canvas, e.g. the drawings: what it shows of its board list (`key`, see `BoardList`), and
 * its tools. The canvas makes one per canvas shown, and wires it into selecting, moving and dropping.
 */
export interface CanvasLayer {
	key: string;
	create(host: LayerHost): LayerView;
}

/** A way to export a board, in the editor's Export menu. */
export interface BoardExport {
	label(): string;
	title(): string;
	run(store: BoardStore, boardId: string): void;
}
