import "../../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { text } from "../texts.js";
import { text as dataText } from "../../data/texts.js";
import { cardNode, details, savedCard, selectedCards, setup } from "./test-canvas.js";

/** What a finger does on `target`: put down, moved or lifted at (x, y). */
function finger(target: Element, type: "down" | "move" | "up", id: number, x: number, y: number): void {
	target.dispatchEvent(new PointerEvent(`pointer${type}`, { bubbles: true, cancelable: true, button: 0, pointerId: id, pointerType: "touch", clientX: x, clientY: y }));
}

/** One finger put on `target`, moved by (dx, dy) and lifted. */
function swipe(target: Element, dx: number, dy: number): void {
	finger(target, "down", 1, 50, 50);
	finger(target, "move", 1, 50 + dx, 50 + dy);
	finger(target, "up", 1, 50 + dx, 50 + dy);
}

/** A tap as fingers do it: not quite still. */
const tap = (target: Element) => swipe(target, 4, 3);

/** Two fingers put on `target` 100 px apart, then `apart` px apart, and lifted. */
function pinch(target: Element, apart: number): void {
	finger(target, "down", 1, 100, 100);
	finger(target, "down", 2, 200, 100);
	finger(target, "move", 2, 100 + apart, 100);
	finger(target, "up", 2, 100 + apart, 100);
	finger(target, "up", 1, 100, 100);
}

/** The screen as the canvas asks about it: narrow like a phone's or not, and without animations. */
function screen({ narrow }: { narrow: boolean }): void {
	Object.assign(window, { matchMedia: (query: string) => ({ matches: query.includes("reduced-motion") || (narrow && query.includes("max-width")) }) });
}

