import { freshDom } from "../../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasView } from "./canvas.js";
import { CLICK_TOLERANCE } from "../../../shared/ui/index.js";
import { text } from "../texts.js";
import { text as dataText } from "../../data/texts.js";
import { createStore } from "../../../features.core.js";
import { DATA_VERSION } from "../../../shared/core/index.js";
import { frameInside, visibleRect } from "../core.js";
import { newReference } from "../../data/core.js";
import { memoryDataPort } from "../../../memory-port.js";
import { cardNode, details, dragBy, press, savedCard, selectedCards, setup, shiftClick } from "./test-canvas.js";


test("dragging a card's header moves it onto the grid and saves the position; it doesn't open the details", async () => {
	const { store, view, card } = await setup();
	dragBy(cardNode(view, card.id).querySelector("header")!, 50, 30);

	// 150, 130 snaps to the nearest grid point.
	assert.deepEqual([savedCard(store, card.id)?.x, savedCard(store, card.id)?.y], [144, 120]);
	assert.equal(cardNode(view, card.id).style.left, "144px");
	assert.equal(details(view).hidden, true);
});

test("a card and its details point out required references that are still empty", async () => {
	freshDom();
	const store = await createStore(memoryDataPort({ ws: { version: DATA_VERSION, types: [], entities: [], boards: [] } }).port, "ws");
	const person = store.addType("Person", [], "");
	const reference = { ...newReference([person.id]), required: true };
	const book = store.addType("Book", [{ name: "Author", kind: "reference", options: [], reference, cardDisplay: "list" }], "");
	const frank = store.addEntity(person.id, "Frank", "", {});
	const boardId = store.data.boards[0]!.id;
	const missing = store.addCard(boardId, store.addEntity(book.id, "Dune", "", {}).id, 100, 100);
	const authorId = book.properties[0]!.id;
	const complete = store.addCard(boardId, store.addEntity(book.id, "Emma", "", { [authorId]: frank.id }).id, 400, 100);
	const view = canvasView(store, { readOnly: false, layers: [] });
	document.body.append(view);

	assert.equal(cardNode(view, missing.id).querySelector(".card-missing")?.textContent, dataText.missingRequired("Author"));
	assert.equal(cardNode(view, complete.id).querySelector(".card-missing"), null);

	dragBy(cardNode(view, missing.id).querySelector("header")!, 0, 0);
	assert.equal(details(view).querySelector(".details-props dd.missing")?.textContent, dataText.missingValue);
	dragBy(cardNode(view, complete.id).querySelector("header")!, 0, 0);
	assert.equal(details(view).querySelector(".details-props dd.missing"), null);
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
	const editButton = () => [...details(view).querySelectorAll("button")].find((b) => b.textContent === dataText.edit)!;
	const form = () => details(view).querySelector<HTMLFormElement>("#entity-form")!;
	const nameInput = () => form().querySelector<HTMLInputElement>("input")!;
	dragBy(cardNode(view, card.id).querySelector("header")!, 0, 0);

	// The form is below the bar of the entity's type.
	editButton().click();
	assert.equal(details(view).querySelector(".card-type")?.textContent, "Book");

	// Cancel shows the details again, unchanged.
	nameInput().value = "Arrakis";
	[...form().querySelectorAll("button")].find((b) => b.textContent === dataText.cancel)!.click();
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
	assert.ok(![...details(view).querySelectorAll("button")].some((b) => b.textContent === dataText.edit));
});

/**
 * happy-dom has no layout: here a card's contents are `natural` wide on one line (by its name), and it's two grid steps
 * plus one per line tall, unless a height is set. Returns a function restoring happy-dom's own.
 */
