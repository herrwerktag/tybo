import { freshDom } from "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasView, parseViewHash, viewHash } from "./canvas.js";
import { CLICK_TOLERANCE } from "./dom.js";
import { text } from "./i18n.js";
import { createStore, DATA_VERSION, fitRect, frameInside, snapToGrid, visibleRect, type Store } from "@tybo/core";
import { memoryDataPort } from "@tybo/core/testing";

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

test("Edit in the details shows the entity's form there: saving updates the entity and its card, Cancel changes nothing", async () => {
	const { store, view, card, dune } = await setup();
	const editButton = () => [...details(view).querySelectorAll("button")].find((b) => b.textContent === text.edit)!;
	const form = () => details(view).querySelector<HTMLFormElement>("#entity-form")!;
	const nameInput = () => form().querySelector<HTMLInputElement>("input")!;
	dragBy(cardNode(view, card.id).querySelector("header")!, 0, 0);

	// The form is below the bar of the entity's type.
	editButton().click();
	assert.equal(details(view).querySelector(".card-type")?.textContent, "Book");

	// Cancel shows the details again, unchanged.
	nameInput().value = "Arrakis";
	[...form().querySelectorAll("button")].find((b) => b.textContent === text.cancel)!.click();
	assert.equal(details(view).querySelector(".details-title")?.textContent, "Dune");
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.name, "Dune");

	// Redrawing the board (here: moving the card) keeps what was typed.
	editButton().click();
	nameInput().value = "Dune Messiah";
	dragBy(cardNode(view, card.id).querySelector("header")!, 50, 30);
	assert.equal(nameInput().value, "Dune Messiah");

	form().requestSubmit();
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.name, "Dune Messiah");
	assert.equal(details(view).querySelector(".details-title")?.textContent, "Dune Messiah");
	assert.equal(cardNode(view, card.id).querySelector(".card-title")?.textContent, "Dune Messiah");
});

test("the viewer's details have no Edit", async () => {
	const { view, card } = await setup({ readOnly: true });
	dragBy(cardNode(view, card.id).querySelector("header")!, 0, 0);
	assert.equal(details(view).hidden, false);
	assert.ok(![...details(view).querySelectorAll("button")].some((b) => b.textContent === text.edit));
});

test("resizing saves the new size on the grid, but never below the minimum", async () => {
	const { store, view, card } = await setup();
	dragBy(cardNode(view, card.id).querySelector(".card-resize")!, 60, 40);
	assert.deepEqual([savedCard(store, card.id)?.width, savedCard(store, card.id)?.height], [312, 216]);

	dragBy(cardNode(view, card.id).querySelector(".card-resize")!, -1000, -1000);
	assert.deepEqual([savedCard(store, card.id)?.width, savedCard(store, card.id)?.height], [160, 80]);
});

test("a card without content can only be made wider or narrower; it is as tall as what it shows, rounded up to the grid", async () => {
	const { store, view, card } = await setup();
	const herbert = store.data.boards[0]!.cards.find((c) => c.id !== card.id)!;
	const node = cardNode(view, herbert.id);
	assert.ok(node.classList.contains("compact"));
	// happy-dom has no layout: what it shows is 100 tall, unless a height is set.
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.style.height ? parseFloat(this.style.height) : 100;
		},
	});

	dragBy(node.querySelector(".card-resize")!, 60, 40);
	assert.deepEqual([savedCard(store, herbert.id)?.width, savedCard(store, herbert.id)?.height], [312, herbert.height]);
	assert.equal(cardNode(view, herbert.id).style.width, "312px");
	assert.equal(cardNode(view, herbert.id).style.height, "120px");
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

/** A board with a story: Dune on page 1, and Herbert added on page 2 (copied from page 1). The editor shows the story
 * on page 1; the viewer (at `hash`, if `addressed`) starts as it does. */
async function storyboard({ readOnly = false, addressed = false, hash = "" } = {}) {
	freshDom();
	const store = await createStore(memoryDataPort({ ws: { version: DATA_VERSION, types: [], entities: [], boards: [] } }).port, "ws");
	const book = store.addType("Book", [], "");
	const dune = store.addEntity(book.id, "Dune", "", {});
	const herbert = store.addEntity(book.id, "Herbert", "", {});
	const boardId = store.addBoard("Flow").id;
	const story = store.addStory(boardId, "Pitch", "Start")!;
	const one = story.pages[0]!;
	store.updatePage(boardId, one.id, { description: "Only **Dune**" });
	const duneCard = store.addCard(boardId, dune.id, 0, 0, one.id);
	const two = store.addPage(boardId, one.id, "Then", true)!;
	const herbertCard = store.addCard(boardId, herbert.id, 300, 0, two.id);
	localStorage.setItem("canvas-active-board", boardId);
	localStorage.setItem(`canvas-active-story:${boardId}`, story.id);
	location.hash = hash;
	const view = canvasView(store, { readOnly, addressed });
	document.body.append(view);
	const pages = () => store.data.boards.find((b) => b.id === boardId)!.stories[0]!.pages;
	return { store, view, boardId, story, one, two, duneCard, herbertCard, pages };
}

const shownCards = (view: HTMLElement) =>
	[...view.querySelectorAll<HTMLElement>(".canvas-board .canvas-card:not(.ghost)")].map((c) => c.querySelector(".card-title")?.textContent);
const pageButton = (view: HTMLElement, label: string) => view.querySelector<HTMLButtonElement>(`.page-bar button[title="${label}"]`)!;
/** Picks an item of the story dropdown (opened by the story button) by its name. */
function pickStory(view: HTMLElement, name: string): void {
	view.querySelector<HTMLButtonElement>(".story-switch")!.click();
	[...view.querySelectorAll<HTMLButtonElement>(".story-dialog .picker-option")].find((b) => b.textContent === name)!.click();
}