const surfaceOf = (view: HTMLElement) => view.querySelector<HTMLElement>(".canvas-surface")!;
const transform = (view: HTMLElement) => view.querySelector<HTMLElement>(".canvas-board")!.style.transform;
const zoomLabel = (view: HTMLElement) => view.querySelector(".zoom-label")?.textContent;
const touchButton = (view: HTMLElement, label: string) => [...view.querySelectorAll<HTMLButtonElement>(".canvas-touch button")].find((b) => b.textContent === label)!;
const places = (cards: ({ x: number; y: number } | undefined)[]) => cards.map((c) => [c?.x, c?.y]);
/** Until the pan/zoom would have been saved. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 300));

test("one finger pans the board, from the background and from a card; two fingers zoom it onto a 10% step between 20% and 200%", async () => {
	const { store, view, card } = await setup();
	screen({ narrow: false });
	const surface = surfaceOf(view);

	swipe(surface, 40, -20);
	assert.equal(transform(view), "translate(40px, -20px) scale(1)");
	swipe(cardNode(view, card.id).querySelector("header")!, 10, 30);
	assert.equal(transform(view), "translate(50px, 10px) scale(1)", "a finger on a card pans too");

	pinch(surface, 157);
	assert.equal(zoomLabel(view), "160%", "157% settles on the nearest step");
	pinch(cardNode(view, card.id), 900);
	assert.equal(zoomLabel(view), "200%");
	pinch(surface, 1);
	assert.equal(zoomLabel(view), "20%");

	assert.deepEqual(places([savedCard(store, card.id)]), [[100, 100]], "no card moved");
	assert.deepEqual(selectedCards(view), [], "nor was one selected");
	await settled();
	assert.equal(store.data.boards[0]!.viewport.zoom, 0.2, "the editor keeps the pan/zoom");
});

test("a tap on a card, not quite still, selects it and shows its details; the card stays where it is", async () => {
	const { store, view, card } = await setup();
	const before = transform(view);

	tap(cardNode(view, card.id).querySelector("header")!);
	assert.deepEqual(selectedCards(view), [card.id]);
	assert.equal(details(view).hidden, false);
	assert.equal(details(view).querySelector(".details-title")?.textContent, "Dune");
	assert.deepEqual(places([savedCard(store, card.id)]), [[100, 100]]);
	assert.equal(transform(view), before, "nor did the board move");

	tap(surfaceOf(view));
	assert.deepEqual(selectedCards(view), [], "a tap on the background selects nothing");
});

test("a finger moves a selected card only once Move is on: onto the grid, in one undo step", async () => {
	const { store, view, card } = await setup();
	const move = touchButton(view, text.moveCards);
	assert.equal(move.disabled, true, "nothing to move yet");

	tap(cardNode(view, card.id));
	swipe(cardNode(view, card.id).querySelector("header")!, 50, 30);
	assert.deepEqual(places([savedCard(store, card.id)]), [[100, 100]], "without Move, the finger pans");

	move.click();
	assert.equal(move.ariaPressed, "true");
	swipe(cardNode(view, card.id), 50, 30);
	assert.deepEqual(places([savedCard(store, card.id)]), [[148, 124]]);
	assert.deepEqual(selectedCards(view), [card.id], "still selected, to move it again");
	swipe(cardNode(view, card.id), 24, 0);
	assert.deepEqual(places([savedCard(store, card.id)]), [[172, 124]]);
	store.undo();
	assert.deepEqual(places([savedCard(store, card.id)]), [[148, 124]], "each move is one step");

	const other = store.data.boards[0]!.cards.find((c) => c.id !== card.id)!;
	const before = transform(view);
	swipe(cardNode(view, other.id), 50, 30);
	assert.deepEqual(places([savedCard(store, other.id)]), [[400, 100]], "a card that isn't selected doesn't move");
	assert.notEqual(transform(view), before, "the finger pans from it");

	tap(surfaceOf(view));
	assert.equal(move.ariaPressed, "false", "with nothing selected, Move is off again");
	assert.equal(move.disabled, true);
});

test("Select takes cards tapped one after the other; with Move, a finger moves them together in one undo step", async () => {
	const { store, view, card } = await setup();
	const other = store.data.boards[0]!.cards.find((c) => c.id !== card.id)!;
	const select = touchButton(view, text.selectCards);

	select.click();
	tap(cardNode(view, card.id));
	assert.deepEqual(selectedCards(view), [card.id]);
	assert.equal(details(view).hidden, true, "no details while selecting");
	tap(cardNode(view, other.id));
	assert.deepEqual(selectedCards(view), [card.id, other.id]);
	tap(surfaceOf(view));
	assert.deepEqual(selectedCards(view), [card.id, other.id], "a tap beside the cards keeps them");
	tap(cardNode(view, other.id));
	assert.deepEqual(selectedCards(view), [card.id], "a second tap takes a card out");
	tap(cardNode(view, other.id));

	touchButton(view, text.moveCards).click();
	assert.equal(select.ariaPressed, "false", "moving ends selecting");
	swipe(cardNode(view, other.id), 50, 30);
	assert.deepEqual(places([savedCard(store, card.id), savedCard(store, other.id)]), [[148, 124], [448, 124]], "as far apart as before");
	store.undo();
	assert.deepEqual(places([savedCard(store, card.id), savedCard(store, other.id)]), [[100, 100], [400, 100]]);
});

test("on a narrow screen, closing the details keeps the card selected and the board where it was; a tap shows them again", async () => {
	const { view, card } = await setup();
	screen({ narrow: true });
	swipe(surfaceOf(view), 40, -20);
	const before = transform(view);

	tap(cardNode(view, card.id));
	assert.equal(details(view).hidden, false);
	details(view).querySelector<HTMLButtonElement>(".card-bar .card-remove")!.click();
	assert.equal(details(view).hidden, true);
	assert.deepEqual(selectedCards(view), [card.id]);
	assert.equal(transform(view), before);

	tap(cardNode(view, card.id));
	assert.equal(details(view).hidden, false);
	touchButton(view, text.moveCards).click();
	assert.equal(details(view).hidden, true, "the details make room for moving the card");
	assert.deepEqual(selectedCards(view), [card.id]);
});

test("on a wide screen, closing the details still selects nothing", async () => {
	const { view, card } = await setup();
	screen({ narrow: false });
	tap(cardNode(view, card.id));
	details(view).querySelector<HTMLButtonElement>(".card-bar .card-remove")!.click();
	assert.deepEqual(selectedCards(view), []);
});

test("the viewer fits all of a frame too large for a small screen, has no tools for fingers, and saves nothing they do", async () => {
	const { store, view, card } = await setup({ readOnly: true });
	screen({ narrow: true });
	const surface = surfaceOf(view);
	Object.defineProperties(surface, { clientWidth: { value: 390 }, clientHeight: { value: 700 } });
	store.setViewFrame(store.data.boards[0]!.id, { x: 0, y: 0, width: 3900, height: 2193.75 });
	const saved = JSON.stringify([store.data, store.history]);
	[...view.querySelectorAll<HTMLButtonElement>(".canvas-zoom button")].find((b) => b.textContent === text.resetView)!.click();
	assert.equal(zoomLabel(view), "10%", "below the smallest zoom, so the whole frame is seen");
	assert.equal(view.querySelector(".canvas-touch, .card-remove, .canvas-panel"), null);

	swipe(surface, 40, -20);
	assert.match(transform(view), /scale\(0\.1\)$/);
	pinch(surface, 300);
	assert.equal(zoomLabel(view), "30%");
	pinch(surface, 1);
	assert.equal(zoomLabel(view), "10%", "back out as far as the frame fits");
	swipe(cardNode(view, card.id).querySelector("header")!, 50, 30);
	tap(cardNode(view, card.id));
	assert.deepEqual(selectedCards(view), [card.id], "a tap shows a card's details");

	await settled();
	assert.equal(JSON.stringify([store.data, store.history]), saved, "neither the board nor what can be undone changed");
});

test("an open field has Save and Cancel for fingers: they do what Enter and Escape do, one field in one step", async () => {
	const { store, view, card, dune } = await setup();
	const name = () => details(view).querySelector<HTMLElement>(".details-title")!;
	const button = (label: string) => [...name().querySelectorAll<HTMLButtonElement>(".field-editor-actions button")].find((b) => b.textContent === label)!;
	const saved = () => store.data.entities.find((e) => e.id === dune.id)?.name;
	tap(cardNode(view, card.id));

	name().querySelector<HTMLElement>(".editable")!.click();
	name().querySelector<HTMLInputElement>("form input")!.value = "Arrakis";
	button(dataText.cancelField).click();
	assert.equal(name().textContent, "Dune", "Cancel gives the value back");
	assert.equal(saved(), "Dune");

	name().querySelector<HTMLElement>(".editable")!.click();
	name().querySelector<HTMLInputElement>("form input")!.value = "Arrakis";
	button(dataText.saveField).click();
	assert.equal(name().textContent, "Arrakis");
	assert.equal(saved(), "Arrakis");
	store.undo();
	assert.equal(saved(), "Dune");
});