function fakeCardLayout(natural: Record<string, number>): () => void {
	const proto = HTMLElement.prototype;
	const own = ["offsetWidth", "offsetHeight"].map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const);
	const naturalWidth = (node: HTMLElement) => natural[node.querySelector(".card-title")?.textContent ?? ""] ?? 0;
	const width = (node: HTMLElement) => (node.style.width === "max-content" ? naturalWidth(node) : parseFloat(node.style.width));
	Object.defineProperties(proto, {
		offsetWidth: {
			configurable: true,
			get(this: HTMLElement) {
				return this.classList.contains("canvas-card") ? width(this) : 0;
			},
		},
		offsetHeight: {
			configurable: true,
			get(this: HTMLElement) {
				if (!this.classList.contains("canvas-card")) return 0;
				return this.style.height ? parseFloat(this.style.height) : 48 + 24 * Math.ceil(naturalWidth(this) / width(this));
			},
		},
	});
	return () => {
		for (const [name, descriptor] of own) {
			if (descriptor) Object.defineProperty(proto, name, descriptor);
			else delete (proto as unknown as Record<string, unknown>)[name];
		}
	};
}

test("cards are sized to what they show: as narrow as they get without more lines, and saved outside the undo history", async () => {
	const restore = fakeCardLayout({ Dune: 600, Herbert: 100 });
	try {
		const { store, view, card } = await setup();
		const herbert = store.data.boards[0]!.cards.find((c) => c.id !== card.id)!;
		// Dune takes two lines at the widest (384); 312 is the narrowest width on the grid still taking two.
		assert.deepEqual([savedCard(store, card.id)?.width, savedCard(store, card.id)?.height], [312, 96]);
		assert.deepEqual([cardNode(view, card.id).style.width, cardNode(view, card.id).style.height], ["312px", "96px"]);
		// Herbert fits on one line, but a card is never narrower than the minimum.
		assert.deepEqual([savedCard(store, herbert.id)?.width, savedCard(store, herbert.id)?.height], [168, 72]);
		assert.equal(cardNode(view, card.id).querySelector(".card-resize"), null, "nothing to resize by hand");
		store.undo(); // the measuring isn't undone: adding Herbert's card is
		assert.equal(store.data.boards[0]!.cards.length, 1);
	} finally {
		restore();
	}
});

test("a long text makes a card as tall as it needs at its widest; the viewer measures but saves nothing", async () => {
	const restore = fakeCardLayout({ Dune: 10000, Herbert: 100 });
	try {
		const { store, view, card } = await setup({ readOnly: true });
		assert.deepEqual([cardNode(view, card.id).style.width, cardNode(view, card.id).style.height], ["384px", "696px"]);
		assert.deepEqual([savedCard(store, card.id)?.width, savedCard(store, card.id)?.height], [240, 168]);
	} finally {
		restore();
	}
});

test("× takes the card off the board; the entity stays", async () => {
	const { store, view, card, dune } = await setup();
	cardNode(view, card.id).querySelector<HTMLButtonElement>(".card-remove")!.click();

	assert.equal(savedCard(store, card.id), undefined);
	assert.equal(view.querySelectorAll(".canvas-board .canvas-card").length, 1);
	assert.ok(store.data.entities.some((e) => e.id === dune.id));
});

test("Delete takes the selected card off the board, like ×; the entity stays", async () => {
	const { store, view, card, dune } = await setup();
	const press = (key: string, target: EventTarget = document.body) =>
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	press("Delete");
	assert.ok(savedCard(store, card.id), "nothing selected, nothing removed");

	cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	detailsButton(view, dataText.edit)!.click();
	press("Backspace", details(view).querySelector("input")!);
	assert.ok(savedCard(store, card.id), "typing in the form removes nothing");

	press("Backspace");
	assert.equal(savedCard(store, card.id), undefined);
	assert.equal(details(view).hidden, false, "its entity's details stay");
	assert.ok(store.data.entities.some((e) => e.id === dune.id));
});

