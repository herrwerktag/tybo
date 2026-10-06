import { freshDom } from "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasView } from "./canvas.js";
import { CLICK_TOLERANCE } from "./dom.js";
import { createStore, DATA_VERSION, type Store } from "@bekbon/core";
import { memoryDataPort } from "@bekbon/core/testing";

/** A board with one card for Dune (with content, so it can be resized) and one for Herbert. */
async function setup({ readOnly = false } = {}) {
	freshDom();
	const store = await createStore(memoryDataPort({ ws: { version: DATA_VERSION, types: [], entities: [], boards: [] } }).port, "ws");
	const book = store.addType("Book", [], "");
	const dune = store.addEntity(book.id, "Dune", "A desert planet.", {});
	const herbert = store.addEntity(book.id, "Herbert", "", {});
	const boardId = store.data.boards[0]!.id;
	const card = store.addCard(boardId, dune.id, 100, 100);
	store.addCard(boardId, herbert.id, 400, 100);
	const view = canvasView(store, { readOnly });
	document.body.append(view);
	return { store, view, card, dune };
}

const cardNode = (view: HTMLElement, cardId: string) => view.querySelector<HTMLElement>(`.canvas-card[data-card-id="${cardId}"]`)!;
const savedCard = (store: Store, cardId: string) => store.data.boards[0]!.cards.find((c) => c.id === cardId);
const details = (view: HTMLElement) => view.querySelector<HTMLElement>(".details-panel")!;

/** Presses the left button on `target`, moves by (dx, dy) and releases, then sends the click a browser would. */
function dragBy(target: HTMLElement, dx: number, dy: number): void {
	const at = (type: string, x: number, y: number) =>
		target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y }));
	at("pointerdown", 0, 0);
	at("pointermove", dx, dy);
	at("pointerup", dx, dy);
	target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

test("dragging a card's header moves it and saves the position; it doesn't open the details", async () => {
	const { store, view, card } = await setup();
	dragBy(cardNode(view, card.id).querySelector("header")!, 50, 30);

	assert.deepEqual([savedCard(store, card.id)?.x, savedCard(store, card.id)?.y], [150, 130]);
	assert.equal(cardNode(view, card.id).style.left, "150px");
	assert.equal(details(view).hidden, true);
});

test("a click with a little jitter selects the card and shows its details without moving it", async () => {
	const { store, view, card } = await setup();
	dragBy(cardNode(view, card.id).querySelector("header")!, CLICK_TOLERANCE - 1, 1);

	assert.deepEqual([savedCard(store, card.id)?.x, savedCard(store, card.id)?.y], [100, 100]);
	assert.equal(details(view).hidden, false);
	assert.equal(details(view).querySelector(".details-title")?.textContent, "Dune");
	assert.ok(cardNode(view, card.id).classList.contains("selected"));

	// Escape closes the details again.
	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal(details(view).hidden, true);
});

test("resizing saves the new size, but never below the minimum", async () => {
	const { store, view, card } = await setup();
	dragBy(cardNode(view, card.id).querySelector(".card-resize")!, 60, 40);
	assert.deepEqual([savedCard(store, card.id)?.width, savedCard(store, card.id)?.height], [300, 200]);

	dragBy(cardNode(view, card.id).querySelector(".card-resize")!, -1000, -1000);
	assert.deepEqual([savedCard(store, card.id)?.width, savedCard(store, card.id)?.height], [160, 80]);
});

test("× takes the card off the board; the entity stays", async () => {
	const { store, view, card, dune } = await setup();
	cardNode(view, card.id).querySelector<HTMLButtonElement>(".card-remove")!.click();

	assert.equal(savedCard(store, card.id), undefined);
	assert.equal(view.querySelectorAll(".canvas-board .canvas-card").length, 1);
	assert.ok(store.data.entities.some((e) => e.id === dune.id));
});

test("the viewer only looks: no remove buttons, and dragging doesn't move cards", async () => {
	const { store, view, card } = await setup({ readOnly: true });
	assert.equal(view.querySelector(".canvas-board .card-remove"), null);
	assert.equal(view.querySelector(".canvas-panel"), null);

	dragBy(cardNode(view, card.id).querySelector("header")!, 50, 30);
	assert.deepEqual([savedCard(store, card.id)?.x, savedCard(store, card.id)?.y], [100, 100]);
});