test("a story shows one page at a time; the page bar and arrow keys step through it", async () => {
	const { view } = await storyboard();
	assert.equal(view.querySelector(".story-switch .picker-name")?.textContent, "Pitch");
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

test("in the editor, × hides a card on this page, + shows it again, and pages are added and named", async () => {
	const { view, two, herbertCard, pages } = await storyboard();

	cardNode(view, herbertCard.id).querySelector<HTMLButtonElement>(".card-remove")!.click(); // + on the ghost
	assert.deepEqual(shownCards(view), ["Dune", "Herbert"]);
	cardNode(view, herbertCard.id).querySelector<HTMLButtonElement>(".card-remove")!.click(); // × again
	assert.deepEqual(shownCards(view), ["Dune"]);
	assert.ok(pages()[1]!.cardIds.includes(herbertCard.id), "still on page 2");

	const name = view.querySelector<HTMLInputElement>(".page-bar input.page-name")!;
	name.value = "Begin";
	name.dispatchEvent(new Event("change"));
	const description = view.querySelector<HTMLTextAreaElement>(".page-description textarea")!;
	description.value = "New text";
	description.dispatchEvent(new Event("change"));
	assert.deepEqual([pages()[0]!.name, pages()[0]!.description], ["Begin", "New text"]);

	// Without "Copy", the new page starts empty; it's added after the current one and shown.
	view.querySelector<HTMLInputElement>(".page-copy input")!.checked = false;
	[...view.querySelectorAll<HTMLButtonElement>(".page-bar button")].find((b) => b.textContent === "+ Page")!.click();
	assert.deepEqual(pages().map((p) => p.name), ["Begin", "Step 3", two.name]);
	assert.deepEqual(shownCards(view), []);
	assert.equal(view.querySelector(".page-counter")?.textContent, "2 / 3");
});

test("the editor's story dropdown shows the whole board or a story, and creates, renames and deletes stories", async () => {
	const { store, view, boardId, duneCard } = await storyboard();
	pickStory(view, "Whole board");
	assert.equal(view.querySelector<HTMLElement>(".page-bar")!.hidden, true);
	assert.deepEqual(shownCards(view), ["Dune", "Herbert"]);
	assert.equal(localStorage.getItem(`canvas-active-story:${boardId}`), "", "remembered");

	view.querySelector<HTMLButtonElement>(".story-switch")!.click();
	const dialog = view.querySelector<HTMLDialogElement>(".story-dialog")!;
	dialog.querySelector<HTMLInputElement>(".picker-new input")!.value = "Demo";
	dialog.querySelector<HTMLFormElement>(".picker-new")!.requestSubmit();
	const board = () => store.data.boards.find((b) => b.id === boardId)!;
	assert.deepEqual(board().stories.map((s) => s.name), ["Pitch", "Demo"]);
	assert.equal(view.querySelector(".story-switch .picker-name")?.textContent, "Demo");
	assert.equal(view.querySelectorAll(".canvas-board .canvas-card:not(.ghost)").length, 0, "its first step shows nothing yet");
	assert.ok(board().cards.some((c) => c.id === duneCard.id), "still on the board, faded");

	view.querySelector<HTMLButtonElement>(".story-switch")!.click();
	const rowOf = (name: string) => [...dialog.querySelectorAll("li")].find((li) => li.querySelector(".picker-option")?.textContent === name)!;
	assert.equal(rowOf("Whole board").querySelectorAll("button").length, 1, "the whole board can't be renamed or deleted");
	[...rowOf("Demo").querySelectorAll("button")].find((b) => b.textContent === "Rename")!.click();
	dialog.querySelector<HTMLInputElement>(".picker-rename input")!.value = "Tour";
	dialog.querySelector<HTMLFormElement>(".picker-rename")!.requestSubmit();
	assert.equal(view.querySelector(".story-switch .picker-name")?.textContent, "Tour");

	Object.assign(globalThis, { confirm: () => true });
	[...rowOf("Tour").querySelectorAll("button")].find((b) => b.textContent === "Delete")!.click();
	assert.deepEqual(board().stories.map((s) => s.name), ["Pitch"]);
	assert.equal(view.querySelector(".story-switch .picker-name")?.textContent, "Whole board", "back to the whole board");
	assert.equal(view.querySelector<HTMLElement>(".page-bar")!.hidden, true);
});

test("the viewer starts with the whole board; a story is picked, stepped through, left and resumed where it was left", async () => {
	const { view } = await storyboard({ readOnly: true });
	assert.deepEqual(shownCards(view), ["Dune", "Herbert"]);
	assert.equal(view.querySelector<HTMLElement>(".page-bar")!.hidden, true);
	assert.equal(view.querySelector<HTMLElement>(".page-description")!.hidden, true);
	assert.equal(view.querySelector(".story-switch .picker-name")?.textContent, "Stories");

	pickStory(view, "Pitch");
	assert.deepEqual(shownCards(view), ["Dune"]);
	assert.equal(view.querySelector(".canvas-card.ghost"), null);
	assert.equal(view.querySelector(".page-bar input"), null);
	assert.equal(view.querySelector(".page-bar .page-name")?.textContent, "Start");
	assert.equal(view.querySelector(".page-description strong")?.textContent, "Dune");
	assert.equal(view.querySelector(".story-dialog .picker-new"), null, "nothing to edit in the viewer");

	pageButton(view, "Next step").click();
	assert.equal(view.querySelector(".page-bar .page-name")?.textContent, "Then");
	assert.equal(view.querySelector<HTMLElement>(".page-description")!.hidden, true); // no description on this page

	[...view.querySelectorAll<HTMLButtonElement>(".page-bar button")].find((b) => b.textContent === "← Board")!.click();
	assert.deepEqual(shownCards(view), ["Dune", "Herbert"]);
	assert.equal(view.querySelector<HTMLElement>(".page-bar")!.hidden, true);
	pickStory(view, "Pitch");
	assert.equal(view.querySelector(".page-bar .page-name")?.textContent, "Then", "where it was left");
});

test("an addressed viewer shows the board, story and step its address names, and keeps the address up to date", async () => {
	const { store, boardId, story, one, two } = await storyboard({ readOnly: true });
	assert.deepEqual(parseViewHash("#boards"), {});
	const target = viewHash({ boardId, storyId: story.id, pageId: two.id });
	assert.equal(target, `#view/${boardId}/${story.id}/${two.id}`);
	assert.deepEqual(parseViewHash(target), { boardId, storyId: story.id, pageId: two.id });

	location.hash = target;
	const viewer = canvasView(store, { readOnly: true, addressed: true });
	document.body.replaceChildren(viewer);
	assert.equal(viewer.querySelector(".page-bar .page-name")?.textContent, "Then");

	pageButton(viewer, "Previous step").click();
	assert.equal(location.hash, viewHash({ boardId, storyId: story.id, pageId: one.id }));
	const entries = history.length;
	[...viewer.querySelectorAll<HTMLButtonElement>(".page-bar button")].find((b) => b.textContent === "← Board")!.click();
	assert.equal(location.hash, `#view/${boardId}`);
	assert.equal(history.length, entries + 1, "leaving the story is a step of its own in the history");
});

test("the step description has the size saved with its page, set on the grid at its corner in the editor", async () => {
	const { view, pages } = await storyboard();
	const box = view.querySelector<HTMLElement>(".canvas-board .page-description")!;
	assert.deepEqual([box.style.width, box.style.height], ["384px", "120px"]);

	dragBy(box.querySelector<HTMLElement>(".card-resize")!, 40, -1000);
	assert.deepEqual(pages()[0]!.descriptionSize, { width: 432, height: 48 }); // 424 snaps to 432; never below the minimum
	assert.deepEqual([box.style.width, box.style.height], ["432px", "48px"]);
});

test("a step description sits on the canvas like a card: dragging its handle moves it on the grid in world coordinates", async () => {
	const { view, one, pages } = await storyboard();
	const box = view.querySelector<HTMLElement>(".canvas-board .page-description")!;
	assert.ok(box, "inside the panned and zoomed layer");
	const before = one.descriptionPosition;

	dragBy(box.querySelector<HTMLElement>(".page-description-handle")!, 50, 30);
	const after = pages()[0]!.descriptionPosition;
	assert.deepEqual(after, { x: snapToGrid(before.x + 50), y: snapToGrid(before.y + 30) });
	assert.deepEqual([box.style.left, box.style.top], [`${after.x}px`, `${after.y}px`]);

	// Grabbed again, it moves on from where it is now.
	dragBy(box.querySelector<HTMLElement>(".page-description-handle")!, 10, -20);
	assert.deepEqual(pages()[0]!.descriptionPosition, { x: after.x, y: after.y - 24 }); // 10 right stays in place, 20 up snaps a whole cell
});

test("× in a story never deletes a card from the board, and Description here brings the description into view", async () => {
	const { store, view, boardId, one, duneCard, pages } = await storyboard();
	const board = () => store.data.boards.find((b) => b.id === boardId)!;
	// Off page 1 by ×, and off page 2 as well: on no page at all.
	cardNode(view, duneCard.id).querySelector<HTMLButtonElement>(".card-remove")!.click();
	store.removeCard(duneCard.id, pages()[1]!.id);
	assert.ok(board().cards.some((c) => c.id === duneCard.id), "still on the board");
	assert.ok(cardNode(view, duneCard.id).classList.contains("ghost"));

	store.updatePage(boardId, one.id, { descriptionPosition: { x: 5000, y: 5000 } });
	[...view.querySelectorAll<HTMLButtonElement>(".page-bar button")].find((b) => b.textContent === "Description here")!.click();
	assert.deepEqual(pages()[0]!.descriptionPosition, { x: 72, y: 24 }); // the view is at the origin here; 16 snaps to 24
	assert.equal(view.querySelector<HTMLElement>(".page-description")!.style.left, "72px");
});

test("◐ dims a card on this step only; the viewer shows it dimmed while stepping through", async () => {
	const { store, view, duneCard, pages } = await storyboard();
	const dim = () => cardNode(view, duneCard.id).querySelector<HTMLButtonElement>(".card-dim")!;
	assert.equal(dim().ariaPressed, "false");
	dim().click();
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
	pickStory(viewer, "Pitch");
	assert.ok(cardNode(viewer, duneCard.id).classList.contains("dimmed"));
});

test("the zoom buttons go one 10% step in or out", async () => {
	const { view } = await setup();
	const zoom = view.querySelector<HTMLElement>(".canvas-zoom")!;
	const [out, , zoomIn] = zoom.children as unknown as HTMLButtonElement[];
	zoomIn!.click();
	zoomIn!.click();
	assert.equal(zoom.querySelector(".zoom-label")?.textContent, "120%");
	out!.click();
	assert.equal(zoom.querySelector(".zoom-label")?.textContent, "110%");
});

/** A drag from the side panel dropped on `target` at (x, y), carrying `data` (happy-dom's DragEvent leaves out the
 * dataTransfer, so it's put on the event). */
function drop(target: Element, data: Record<string, string>, x = 200, y = 150): void {
	const transfer = new DataTransfer();
	for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
	const event = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y });
	Object.defineProperty(event, "dataTransfer", { value: transfer });
	target.dispatchEvent(event);
}

