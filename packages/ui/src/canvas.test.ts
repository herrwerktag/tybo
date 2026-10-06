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
	const dune = store.addEntity(book.id, "Dune", "A desert planet.", {}, "A **desert** planet.");
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

	// The description is shown as Markdown.
	assert.equal(details(view).querySelector(".markdown strong")?.textContent, "desert");

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

/** A storyboard with Dune on page 1 and Herbert added on page 2 (copied from page 1), shown on page 1. */
async function storyboard({ readOnly = false } = {}) {
	freshDom();
	const store = await createStore(memoryDataPort({ ws: { version: DATA_VERSION, types: [], entities: [], boards: [] } }).port, "ws");
	const book = store.addType("Book", [], "");
	const dune = store.addEntity(book.id, "Dune", "", {});
	const herbert = store.addEntity(book.id, "Herbert", "", {});
	const story = store.addBoard("Flow", "storyboard", "Start");
	const one = story.pages[0]!;
	store.updatePage(story.id, one.id, { description: "Only **Dune**" });
	const duneCard = store.addCard(story.id, dune.id, 0, 0, one.id);
	const two = store.addPage(story.id, one.id, "Then", true)!;
	const herbertCard = store.addCard(story.id, herbert.id, 300, 0, two.id);
	localStorage.setItem("canvas-active-board", story.id);
	const view = canvasView(store, { readOnly });
	document.body.append(view);
	return { store, view, story, one, two, duneCard, herbertCard };
}

const shownCards = (view: HTMLElement) =>
	[...view.querySelectorAll<HTMLElement>(".canvas-board .canvas-card:not(.ghost)")].map((c) => c.querySelector(".card-title")?.textContent);
const pageButton = (view: HTMLElement, label: string) => view.querySelector<HTMLButtonElement>(`.page-bar button[title="${label}"]`)!;

test("a storyboard shows one page at a time; the page bar and arrow keys step through it", async () => {
	const { view } = await storyboard();
	assert.deepEqual(shownCards(view), ["Dune"]);
	// Herbert is on another page: faded, with + to show him here too.
	assert.equal(view.querySelector(".canvas-card.ghost .card-title")?.textContent, "Herbert");
	assert.equal(pageButton(view, "Previous step").disabled, true);
	assert.equal(view.querySelector<HTMLInputElement>(".page-bar input.page-name")?.value, "Start");

	pageButton(view, "Next step").click();
	assert.deepEqual(shownCards(view), ["Dune", "Herbert"]);
	assert.ok(view.querySelector(".canvas-card.appear")); // Herbert fades in
	assert.equal(view.querySelector(".page-counter")?.textContent, "2 / 2");

	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
	assert.deepEqual(shownCards(view), ["Dune"]);
});

test("in the storyboard editor, × hides a card on this page, + shows it again, and pages are added and named", async () => {
	const { store, view, story, two, herbertCard } = await storyboard();
	const board = () => store.data.boards.find((b) => b.id === story.id)!;

	cardNode(view, herbertCard.id).querySelector<HTMLButtonElement>(".card-remove")!.click(); // + on the ghost
	assert.deepEqual(shownCards(view), ["Dune", "Herbert"]);
	cardNode(view, herbertCard.id).querySelector<HTMLButtonElement>(".card-remove")!.click(); // × again
	assert.deepEqual(shownCards(view), ["Dune"]);
	assert.ok(board().pages[1]!.cardIds.includes(herbertCard.id), "still on page 2");

	const name = view.querySelector<HTMLInputElement>(".page-bar input.page-name")!;
	name.value = "Begin";
	name.dispatchEvent(new Event("change"));
	const description = view.querySelector<HTMLTextAreaElement>(".page-description textarea")!;
	description.value = "New text";
	description.dispatchEvent(new Event("change"));
	assert.deepEqual([board().pages[0]!.name, board().pages[0]!.description], ["Begin", "New text"]);

	// Without "Copy", the new page starts empty; it's added after the current one and shown.
	view.querySelector<HTMLInputElement>(".page-copy input")!.checked = false;
	[...view.querySelectorAll<HTMLButtonElement>(".page-bar button")].find((b) => b.textContent === "+ Page")!.click();
	assert.deepEqual(board().pages.map((p) => p.name), ["Begin", "Step 3", two.name]);
	assert.deepEqual(shownCards(view), []);
	assert.equal(view.querySelector(".page-counter")?.textContent, "2 / 3");
});

test("the storyboard viewer shows only prev/next, the step name and the description as Markdown", async () => {
	const { view } = await storyboard({ readOnly: true });
	assert.deepEqual(shownCards(view), ["Dune"]);
	assert.equal(view.querySelector(".canvas-card.ghost"), null);
	assert.equal(view.querySelector(".page-bar input"), null);
	assert.equal(view.querySelectorAll(".page-bar button").length, 2);
	assert.equal(view.querySelector(".page-bar .page-name")?.textContent, "Start");
	assert.equal(view.querySelector(".page-description strong")?.textContent, "Dune");

	pageButton(view, "Next step").click();
	assert.equal(view.querySelector(".page-bar .page-name")?.textContent, "Then");
	assert.equal(view.querySelector<HTMLElement>(".page-description")!.hidden, true); // no description on this page
});

test("a step description sits on the canvas like a card: dragging its handle moves it in world coordinates", async () => {
	const { store, view, story, one } = await storyboard();
	const box = view.querySelector<HTMLElement>(".canvas-board .page-description")!;
	assert.ok(box, "inside the panned and zoomed layer");
	const before = one.descriptionPosition;

	dragBy(box.querySelector<HTMLElement>(".page-description-handle")!, 50, 30);
	const after = store.data.boards.find((b) => b.id === story.id)!.pages[0]!.descriptionPosition;
	assert.deepEqual(after, { x: before.x + 50, y: before.y + 30 });
	assert.deepEqual([box.style.left, box.style.top], [`${after.x}px`, `${after.y}px`]);

	// Grabbed again, it moves on from where it is now.
	dragBy(box.querySelector<HTMLElement>(".page-description-handle")!, 10, -20);
	const again = store.data.boards.find((b) => b.id === story.id)!.pages[0]!.descriptionPosition;
	assert.deepEqual(again, { x: after.x + 10, y: after.y - 20 });
});
