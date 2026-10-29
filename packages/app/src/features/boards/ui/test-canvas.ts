/** The canvas on a store in memory, for its tests and those of the features with layers on it. */
import { freshDom } from "../../../shared/ui/test-dom.js";
import { createStore, DATA_VERSION, type Store } from "../../../legacy/core/index.js";
import { memoryDataPort } from "../../../legacy/core/memory-port.js";
import { canvasView } from "./canvas.js";
import type { CanvasLayer } from "./layer.js";

/** A board with one card for Dune (with content) and one for Herbert, on a canvas with `layers` (see `CanvasLayer`). */
export async function setup({ readOnly = false, layers = [] as readonly CanvasLayer[] } = {}) {
	freshDom();
	const store = await createStore(memoryDataPort({ ws: { version: DATA_VERSION, types: [], entities: [], boards: [] } }).port, "ws");
	const book = store.addType("Book", [], "");
	const dune = store.addEntity(book.id, "Dune", "A desert planet.", {}, "A **desert** planet.");
	const herbert = store.addEntity(book.id, "Herbert", "", {});
	const boardId = store.data.boards[0]!.id;
	const card = store.addCard(boardId, dune.id, 100, 100);
	store.addCard(boardId, herbert.id, 400, 100);
	const view = canvasView(store, { readOnly, layers });
	document.body.append(view);
	return { store, view, boardId, card, dune };
}

export const cardNode = (view: HTMLElement, cardId: string) => view.querySelector<HTMLElement>(`.canvas-card[data-card-id="${cardId}"]`)!;
export const savedCard = (store: Store, cardId: string) => store.data.boards[0]!.cards.find((c) => c.id === cardId);
export const details = (view: HTMLElement) => view.querySelector<HTMLElement>(".details-panel")!;

/** Presses the left button on `target`, moves by (dx, dy) and releases, then sends the click a browser would. */
export function dragBy(target: HTMLElement, dx: number, dy: number): void {
	const at = (type: string, x: number, y: number) =>
		target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y }));
	at("pointerdown", 0, 0);
	at("pointermove", dx, dy);
	at("pointerup", dx, dy);
	target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Presses `button` on `target` at (x, y) (with Shift or not), moves to (x + dx, y + dy) and releases there. */
export function press(target: Element, x: number, y: number, dx: number, dy: number, { button = 0, shiftKey = false } = {}): void {
	const at = (type: string, px: number, py: number) =>
		target.dispatchEvent(
			new PointerEvent(type, { bubbles: true, cancelable: true, button, shiftKey, pointerId: 1, pointerType: "mouse", clientX: px, clientY: py }),
		);
	at("pointerdown", x, y);
	at("pointermove", x + dx, y + dy);
	at("pointerup", x + dx, y + dy);
}
export const shiftClick = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
export const selectedCards = (view: HTMLElement) =>
	[...view.querySelectorAll<HTMLElement>(".canvas-card.selected[data-card-id]")].map((n) => n.dataset.cardId);