test("the viewer only looks: no remove buttons, and dragging doesn't move cards", async () => {
	const { store, view, card } = await setup({ readOnly: true });
	assert.equal(view.querySelector(".canvas-board .card-remove"), null);
	assert.equal(view.querySelector(".canvas-panel"), null);

	dragBy(cardNode(view, card.id).querySelector("header")!, 50, 30);
	assert.deepEqual([savedCard(store, card.id)?.x, savedCard(store, card.id)?.y], [100, 100]);
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

test("hovering or focusing an entity in the side panel shows its card; dragging it or leaving hides that again", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { view } = await setup();
	const item = [...view.querySelectorAll<HTMLElement>(".panel-item")].find((i) => i.textContent?.startsWith("Dune"))!;
	const preview = view.querySelector<HTMLElement>(".card-preview")!;
	assert.equal(item.tabIndex, 0, "it can be focused");
	assert.equal(item.getAttribute("aria-describedby"), preview.id);

	item.dispatchEvent(new PointerEvent("pointerenter"));
	assert.equal(preview.hidden, true, "not at once");
	t.mock.timers.tick(250);
	assert.equal(preview.hidden, false);
	assert.equal(preview.querySelector(".card-title")?.textContent, "Dune");
	assert.equal(preview.querySelector(".card-content")?.textContent, "A desert planet.");
	item.dispatchEvent(new Event("dragstart"));
	assert.equal(preview.hidden, true);

	item.dispatchEvent(new Event("focus"));
	assert.equal(preview.hidden, false);
	item.dispatchEvent(new PointerEvent("pointerleave"));
	assert.equal(preview.hidden, true);
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
	const rename = () => dialog.querySelector<HTMLButtonElement>(`li button[title="${text.renameBoard}"]`)!.click();
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
	dialog.querySelector<HTMLButtonElement>(`li button[title="${text.deleteBoard}"]`)!.click();
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
	const reference = { typeIds: [person.id], multiple: false, required: false, arrow: "to" as const, lineLabel: "", inverseLabel: "wrote" };
	const book = store.addType("Book", [{ name: "author", kind: "reference", options: [], reference, cardDisplay: "line" }], "");
	const dune = store.addEntity(book.id, "Dune", "", {});
	const card = store.addCard(store.data.boards[0]!.id, dune.id, 0, 0);
	const view = canvasView(store, { readOnly: false, layers: [] });
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
		const view = canvasView(store, { readOnly: false, layers: [] });
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
	const view = canvasView(store, { readOnly: false, layers: [] });
	document.body.append(view);
	const inChain = () =>
		[card, frankCard, sequelCard, otherCard].filter((c) => cardNode(view, c.id).classList.contains("in-chain")).map((c) => c.id);
	const board = view.querySelector(".canvas-board")!;

	// Dune → Frank ← Children of Dune: all three stand out from Dune, not Jane.
	cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.ok(board.classList.contains("focusing"));
	assert.deepEqual(inChain(), [card.id, frankCard.id, sequelCard.id]);
	assert.equal(view.querySelectorAll(".connector.in-chain").length, 2);
	// Only Dune's own line (and its label) stands out further, drawn in its gradient.
	const direct = () => [...view.querySelectorAll<SVGElement>(".connector.direct")].map((g) => g.dataset.from);
	assert.deepEqual(direct(), [card.id]);
	assert.equal(view.querySelectorAll(".connector-label.direct").length, 1);
	const gradient = view.querySelector<SVGElement>(".connector.direct")!.getAttribute("style")!.match(/url\(#(.+)\)/)![1]!;
	assert.equal(view.querySelector(`.connectors linearGradient[id="${gradient}"]`)?.querySelectorAll("stop").length, 2);

	// Frank's lines are both its own.
	cardNode(view, frankCard.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.deepEqual(direct().sort(), [card.id, sequelCard.id].sort());

	cardNode(view, otherCard.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.deepEqual(inChain(), [otherCard.id]);
	assert.equal(view.querySelectorAll(".connector.in-chain").length, 0);

	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.ok(!board.classList.contains("focusing"));
	assert.equal(view.querySelectorAll(".direct").length, 0);
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

test("Lay out puts the cards of the references the card lists around it, in one undo step; then it's disabled", async () => {
	const { store, person, author, dune, card } = await connectable();
	const frank = store.addEntity(person.id, "Frank", "", {});
	store.updateEntity(dune.id, "Dune", "", { [author.id]: frank.id });
	freshDom();
	const view = canvasView(store, { readOnly: false, layers: [] });
	document.body.append(view);
	cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	const button = () => detailsButton(view, text.layOutReferences)!;
	assert.equal(button().previousElementSibling?.textContent, text.connect, "next to Connect");
	assert.equal(button().title, text.layOutReferencesHint);

	button().click();
	const placed = store.data.boards[0]!.cards.find((c) => c.entityId === frank.id)!;
	assert.deepEqual([placed.x, placed.y], [288, 0], "right of Dune's card, as Dune references Frank");
	assert.ok(cardNode(view, placed.id).classList.contains("appear"));
	assert.equal(cardNode(view, card.id).querySelector(".card-props"), null, "the reference is a line now, not listed");
	assert.ok(view.querySelector(".connectors path, .connectors line"));
	assert.ok(cardNode(view, card.id).classList.contains("selected"), "the selection stays");
	assert.equal(button().disabled, true, "nothing left to lay out");

	store.undo();
	assert.equal(store.data.boards[0]!.cards.length, 1);
});

test("Delete in the details deletes the entity after asking, with its cards on all boards, in one undo step", async () => {
	const { store, person, author, dune, card } = await connectable();
	const frank = store.addEntity(person.id, "Frank", "", {});
	store.updateEntity(dune.id, "Dune", "", { [author.id]: frank.id });
	const frankCard = store.addCard(store.data.boards[0]!.id, frank.id, 400, 0);
	const other = store.addBoard("Other");
	store.addCard(other.id, frank.id, 0, 0);
	freshDom();
	const view = canvasView(store, { readOnly: false, layers: [] });
	document.body.append(view);
	cardNode(view, frankCard.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	const button = detailsButton(view, text.deleteEntity)!;
	assert.ok(button.classList.contains("entity-delete"), "set apart in red");
	assert.equal(button.previousElementSibling?.textContent, text.layOutReferences, "after Edit, Connect and Lay out");

	const asked: string[] = [];
	let answer = false;
	Object.assign(globalThis, { confirm: (message: string) => (asked.push(message), answer) });
	button.click();
	assert.deepEqual(asked, [dataText.confirmDeleteEntity("Frank", 1) + text.otherBoardsWithCards(1)]);
	assert.ok(store.data.entities.some((e) => e.id === frank.id), "cancelled: nothing changes");
	assert.equal(details(view).hidden, false);

	answer = true;
	button.click();
	assert.ok(!store.data.entities.some((e) => e.id === frank.id));
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.values[author.id], null, "the reference to it is gone");
	assert.deepEqual(store.data.boards.map((b) => b.cards.map((c) => c.id)), [[card.id], []]);
	assert.equal(details(view).hidden, true);
	assert.equal(cardNode(view, frankCard.id), null);

	store.undo();
	assert.ok(store.data.entities.some((e) => e.id === frank.id));
	assert.deepEqual(store.data.boards.map((b) => b.cards.length), [2, 1]);
});

test("the viewer's details have no Connect button", async () => {
	const { view, card } = await setup({ readOnly: true });
	cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.equal(detailsButton(view, "Connect"), undefined);
	assert.equal(detailsButton(view, text.deleteEntity), undefined);
});

/** Gives the canvas a size (happy-dom lays nothing out) and makes the pan/zoom move at once (reduced motion). */
function laidOut(view: HTMLElement, width = 800, height = 600): void {
	const surface = view.querySelector<HTMLElement>(".canvas-surface")!;
	Object.defineProperties(surface, { clientWidth: { value: width }, clientHeight: { value: height } });
	Object.assign(window, { matchMedia: (query: string) => ({ matches: query.includes("reduced-motion") }) });
}

const transform = (view: HTMLElement) => view.querySelector<HTMLElement>(".canvas-board")!.style.transform;

/** Turns on editing the frame in the editor, as its toggle does: only then is it shown, with its controls. */
function editFrames(view: HTMLElement): void {
	const toggle = view.querySelector<HTMLButtonElement>(".frames-toggle")!;
	if (toggle.ariaPressed !== "true") toggle.click();
}

test("in the editor, the frame is only shown, with its controls, while editing it; that is remembered", async () => {
	const { store, view } = await setup();
	const toggle = () => view.querySelector<HTMLButtonElement>(".frames-toggle")!;
	assert.equal(toggle().ariaPressed, "false");
	assert.equal(view.querySelector(".view-frame, .frame-from-view"), null);

	toggle().click();
	assert.equal(toggle().ariaPressed, "true");
	assert.equal(toggle().textContent, `▭${text.doneEditingFrames}`);
	assert.equal(view.querySelector(".view-frame .view-frame-label")?.textContent, "Board frame");
	assert.ok(view.querySelector(".frame-from-view"));

	const again = canvasView(store, { readOnly: false, layers: [] });
	assert.ok(again.querySelector(".view-frame"), "still editing the frame when the canvas is shown again");

	toggle().click();
	assert.equal(view.querySelector(".view-frame, .frame-from-view"), null);
});

test("in the editor, the board's frame is moved by its name and resized at its corner, on the grid", async () => {
	const { store, view } = await setup();
	editFrames(view);
	const board = () => store.data.boards[0]!;
	const frame = () => view.querySelector<HTMLElement>(".view-frame")!;

	dragBy(frame().querySelector<HTMLElement>(".view-frame-label")!, -50, 0);
	dragBy(frame().querySelector<HTMLElement>(".card-resize")!, 100, 0);
	assert.deepEqual(board().viewFrame, { x: -48, y: 0, width: 1392, height: 783 }, "the width on the grid, the height following");
	dragBy(frame().querySelector<HTMLElement>(".card-resize")!, 0, 54);
	assert.deepEqual([board().viewFrame.width, board().viewFrame.height], [1488, 837], "dragged down: as much wider, in a screen's shape");
	dragBy(frame().querySelector<HTMLElement>(".card-resize")!, -2000, 20);
	assert.deepEqual([board().viewFrame.width, board().viewFrame.height], [192, 108], "never below the minimum");
	assert.equal(frame().style.left, "-48px");
});

test("the viewer fits the board's frame into the screen", async () => {
	const { store, view } = await setup({ readOnly: true });
	laidOut(view);
	const reset = () => [...view.querySelectorAll<HTMLButtonElement>(".canvas-zoom button")].find((b) => b.textContent === text.resetView)!.click();
	store.setViewFrame(store.data.boards[0]!.id, { x: 0, y: 0, width: 400, height: 225 });

	reset();
	assert.equal(transform(view), "translate(0px, 75px) scale(2)"); // 400 × 225 fills the width
	assert.equal(view.querySelector(".view-frame, .frames-toggle"), null, "the viewer shows no frame");
});

test("the viewer keeps where it was panned to when the canvas changes size, e.g. as a card's details open", async () => {
	const { store, card } = await setup({ readOnly: true });
	let resized = () => {};
	Object.assign(window, {
		ResizeObserver: class {
			constructor(callback: () => void) {
				resized = callback;
			}
			observe() {}
		},
	});
	const viewer = canvasView(store, { readOnly: true, layers: [] });
	document.body.replaceChildren(viewer);
	laidOut(viewer);
	resized();
	const fittedTransform = transform(viewer);

	dragBy(viewer.querySelector<HTMLElement>(".canvas-surface")!, 120, 40);
	const panned = transform(viewer);
	assert.notEqual(panned, fittedTransform);
	cardNode(viewer, card.id).click();
	resized();
	assert.equal(transform(viewer), panned);
});

/** The pan/zoom the canvas shows now, read from its transform. */
function shownViewport(view: HTMLElement): { x: number; y: number; zoom: number } {
	const [x, y, zoom] = transform(view).match(/-?[\d.]+/g)!.map(Number);
	return { x: x!, y: y!, zoom: zoom! };
}

test("in the editor, 'Use this view' sets the board's frame to what is seen", async () => {
	const { store, view } = await setup();
	laidOut(view);
	editFrames(view);
	const zoomOut = () => view.querySelector<HTMLButtonElement>(`.canvas-zoom button[title="${text.zoomOut}"]`)!.click();
	/** What is seen now, in a screen's shape. */
	const seen = () => frameInside(visibleRect(shownViewport(view), 800, 600));

	zoomOut();
	const wide = seen();
	view.querySelector<HTMLButtonElement>(".frame-from-view")!.click();
	assert.deepEqual(store.data.boards[0]!.viewFrame, wide);
	// What is seen, in a screen's shape: as wide as the 800 × 600 canvas, centered top to bottom.
	assert.equal(wide.height, wide.width / (16 / 9));
});