test("library drawings are dragged from the side panel onto the board, and always drawn as they are in the library", async () => {
	freshDom();
	const store = await createStore(memoryDataPort({ ws: { version: DATA_VERSION, types: [], entities: [], boards: [] } }).port, "ws");
	const star = store.addLibraryDrawing("Star");
	store.updateLibraryDrawing(star.id, { tags: ["sky"] });
	const circle = store.addToLibraryDrawing(star.id, { kind: "ellipse", x: 0, y: 0, width: 80, height: 40, color: "#f6e8a6", text: "", textSize: "m" });
	const edits: string[] = [];
	const view = canvasView(store, { readOnly: false, onEditLibraryDrawing: (id) => edits.push(id) });
	document.body.append(view);

	[...view.querySelectorAll<HTMLButtonElement>(".panel-tab")].find((b) => b.textContent === "Drawings")!.click();
	const item = view.querySelector<HTMLElement>(".library-item")!;
	assert.equal(item.dataset.libraryId, star.id);
	assert.match(item.textContent ?? "", /Star.*sky/);

	drop(view.querySelector(".canvas-surface")!, { "application/x-library-drawing-id": star.id });
	const [placed] = store.data.boards[0]!.drawings;
	assert.equal(placed?.kind, "symbol");
	assert.equal(placed?.kind === "symbol" && placed.libraryId, star.id);
	// Its content's size, with a little room around it.
	assert.deepEqual(placed?.kind === "symbol" && [placed.width, placed.height], [96, 56]);
	assert.equal(view.querySelectorAll(".drawings .library-picture ellipse").length, 1);
	assert.match(view.querySelector(".library-item")!.textContent ?? "", /On canvas/);

	// Selected right away: its style bar opens it in the library.
	[...view.querySelectorAll<HTMLButtonElement>(".drawing-style button")].find((b) => b.textContent === "Edit in library")!.click();
	assert.deepEqual(edits, [star.id]);

	// Changed in the library, the board shows the change: it holds no copy.
	store.replaceDrawing({ ...circle, kind: "rect" } as typeof circle);
	const again = canvasView(store, { readOnly: true });
	document.body.append(again);
	assert.equal(again.querySelectorAll(".drawings .library-picture ellipse").length, 0);
	assert.equal(again.querySelectorAll(".drawings .library-picture rect.drawing-shape").length, 1);
});

test("the pen draws smoothed strokes in the style picked for it", async () => {
	const { store, view } = await setup();
	const button = (label: string) => [...view.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.ariaLabel === label || b.textContent === label)!;
	button("Pen").click();
	button("Highlighter").click();
	assert.equal(button("Highlighter").ariaPressed, "true");

	// A shaky horizontal stroke comes out flatter than it was drawn.
	const surface = view.querySelector<HTMLElement>(".canvas-surface")!;
	const at = (type: string, x: number, y: number) =>
		surface.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y }));
	at("pointerdown", 0, 0);
	[10, 20, 30, 40, 50, 60].forEach((x, i) => at("pointermove", x, i % 2 === 0 ? 8 : -8));
	at("pointerup", 60, -8);

	const [stroke] = store.data.boards[0]!.drawings;
	assert.equal(stroke?.kind === "pen" && stroke.penStyle, "highlighter");
	const ys = stroke?.kind === "pen" ? stroke.points.slice(1).map((p) => p.y) : [];
	assert.ok(ys.every((y) => Math.abs(y) < 8));
	const path = view.querySelector<SVGElement>(".drawings path.drawing-stroke.pen-highlighter");
	// In the light color itself, like all pen strokes.
	assert.equal(path?.style.stroke, stroke?.kind === "pen" ? stroke.color : "");
});

