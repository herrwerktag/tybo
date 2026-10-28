import { freshDom } from "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasView, parseViewHash, viewHash } from "./canvas.js";
import { CLICK_TOLERANCE } from "./dom.js";
import { text } from "./i18n.js";
import { createStore, DATA_VERSION, frameInside, newReference, visibleRect, type Store } from "@tybo/core";
import { memoryDataPort } from "@tybo/core/testing";

/** A board with one card for Dune (with content) and one for Herbert. */
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
	return { store, view, boardId, card, dune };
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
	const view = canvasView(store, { readOnly: false });
	document.body.append(view);

	assert.equal(cardNode(view, missing.id).querySelector(".card-missing")?.textContent, text.missingRequired("Author"));
	assert.equal(cardNode(view, complete.id).querySelector(".card-missing"), null);

	dragBy(cardNode(view, missing.id).querySelector("header")!, 0, 0);
	assert.equal(details(view).querySelector(".details-props dd.missing")?.textContent, text.missingValue);
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

test("the viewer only looks: no remove buttons, and dragging doesn't move cards", async () => {
	const { store, view, card } = await setup({ readOnly: true });
	assert.equal(view.querySelector(".canvas-board .card-remove"), null);
	assert.equal(view.querySelector(".canvas-panel"), null);

	dragBy(cardNode(view, card.id).querySelector("header")!, 50, 30);
	assert.deepEqual([savedCard(store, card.id)?.x, savedCard(store, card.id)?.y], [100, 100]);
});

test("an addressed viewer shows the board its address names, and keeps the address up to date", async () => {
	const { store, boardId } = await setup({ readOnly: true });
	const other = store.addBoard("Other").id;
	assert.deepEqual(parseViewHash("#boards"), {});
	assert.equal(viewHash({ boardId: other }), `#view/${other}`);
	assert.deepEqual(parseViewHash(`#view/${other}`), { boardId: other });
	assert.deepEqual(parseViewHash(`#view/${other}/story/step`), { boardId: other }, "addresses of steps from before open their board");

	location.hash = `#view/${other}`;
	const viewer = canvasView(store, { readOnly: true, addressed: true });
	document.body.replaceChildren(viewer);
	assert.equal(viewer.querySelector(".board-switch .picker-name")?.textContent, "Other");

	viewer.querySelector<HTMLButtonElement>(".board-switch")!.click();
	[...viewer.querySelectorAll<HTMLButtonElement>(".board-dialog .picker-option")].find((b) => b.textContent === "Board 1")!.click();
	assert.equal(location.hash, `#view/${boardId}`);
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

test("the drawing tools are select, text box and group; a text box is drawn with its tool and selected", async () => {
	const { store, view } = await setup();
	assert.deepEqual(
		[...view.querySelectorAll<HTMLButtonElement>(".drawing-tools button:not(.tools-toggle)")].map((b) => b.ariaLabel),
		["Select", "Textbox", "Group"],
	);
	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
	press(view.querySelector<HTMLElement>(".canvas-surface")!, 10, 10, 200, 100);

	const [box] = store.data.boards[0]!.drawings;
	assert.deepEqual(box && [box.kind, "width" in box && box.width, "height" in box && box.height], ["textbox", 200, 100]);
	assert.equal(view.querySelectorAll(".drawings rect.drawing-shape").length, 1);
	assert.equal(view.querySelectorAll(".drawings .selection-handle").length, 4, "selected right away");
	assert.ok([...view.querySelectorAll(".drawing-style button")].some((b) => b.textContent === "L"), "with its text sizes");
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
	const box = store.addDrawing(boardId, { kind: "textbox", x: 120, y: 300, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
	store.addDrawing(boardId, { kind: "textbox", x: 900, y: 900, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
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
	const box = store.addDrawing(boardId, { kind: "textbox", x: 120, y: 300, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
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
	const reference = { typeIds: [person.id], multiple: false, required: false, arrow: "to" as const, lineLabel: "", inverseLabel: "wrote" };
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

test("selecting a card keeps the areas it lies in from fading, and only those", async () => {
	const { store, card } = await connectable();
	const boardId = store.data.boards[0]!.id;
	const around = store.addDrawing(boardId, { kind: "area", x: -48, y: -48, width: 600, height: 600, color: "#c4dafa", text: "Team", textSize: "m" });
	store.addDrawing(boardId, { kind: "area", x: 1200, y: 0, width: 240, height: 240, color: "#c4dafa", text: "", textSize: "m" });
	store.addDrawing(boardId, { kind: "textbox", x: 0, y: 0, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
	freshDom();
	const view = canvasView(store, { readOnly: false });
	document.body.append(view);
	const inFocus = () => [...view.querySelectorAll(".drawings g.drawing.in-chain")].map((g) => g.getAttribute("data-id"));

	cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.deepEqual(inFocus(), [around.id]);

	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.deepEqual(inFocus(), []);
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

	const again = canvasView(store, { readOnly: false });
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
	const viewer = canvasView(store, { readOnly: true });
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
