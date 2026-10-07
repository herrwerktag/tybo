import { freshDom } from "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasView } from "./canvas.js";
import { CLICK_TOLERANCE } from "./dom.js";
import { createStore, DATA_VERSION, snapToGrid, type Store } from "@bekbon/core";
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

test("dragging a card's header moves it onto the grid and saves the position; it doesn't open the details", async () => {
	const { store, view, card } = await setup();
	dragBy(cardNode(view, card.id).querySelector("header")!, 50, 30);

	// 150, 130 snaps to the nearest grid point.
	assert.deepEqual([savedCard(store, card.id)?.x, savedCard(store, card.id)?.y], [144, 120]);
	assert.equal(cardNode(view, card.id).style.left, "144px");
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

test("resizing saves the new size on the grid, but never below the minimum", async () => {
	const { store, view, card } = await setup();
	dragBy(cardNode(view, card.id).querySelector(".card-resize")!, 60, 40);
	assert.deepEqual([savedCard(store, card.id)?.width, savedCard(store, card.id)?.height], [312, 216]);

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

/** A board in story mode with Dune on page 1 and Herbert added on page 2 (copied from page 1), shown on page 1. */
async function storyboard({ readOnly = false } = {}) {
	freshDom();
	const store = await createStore(memoryDataPort({ ws: { version: DATA_VERSION, types: [], entities: [], boards: [] } }).port, "ws");
	const book = store.addType("Book", [], "");
	const dune = store.addEntity(book.id, "Dune", "", {});
	const herbert = store.addEntity(book.id, "Herbert", "", {});
	store.setStoryMode(store.addBoard("Flow").id, true, "Start");
	const story = store.data.boards[1]!;
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

test("in story mode a board shows one page at a time; the page bar and arrow keys step through it", async () => {
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

test("in the story mode editor, × hides a card on this page, + shows it again, and pages are added and named", async () => {
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

const storyButton = (view: HTMLElement) =>
	[...view.querySelectorAll<HTMLButtonElement>(".board-controls button")].find((b) => b.textContent === "Story mode")!;

test("the viewer starts with the whole board; in story mode it shows only prev/next, the step name and the description", async () => {
	const { store, view, story } = await storyboard({ readOnly: true });
	assert.deepEqual(shownCards(view), ["Dune", "Herbert"]);
	assert.equal(view.querySelector<HTMLElement>(".page-bar")!.hidden, true);
	assert.equal(view.querySelector<HTMLElement>(".page-description")!.hidden, true);

	storyButton(view).click();
	assert.equal(storyButton(view).ariaPressed, "true");
	assert.deepEqual(shownCards(view), ["Dune"]);
	assert.equal(view.querySelector(".canvas-card.ghost"), null);
	assert.equal(view.querySelector(".page-bar input"), null);
	assert.equal(view.querySelectorAll(".page-bar button").length, 2);
	assert.equal(view.querySelector(".page-bar .page-name")?.textContent, "Start");
	assert.equal(view.querySelector(".page-description strong")?.textContent, "Dune");

	pageButton(view, "Next step").click();
	assert.equal(view.querySelector(".page-bar .page-name")?.textContent, "Then");
	assert.equal(view.querySelector<HTMLElement>(".page-description")!.hidden, true); // no description on this page

	// Back to the whole board; nothing about it is saved.
	storyButton(view).click();
	assert.deepEqual(shownCards(view), ["Dune", "Herbert"]);
	assert.equal(store.data.boards.find((b) => b.id === story.id)!.story, true);
});

test("the step description has the size saved with its page, set on the grid at its corner in the editor", async () => {
	const { store, view, story } = await storyboard();
	const box = view.querySelector<HTMLElement>(".canvas-board .page-description")!;
	assert.deepEqual([box.style.width, box.style.height], ["384px", "120px"]);

	dragBy(box.querySelector<HTMLElement>(".card-resize")!, 40, -1000);
	const size = store.data.boards.find((b) => b.id === story.id)!.pages[0]!.descriptionSize;
	assert.deepEqual(size, { width: 432, height: 48 }); // 424 snaps to 432; never below the minimum
	assert.deepEqual([box.style.width, box.style.height], ["432px", "48px"]);
});

test("a step description sits on the canvas like a card: dragging its handle moves it on the grid in world coordinates", async () => {
	const { store, view, story, one } = await storyboard();
	const box = view.querySelector<HTMLElement>(".canvas-board .page-description")!;
	assert.ok(box, "inside the panned and zoomed layer");
	const before = one.descriptionPosition;

	dragBy(box.querySelector<HTMLElement>(".page-description-handle")!, 50, 30);
	const after = store.data.boards.find((b) => b.id === story.id)!.pages[0]!.descriptionPosition;
	assert.deepEqual(after, { x: snapToGrid(before.x + 50), y: snapToGrid(before.y + 30) });
	assert.deepEqual([box.style.left, box.style.top], [`${after.x}px`, `${after.y}px`]);

	// Grabbed again, it moves on from where it is now.
	dragBy(box.querySelector<HTMLElement>(".page-description-handle")!, 10, -20);
	const again = store.data.boards.find((b) => b.id === story.id)!.pages[0]!.descriptionPosition;
	assert.deepEqual(again, { x: after.x, y: after.y - 24 }); // 10 right stays in place, 20 up snaps a whole cell
});

test("the Story mode button switches a board into story mode, starting with an empty step, and back", async () => {
	const { store, view, card } = await setup();
	const toggle = [...view.querySelectorAll<HTMLButtonElement>(".board-controls button")].find((b) => b.textContent === "Story mode")!;
	assert.equal(toggle.ariaPressed, "false");
	assert.equal(view.querySelector<HTMLElement>(".page-bar")!.hidden, true);

	toggle.click();
	assert.equal(store.data.boards[0]!.story, true);
	assert.equal(view.querySelector<HTMLElement>(".page-bar")!.hidden, false);
	assert.equal(view.querySelectorAll(".canvas-board .canvas-card:not(.ghost)").length, 0); // the first step shows nothing yet
	assert.deepEqual(store.data.boards[0]!.pages[0]!.cardIds, []);
	assert.ok(store.data.boards[0]!.cards.some((c) => c.id === card.id)); // still on the board, faded
	assert.ok(view.querySelector<HTMLElement>(".canvas-board .page-description")!.hidden === false);

	[...view.querySelectorAll<HTMLButtonElement>(".board-controls button")].find((b) => b.textContent === "Story mode")!.click();
	assert.equal(store.data.boards[0]!.story, false);
	assert.equal(view.querySelector<HTMLElement>(".page-bar")!.hidden, true);
	assert.equal(store.data.boards[0]!.pages.length, 1, "the steps are kept");
});

test("× in story mode never deletes a card from the board, and Description here brings the description into view", async () => {
	const { store, view, story, one, duneCard } = await storyboard();
	const board = () => store.data.boards.find((b) => b.id === story.id)!;
	// Off page 1 by ×, and off page 2 as well: on no page at all.
	cardNode(view, duneCard.id).querySelector<HTMLButtonElement>(".card-remove")!.click();
	store.removeCard(duneCard.id, board().pages[1]!.id);
	assert.ok(board().cards.some((c) => c.id === duneCard.id), "still on the board");
	assert.ok(cardNode(view, duneCard.id).classList.contains("ghost"));

	store.updatePage(story.id, one.id, { descriptionPosition: { x: 5000, y: 5000 } });
	[...view.querySelectorAll<HTMLButtonElement>(".page-bar button")].find((b) => b.textContent === "Description here")!.click();
	assert.deepEqual(board().pages[0]!.descriptionPosition, { x: 72, y: 24 }); // the view is at the origin here; 16 snaps to 24
	assert.equal(view.querySelector<HTMLElement>(".page-description")!.style.left, "72px");
});

test("◐ dims a card on this step only; the viewer shows it dimmed while stepping through", async () => {
	const { store, view, story, duneCard } = await storyboard();
	const dim = () => cardNode(view, duneCard.id).querySelector<HTMLButtonElement>(".card-dim")!;
	assert.equal(dim().ariaPressed, "false");
	dim().click();
	const pages = () => store.data.boards.find((b) => b.id === story.id)!.pages;
	assert.deepEqual(pages()[0]!.dimmedCardIds, [duneCard.id]);
	assert.deepEqual(pages()[1]!.dimmedCardIds, []); // only this step
	assert.ok(cardNode(view, duneCard.id).classList.contains("dimmed"));
	assert.equal(dim().ariaPressed, "true");
	// × is still the card's own remove button.
	assert.equal(cardNode(view, duneCard.id).querySelector(".card-remove")?.textContent, "×");

	const viewer = canvasView(store, { readOnly: true });
	document.body.replaceChildren(viewer);
	assert.equal(viewer.querySelector(".card-dim"), null);
	assert.equal(cardNode(viewer, duneCard.id).classList.contains("dimmed"), false); // the whole board, nothing dimmed
	storyButton(viewer).click();
	assert.ok(cardNode(viewer, duneCard.id).classList.contains("dimmed"));
});