test("the eraser rubs out the part of a pen stroke it passes over, in one change that undo brings back", async () => {
	const { store, view } = await setup();
	const boardId = store.data.boards[0]!.id;
	const stroke = store.addDrawing(boardId, { kind: "pen", points: [{ x: -200, y: 0 }, { x: 200, y: 0 }], color: "#4a4a4a", penStyle: "fineliner" });
	const line = store.addDrawing(boardId, { kind: "line", points: [{ x: -200, y: 10 }, { x: 200, y: 10 }], color: "#4a4a4a" });
	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));

	const surface = view.querySelector<HTMLElement>(".canvas-surface")!;
	const at = (type: string, x: number, y: number) =>
		surface.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y }));
	// The world's origin, on the screen (the board is at zoom 1).
	const origin = { x: store.data.boards[0]!.viewport.x, y: store.data.boards[0]!.viewport.y };
	at("pointerdown", origin.x, origin.y - 30);
	at("pointermove", origin.x, origin.y + 5);
	assert.ok(view.querySelector(".drawings .eraser-outline"));
	at("pointerup", origin.x, origin.y + 5);

	const drawings = store.data.boards[0]!.drawings;
	// Cut in two around x = 0, beyond the eraser's reach; both pieces keep the stroke's look. The line isn't a pen
	// stroke: it stays.
	assert.equal(drawings.length, 3);
	const pieces = drawings.filter((d) => d.kind === "pen");
	assert.deepEqual(pieces.map((d) => d.kind === "pen" && [d.points[0]!.x, d.points.at(-1)!.x, d.penStyle]), [[-200, -15, "fineliner"], [15, 200, "fineliner"]]);
	assert.ok(drawings.some((d) => d.id === line.id));
	assert.equal(view.querySelector(".drawings .eraser-outline"), null);

	store.undo();
	assert.deepEqual(store.data.boards[0]!.drawings.map((d) => d.id), [stroke.id, line.id]);
});

test("a mouse wheel notch zooms in or out by about 10% around the pointer", async () => {
	const { view } = await setup();
	const surface = view.querySelector<HTMLElement>(".canvas-surface")!;
	surface.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaMode: 1, deltaY: -3 }));
	assert.equal(view.querySelector(".zoom-label")?.textContent, "110%");
});

test("the side panel's width can be changed with its handle and is remembered; a double-click resets it", async () => {
	const { view } = await setup();
	const panel = view.querySelector<HTMLElement>(".canvas-panel")!;
	const handle = panel.nextElementSibling as HTMLElement;
	assert.ok(handle.classList.contains("resize-handle"));
	handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
	assert.equal(panel.style.getPropertyValue("--panel-width"), "192px", "clamped to the 12rem minimum");
	assert.equal(localStorage.getItem("canvas-panel-width"), "192px");
	handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
	assert.equal(panel.style.getPropertyValue("--panel-width"), "");
});

test("the drawing tools fold down to the current tool, and stay folded", async () => {
	const { store, view } = await setup();
	const tools = view.querySelector<HTMLElement>(".drawing-tools")!;
	tools.querySelector<HTMLButtonElement>(".tools-toggle")!.click();
	assert.ok(tools.classList.contains("collapsed"));
	const again = canvasView(store, { readOnly: false });
	assert.ok(again.querySelector(".drawing-tools")!.classList.contains("collapsed"));
});

/** Opens the boards dropdown with the Change board button, which shows the current board's name. */
function openBoards(view: HTMLElement): HTMLDialogElement {
	view.querySelector<HTMLButtonElement>(".board-switch")!.click();
	const dialog = view.querySelector<HTMLDialogElement>(".board-dialog")!;
	assert.ok(dialog.open);
	return dialog;
}
const boardOption = (dialog: HTMLElement, name: string) =>
	[...dialog.querySelectorAll<HTMLButtonElement>(".picker-option")].find((b) => b.textContent === name)!;

test("the boards dropdown creates a board and switches to it, and switches back by clicking a board", async () => {
	const { store, view } = await setup();
	assert.equal(view.querySelector(".board-switch .picker-name")?.textContent, "Board 1");
	let dialog = openBoards(view);
	dialog.querySelector<HTMLInputElement>(".picker-new input")!.value = "Planning";
	dialog.querySelector<HTMLFormElement>(".picker-new")!.requestSubmit();
	assert.ok(!dialog.open);
	assert.deepEqual(store.data.boards.map((b) => b.name), ["Board 1", "Planning"]);
	assert.equal(view.querySelector(".board-switch .picker-name")?.textContent, "Planning");
	assert.equal(view.querySelectorAll(".canvas-card[data-card-id]").length, 0, "the new board is empty");

	dialog = openBoards(view);
	assert.equal(boardOption(dialog, "Planning").getAttribute("aria-current"), "true");
	boardOption(dialog, "Board 1").click();
	assert.equal(view.querySelector(".board-switch .picker-name")?.textContent, "Board 1");
	assert.equal(view.querySelectorAll(".canvas-card[data-card-id]").length, 2);
});

test("the boards dropdown opens under its button and closes with Escape, a click beside it, or its button again", async () => {
	const { view } = await setup();
	const button = view.querySelector<HTMLButtonElement>(".board-switch")!;
	let dialog = openBoards(view);
	assert.equal(button.getAttribute("aria-expanded"), "true");
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.ok(!dialog.open);
	assert.equal(button.getAttribute("aria-expanded"), "false");

	dialog = openBoards(view);
	dialog.querySelector("h2")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
	assert.ok(dialog.open, "a click inside keeps it open");
	view.querySelector(".canvas-surface")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
	assert.ok(!dialog.open);

	dialog = openBoards(view);
	button.click();
	assert.ok(!dialog.open);
});

test("boards are reordered in the dropdown with their drag handles' arrow keys; focus stays on the moved one", async () => {
	const { store, view } = await setup();
	const planning = store.addBoard("Planning");
	const dialog = openBoards(view);
	const press = (handle: Element, key: string) => handle.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

	press(dialog.querySelectorAll(".drag-handle")[1]!, "ArrowUp");
	assert.deepEqual(store.data.boards.map((b) => b.name), ["Planning", "Board 1"]);
	assert.deepEqual([...dialog.querySelectorAll(".picker-option")].map((b) => b.textContent), ["Planning", "Board 1"]);
	assert.equal((document.activeElement as HTMLElement).dataset.focusKey, planning.id);
	press(document.activeElement!, "ArrowUp"); // already first: nothing changes
	assert.deepEqual(store.data.boards.map((b) => b.name), ["Planning", "Board 1"]);
	assert.equal(view.querySelector(".board-switch .picker-name")?.textContent, "Board 1", "the current board stays");
});

test("a board is renamed in place in the dropdown; Escape keeps the old name", async () => {
	const { store, view } = await setup();
	const dialog = openBoards(view);
	const rename = () => [...dialog.querySelectorAll<HTMLButtonElement>("li button")].find((b) => b.textContent === "Rename")!.click();
	rename();
	const input = dialog.querySelector<HTMLInputElement>(".picker-rename input")!;
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	assert.equal(dialog.querySelector(".picker-rename"), null);
	rename();
	dialog.querySelector<HTMLInputElement>(".picker-rename input")!.value = "Roadmap";
	dialog.querySelector<HTMLFormElement>(".picker-rename")!.requestSubmit();
	assert.equal(store.data.boards[0]!.name, "Roadmap");
	assert.ok(boardOption(dialog, "Roadmap"));
	assert.equal(view.querySelector(".board-switch .picker-name")?.textContent, "Roadmap");
});

test("deleting the last board leaves only a button creating the first one", async () => {
	const { store, view } = await setup();
	const questions: string[] = [];
	Object.assign(globalThis, { confirm: (message: string) => (questions.push(message), true) });
	const dialog = openBoards(view);
	[...dialog.querySelectorAll<HTMLButtonElement>("li button")].find((b) => b.textContent === "Delete")!.click();
	assert.deepEqual(questions, [text.confirmDeleteBoard("Board 1", 2)]);
	assert.equal(store.data.boards.length, 0);
	const first = document.querySelector<HTMLButtonElement>(".first-board button")!;
	assert.equal(first.textContent, "Create first board");
	first.click();
	assert.deepEqual(store.data.boards.map((b) => b.name), ["Board 1"]);
	assert.ok(document.querySelector(".canvas-view"));
	assert.equal(document.querySelector(".first-board"), null);
});

test("in the viewer, the boards dropdown only switches boards", async () => {
	const { view } = await setup({ readOnly: true });
	const dialog = openBoards(view);
	assert.equal(dialog.querySelector(".picker-new"), null);
	assert.deepEqual([...dialog.querySelectorAll("li button")].map((b) => b.className), ["picker-option"]);
});

/** Presses `button` on `target` at (x, y) (with Shift or not), moves to (x + dx, y + dy) and releases there. */
function press(target: Element, x: number, y: number, dx: number, dy: number, { button = 0, shiftKey = false } = {}): void {
	const at = (type: string, px: number, py: number) =>
		target.dispatchEvent(
			new PointerEvent(type, { bubbles: true, cancelable: true, button, shiftKey, pointerId: 1, pointerType: "mouse", clientX: px, clientY: py }),
		);
	at("pointerdown", x, y);
	at("pointermove", x + dx, y + dy);
	at("pointerup", x + dx, y + dy);
}
const shiftClick = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
const selectedCards = (view: HTMLElement) =>
	[...view.querySelectorAll<HTMLElement>(".canvas-card.selected[data-card-id]")].map((n) => n.dataset.cardId);

test("Shift+click selects several cards; dragging one moves them all in one undo step, without details", async () => {
	const { store, view, card } = await setup();
	const other = store.data.boards[0]!.cards.find((c) => c.id !== card.id)!;
	cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.equal(details(view).hidden, false);
	shiftClick(cardNode(view, other.id).querySelector("header")!);
	assert.deepEqual(selectedCards(view), [card.id, other.id]);
	assert.equal(details(view).hidden, true, "no details for several cards");

	dragBy(cardNode(view, other.id).querySelector("header")!, 50, 30);
	assert.deepEqual([savedCard(store, card.id), savedCard(store, other.id)].map((c) => [c?.x, c?.y]), [[148, 124], [448, 124]]);
	assert.deepEqual(selectedCards(view), [card.id, other.id], "still both selected");
	store.undo();
	assert.deepEqual([savedCard(store, card.id), savedCard(store, other.id)].map((c) => [c?.x, c?.y]), [[100, 100], [400, 100]]);

	shiftClick(cardNode(view, other.id).querySelector("header")!);
	assert.deepEqual(selectedCards(view), [card.id], "Shift+click again takes one out; one left is selected as usual");
	assert.equal(details(view).hidden, false);
});

test("dragging on the empty board frames cards and drawings to select them; a click there clears the selection", async () => {
	const { store, view, card } = await setup();
	const boardId = store.data.boards[0]!.id;
	const box = store.addDrawing(boardId, { kind: "rect", x: 120, y: 300, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
	store.addDrawing(boardId, { kind: "rect", x: 900, y: 900, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
	const surface = view.querySelector<HTMLElement>(".canvas-surface")!;
	const { x, y } = store.data.boards[0]!.viewport; // where the world's origin is on the screen (zoom 1)

	press(surface, x + 50, y + 50, 150, 300); // touches Dune's card (100, 100) and the box, not Herbert's card (400, 100)
	assert.deepEqual(selectedCards(view), [card.id]);
	assert.equal(view.querySelectorAll(".drawings .selection-outline").length, 1, "the framed drawing is outlined");
	assert.equal(details(view).hidden, true);

	dragBy(cardNode(view, card.id).querySelector("header")!, 48, 0); // the box goes along
	assert.deepEqual([savedCard(store, card.id)?.x, store.data.boards[0]!.drawings.find((d) => d.id === box.id)], [148, { ...box, x: 168 }]);

	press(surface, x + 10, y + 10, 0, 0);
	assert.deepEqual(selectedCards(view), []);
	assert.equal(view.querySelectorAll(".drawings .selection-outline").length, 0);
});

test("a group is drawn with its tool and named right away", async () => {
	const { store, view } = await setup();
	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
	const surface = view.querySelector<HTMLElement>(".canvas-surface")!;
	press(surface, 10, 10, 300, 200);

	const [area] = store.data.boards[0]!.drawings;
	assert.deepEqual(area && [area.kind, "width" in area && area.width, "height" in area && area.height], ["area", 300, 200]);
	const input = view.querySelector<HTMLTextAreaElement>(".drawings textarea.drawing-editor.area-name")!;
	input.value = "Team";
	input.dispatchEvent(new FocusEvent("blur"));
	assert.equal(store.data.boards[0]!.drawings[0]?.kind === "area" && store.data.boards[0]!.drawings[0].text, "Team");
	assert.equal(view.querySelector(".drawings .drawing-label.area-name")?.textContent, "Team");
});

test("dragging a group moves the cards and drawings lying in it along, in one undo step", async () => {
	const { store, view: first, card } = await setup();
	const boardId = store.data.boards[0]!.id;
	const other = store.data.boards[0]!.cards.find((c) => c.id !== card.id)!; // Herbert's card at (400, 100): outside
	const box = store.addDrawing(boardId, { kind: "rect", x: 120, y: 300, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
	// Made last, the group is still drawn below the box.
	const area = store.addDrawing(boardId, { kind: "area", x: 72, y: 72, width: 312, height: 312, color: "#c4dafa", text: "Team", textSize: "m" });
	first.remove();
	const view = canvasView(store, { readOnly: false });
	document.body.append(view);
	assert.deepEqual([...view.querySelectorAll(".drawings g.drawing")].map((g) => g.getAttribute("data-id")), [area.id, box.id]);

	// Pressing redraws the drawings; the surface captures the pointer (as the browser would send it there).
	const surface = view.querySelector<HTMLElement>(".canvas-surface")!;
	const pointer = (target: Element, type: string, x: number, y: number) =>
		target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y }));
	pointer(view.querySelector(`.drawings g[data-id="${area.id}"] rect`)!, "pointerdown", 0, 0);
	pointer(surface, "pointermove", 48, 24);
	pointer(surface, "pointerup", 48, 24);
	const drawings = () => store.data.boards[0]!.drawings;
	assert.deepEqual(
		[savedCard(store, card.id), savedCard(store, other.id), ...drawings()].map((i) => [i && "x" in i && i.x, i && "y" in i && i.y]),
		[[148, 124], [400, 100], [168, 324], [120, 96]],
	);
	assert.deepEqual(selectedCards(view), [], "only the group is selected");

	store.undo();
	assert.deepEqual(
		[savedCard(store, card.id), ...drawings()].map((i) => [i && "x" in i && i.x, i && "y" in i && i.y]),
		[[100, 100], [120, 300], [72, 72]],
	);
});

test("the middle button pans instead of selecting; Escape clears a selection", async () => {
	const { store, view } = await setup();
	const surface = view.querySelector<HTMLElement>(".canvas-surface")!;
	const layer = view.querySelector<HTMLElement>(".canvas-board")!;
	const before = layer.style.transform;
	press(surface, 10, 10, 40, 20, { button: 1 });
	assert.notEqual(layer.style.transform, before);
	assert.equal(view.querySelector<HTMLElement>(".marquee")!.hidden, true);

	const { x, y } = store.data.boards[0]!.viewport;
	press(surface, x - 1000, y - 1000, 3000, 3000);
	assert.equal(selectedCards(view).length, 2);
	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.deepEqual(selectedCards(view), []);
});

/** Book (author: one Person, inverse label "wrote") and Person; Dune's card selected on the board editor. */
async function connectable() {
	freshDom();
	const store = await createStore(memoryDataPort({ ws: { version: DATA_VERSION, types: [], entities: [], boards: [] } }).port, "ws");
	const person = store.addType("Person", [], "");
	const reference = { typeIds: [person.id], multiple: false, arrow: "to" as const, lineLabel: "", inverseLabel: "wrote" };
	const book = store.addType("Book", [{ name: "author", kind: "reference", options: [], reference, cardDisplay: "line" }], "");
	const dune = store.addEntity(book.id, "Dune", "", {});
	const card = store.addCard(store.data.boards[0]!.id, dune.id, 0, 0);
	const view = canvasView(store, { readOnly: false });
	document.body.append(view);
	cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	return { store, view, person, book, author: book.properties[0]!, dune, card };
}
const detailsButton = (view: HTMLElement, label: string) =>
	[...details(view).querySelectorAll<HTMLButtonElement>(".details-actions button")].find((b) => b.textContent === label);
const connectDialog = (view: HTMLElement) => view.querySelector<HTMLDialogElement>(".connect-dialog")!;

test("{{Property}} in the description shows the value: a reference as a tag that shows its details, empty as —", async () => {
	const { store, person, author, dune, card } = await connectable();
	const detailsOf = (values: Record<string, string>) => {
		store.updateEntity(dune.id, "Dune", "", values, "By **{{ Author }}**, {{typo}}", []);
		freshDom();
		const view = canvasView(store, { readOnly: false });
		document.body.append(view);
		cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		return details(view);
	};
	assert.equal(detailsOf({}).querySelector(".markdown")?.textContent, "By —, {{typo}}");

	const frank = store.addEntity(person.id, "Frank", "", {});
	const panel = detailsOf({ [author.id]: frank.id });
	const tag = panel.querySelector<HTMLButtonElement>(".markdown strong .ref-tag")!;
	assert.equal(tag.textContent, "Frank");
	tag.click();
	assert.equal(panel.querySelector(".details-title")?.textContent, "Frank");
});

test("Connect creates a new entity the card's entity links to, its card beside it; the selection stays", async () => {
	const { store, view, author, dune, card } = await connectable();
	detailsButton(view, "Connect")!.click();
	const dialog = connectDialog(view);
	assert.ok(dialog.open);
	assert.deepEqual([...dialog.querySelectorAll("select option")].map((o) => o.textContent), ["author → Person"]);
	dialog.querySelector<HTMLInputElement>(".connect-new input")!.value = "Frank Herbert";
	dialog.querySelector<HTMLFormElement>(".connect-new")!.requestSubmit();

	assert.ok(!dialog.open);
	const frank = store.data.entities.find((e) => e.name === "Frank Herbert")!;
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.values[author.id], frank.id);
	const placed = store.data.boards[0]!.cards.find((c) => c.entityId === frank.id)!;
	assert.deepEqual([placed.x, placed.y], [288, 0]);
	assert.ok(cardNode(view, card.id).classList.contains("selected"));
	assert.ok(view.querySelector(".connectors path, .connectors line"), "linked by a line");
	// Dune's single author is set: nothing left to connect it through.
	assert.equal(detailsButton(view, "Connect")!.disabled, true);
});

test("selecting a card fades the board but its chain: the cards linked to it either way, through others too", async () => {
	const { store, person, book, author, card } = await connectable();
	const boardId = store.data.boards[0]!.id;
	const frank = store.addEntity(person.id, "Frank", "", {});
	const sequel = store.addEntity(book.id, "Children of Dune", "", { [author.id]: frank.id });
	const other = store.addEntity(person.id, "Jane", "", {});
	store.updateEntity(card.entityId, "Dune", "", { [author.id]: frank.id }, "", []);
	const frankCard = store.addCard(boardId, frank.id, 300, 0);
	const sequelCard = store.addCard(boardId, sequel.id, 600, 0);
	const otherCard = store.addCard(boardId, other.id, 0, 300);
	freshDom();
	const view = canvasView(store, { readOnly: false });
	document.body.append(view);
	const inChain = () =>
		[card, frankCard, sequelCard, otherCard].filter((c) => cardNode(view, c.id).classList.contains("in-chain")).map((c) => c.id);
	const board = view.querySelector(".canvas-board")!;

	// Dune → Frank ← Children of Dune: all three stand out from Dune, not Jane.
	cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.ok(board.classList.contains("focusing"));
	assert.deepEqual(inChain(), [card.id, frankCard.id, sequelCard.id]);
	assert.equal(view.querySelectorAll(".connector.in-chain").length, 2);

	cardNode(view, otherCard.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.deepEqual(inChain(), [otherCard.id]);
	assert.equal(view.querySelectorAll(".connector.in-chain").length, 0);

	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.ok(!board.classList.contains("focusing"));
});

test("Connect links an existing entity, found by name, and the other way round too", async () => {
	const { store, view, person, book, author, dune } = await connectable();
	const frank = store.addEntity(person.id, "Frank", "", {});
	store.addEntity(person.id, "Jane", "", {});
	detailsButton(view, "Connect")!.click();
	const dialog = connectDialog(view);
	const search = dialog.querySelector<HTMLInputElement>(".connect-existing input")!;
	search.value = "fra";
	search.dispatchEvent(new Event("input"));
	const options = [...dialog.querySelectorAll<HTMLButtonElement>(".connect-list button")];
	assert.deepEqual(options.map((b) => b.textContent), ["Frank"]);
	options[0]!.click();
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.values[author.id], frank.id);
	const frankCard = store.data.boards[0]!.cards.find((c) => c.entityId === frank.id)!;

	// From Frank's card: a new book he wrote (the book holds the reference).
	cardNode(view, frankCard.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	detailsButton(view, "Connect")!.click();
	assert.deepEqual([...dialog.querySelectorAll("select option")].map((o) => o.textContent), ["wrote → Book"]);
	dialog.querySelector<HTMLInputElement>(".connect-new input")!.value = "Children of Dune";
	dialog.querySelector<HTMLFormElement>(".connect-new")!.requestSubmit();
	const sequel = store.data.entities.find((e) => e.name === "Children of Dune")!;
	assert.deepEqual([sequel.typeId, sequel.values[author.id]], [book.id, frank.id]);
});

test("+ Entity creates an entity of any type with its card on the board, and selects it", async () => {
	const { store, view, person } = await connectable();
	[...view.querySelectorAll<HTMLButtonElement>(".board-controls button")].find((b) => b.textContent === "+ Entity")!.click();
	const dialog = view.querySelector<HTMLDialogElement>(".new-entity-dialog")!;
	assert.ok(dialog.open);
	const typeSelect = dialog.querySelector<HTMLSelectElement>("select")!;
	typeSelect.value = person.id;
	dialog.querySelector<HTMLInputElement>(".connect-new input")!.value = "Ada";
	dialog.querySelector<HTMLFormElement>(".connect-new")!.requestSubmit();
	const ada = store.data.entities.find((e) => e.name === "Ada")!;
	assert.equal(ada.typeId, person.id);
	const adaCard = store.data.boards[0]!.cards.find((c) => c.entityId === ada.id)!;
	assert.ok(cardNode(view, adaCard.id).classList.contains("selected"));
	assert.equal(details(view).querySelector(".details-title")?.textContent, "Ada");
});

test("the viewer's details have no Connect button", async () => {
	const { view, card } = await setup({ readOnly: true });
	cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.equal(detailsButton(view, "Connect"), undefined);
});

/** Gives the canvas a size (happy-dom lays nothing out) and makes the pan/zoom move at once (reduced motion). */
function laidOut(view: HTMLElement, width = 800, height = 600): void {
	const surface = view.querySelector<HTMLElement>(".canvas-surface")!;
	Object.defineProperties(surface, { clientWidth: { value: width }, clientHeight: { value: height } });
	Object.assign(window, { matchMedia: (query: string) => ({ matches: query.includes("reduced-motion") }) });
}

const transform = (view: HTMLElement) => view.querySelector<HTMLElement>(".canvas-board")!.style.transform;
const viewportTransform = ({ x, y, zoom }: { x: number; y: number; zoom: number }) => `translate(${x}px, ${y}px) scale(${zoom})`;
const frameName = (view: HTMLElement) => view.querySelector(".frame-switch .picker-name")?.textContent;

/** Picks an item of the frame dropdown by its name. */
function pickFrame(view: HTMLElement, name: string): void {
	view.querySelector<HTMLButtonElement>(".frame-switch")!.click();
	[...view.querySelectorAll<HTMLButtonElement>(".frame-dialog .picker-option")].find((b) => b.textContent === name)!.click();
}

/** Turns on editing the frames in the editor, as its toggle does: only then are they shown, with their controls. */
function editFrames(view: HTMLElement): void {
	const toggle = view.querySelector<HTMLButtonElement>(".frames-toggle")!;
	if (toggle.ariaPressed !== "true") toggle.click();
}

test("in the editor, frames are only shown, with their controls, while editing them; that is remembered", async () => {
	const { store, view } = await storyboard();
	const toggle = () => view.querySelector<HTMLButtonElement>(".frames-toggle")!;
	assert.equal(toggle().ariaPressed, "false");
	assert.equal(view.querySelector(".view-frame, .frame-switch, .frame-from-view"), null);

	toggle().click();
	assert.equal(toggle().ariaPressed, "true");
	assert.equal(toggle().textContent, `▭${text.doneEditingFrames}`);
	assert.ok(view.querySelector(".view-frame.board-frame"));
	assert.ok(view.querySelector(".frame-switch"));
	assert.ok(view.querySelector(".frame-from-view"));

	const again = canvasView(store, { readOnly: false });
	assert.ok(again.querySelector(".view-frame.board-frame"), "still editing frames when the canvas is shown again");

	toggle().click();
	assert.equal(view.querySelector(".view-frame, .frame-switch, .frame-from-view"), null);
});

test("in the editor, a step gets a frame of what is seen, else the board's; only stepping into another frame moves the board", async () => {
	const { store, view, boardId, pages } = await storyboard();
	laidOut(view);
	editFrames(view);
	const board = () => store.data.boards.find((b) => b.id === boardId)!;
	const zoomOut = () => view.querySelector<HTMLButtonElement>(`.canvas-zoom button[title="${text.zoomOut}"]`)!.click();
	assert.equal(frameName(view), "Board frame");
	assert.equal(view.querySelector(".view-frame.board-frame.current .view-frame-label")?.textContent, "Board frame");

	view.querySelector<HTMLButtonElement>(".frame-switch")!.click();
	const form = view.querySelector<HTMLFormElement>(".frame-dialog .picker-new")!;
	form.querySelector("input")!.value = "Wide";
	form.requestSubmit();
	const [wide] = board().frames;
	// What is seen, in a screen's shape: as wide as the 800 × 600 canvas, centered top to bottom.
	assert.deepEqual(wide, { id: wide!.id, name: "Wide", x: 0, y: 75, width: 800, height: 450 });
	assert.deepEqual(pages().map((p) => p.frameId), [wide!.id, null]);
	assert.equal(frameName(view), "Wide");
	assert.equal(view.querySelector(".view-frame.current .view-frame-label")?.textContent, "Wide");

	// The next step is in the board's frame: the board moves there.
	pageButton(view, "Next step").click();
	assert.equal(frameName(view), "Board frame");
	assert.equal(transform(view), viewportTransform(fitRect(board().viewFrame, 800, 600, 48)));

	// Picking a frame goes to it; stepping back to a step in the same frame stays.
	pickFrame(view, "Wide");
	assert.equal(pages()[1]!.frameId, wide!.id);
	assert.equal(transform(view), viewportTransform(fitRect(wide!, 800, 600, 48)));
	zoomOut();
	const zoomedOut = transform(view);
	pageButton(view, "Previous step").click();
	assert.equal(transform(view), zoomedOut);

	// Outside a story there's only the board's frame: no picker, no step frames.
	pickStory(view, "Whole board");
	assert.equal(view.querySelector(".frame-switch"), null);
	assert.deepEqual([...view.querySelectorAll(".view-frame-label")].map((l) => l.textContent), ["Board frame"]);
});

test("in the editor, frames are moved by their name and resized at their corner, on the grid; deleting one frees its steps", async () => {
	const { store, view, boardId, one, pages } = await storyboard();
	store.addFrame(boardId, "Wide", { x: 0, y: 0, width: 480, height: 240 }, one.id);
	const editor = canvasView(store, { readOnly: false });
	document.body.replaceChildren(editor);
	view.remove();
	editFrames(editor);
	const board = () => store.data.boards.find((b) => b.id === boardId)!;
	const stepFrame = () => editor.querySelector<HTMLElement>(".view-frame:not(.board-frame)")!;

	dragBy(stepFrame().querySelector<HTMLElement>(".view-frame-label")!, 50, 30);
	assert.deepEqual([board().frames[0]?.x, board().frames[0]?.y], [48, 24]);
	dragBy(stepFrame().querySelector<HTMLElement>(".card-resize")!, 0, 54);
	assert.deepEqual([board().frames[0]?.width, board().frames[0]?.height], [576, 324], "dragged down: as much wider, in a screen's shape");
	dragBy(stepFrame().querySelector<HTMLElement>(".card-resize")!, -1000, 20);
	assert.deepEqual([board().frames[0]?.width, board().frames[0]?.height], [192, 108], "never below the minimum");
	assert.equal(stepFrame().style.left, "48px");

	// The board's own frame, likewise.
	dragBy(editor.querySelector<HTMLElement>(".board-frame .view-frame-label")!, -50, 0);
	dragBy(editor.querySelector<HTMLElement>(".board-frame .card-resize")!, 100, 0);
	assert.deepEqual(board().viewFrame, { x: -48, y: 0, width: 1392, height: 783 }, "the width on the grid, the height following");

	Object.assign(globalThis, { confirm: () => true });
	editor.querySelector<HTMLButtonElement>(".frame-switch")!.click();
	[...editor.querySelectorAll<HTMLButtonElement>(".frame-dialog button")].find((b) => b.textContent === text.delete)!.click();
	assert.deepEqual([board().frames, pages()[0]!.frameId], [[], null]);
	assert.equal(stepFrame(), null);
	assert.equal(frameName(editor), "Board frame");
});

test("the viewer fits the board's frame into the screen, and a step's own frame, else the board's", async () => {
	const { store, boardId, one } = await storyboard({ readOnly: true });
	store.addFrame(boardId, "Wide", { x: 0, y: 0, width: 400, height: 300 }, one.id);
	const viewer = canvasView(store, { readOnly: true });
	document.body.replaceChildren(viewer);
	laidOut(viewer);
	const reset = () => [...viewer.querySelectorAll<HTMLButtonElement>(".canvas-zoom button")].find((b) => b.textContent === text.resetView)!.click();
	const boardFrame = store.data.boards.find((b) => b.id === boardId)!.viewFrame;

	reset();
	assert.equal(transform(viewer), viewportTransform(fitRect(boardFrame, 800, 600)));
	assert.equal(viewer.querySelector(".view-frame, .frame-switch"), null, "the viewer shows no frames");

	pickStory(viewer, "Pitch");
	assert.equal(transform(viewer), "translate(0px, 75px) scale(2)"); // 400 × 225 fills the width
	pageButton(viewer, "Next step").click();
	assert.equal(transform(viewer), viewportTransform(fitRect(boardFrame, 800, 600)));
});

test("the viewer keeps where it was panned to when the canvas changes size, e.g. as a card's details open", async () => {
	const { store, duneCard } = await storyboard({ readOnly: true });
	let resized = () => {};
	Object.assign(window, {
		ResizeObserver: class {
			constructor(callback: () => void) {
				resized = callback;
			}
			observe() {}
		},
	});
	const viewer = canvasView(store, { readOnly: true });
	document.body.replaceChildren(viewer);
	laidOut(viewer);
	resized();
	const fittedTransform = transform(viewer);

	dragBy(viewer.querySelector<HTMLElement>(".canvas-surface")!, 120, 40);
	const panned = transform(viewer);
	assert.notEqual(panned, fittedTransform);
	cardNode(viewer, duneCard.id).click();
	resized();
	assert.equal(transform(viewer), panned);
});

/** The pan/zoom the canvas shows now, read from its transform. */
function shownViewport(view: HTMLElement): { x: number; y: number; zoom: number } {
	const [x, y, zoom] = transform(view).match(/-?[\d.]+/g)!.map(Number);
	return { x: x!, y: y!, zoom: zoom! };
}

test("in the editor, 'Use this view' sets the frame of what's shown to what is seen: the step's, else the board's", async () => {
	const { store, view, boardId, one, pages } = await storyboard();
	laidOut(view);
	editFrames(view);
	const wide = store.addFrame(boardId, "Wide", { x: 0, y: 0, width: 480, height: 270 }, one.id)!;
	const board = () => store.data.boards.find((b) => b.id === boardId)!;
	const useView = () => view.querySelector<HTMLButtonElement>(".frame-from-view")!.click();
	const zoomOut = () => view.querySelector<HTMLButtonElement>(`.canvas-zoom button[title="${text.zoomOut}"]`)!.click();
	/** What is seen now, in a screen's shape. */
	const seen = () => frameInside(visibleRect(shownViewport(view), 800, 600));
	const boardFrame = board().viewFrame;

	zoomOut();
	const step = seen();
	useView();
	assert.deepEqual(board().frames[0], { id: wide.id, name: "Wide", ...step });
	assert.deepEqual(board().viewFrame, boardFrame, "the board's frame stays");

	// A step in the board's frame: the board's frame.
	pageButton(view, "Next step").click();
	assert.equal(pages()[1]!.frameId, null);
	zoomOut();
	const atStep = seen();
	useView();
	assert.deepEqual(board().viewFrame, atStep);

	// The whole board: the board's frame too.
	pickStory(view, "Whole board");
	zoomOut();
	const whole = seen();
	useView();
	assert.deepEqual(board().viewFrame, whole);
	assert.notDeepEqual(whole, atStep);
	assert.deepEqual(board().frames[0], { id: wide.id, name: "Wide", ...step }, "the step's frame stays");
});
