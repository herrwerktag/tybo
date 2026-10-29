import { freshDom } from "../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { canvasView } from "../boards/ui.js";
import { cardNode, details, dragBy, press, savedCard, selectedCards, setup } from "../boards/ui/test-canvas.js";
import { addDrawing } from "./core.js";
import { DRAWING_LAYER } from "./ui.js";

/** The canvas with the drawings on it, as in the app. */
const layers = [DRAWING_LAYER];

test("the drawing tools are select, text box and group; a text box is drawn with its tool and selected", async () => {
	const { store, view } = await setup({ layers });
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

test("the drawing tools fold down to the current tool, and stay folded", async () => {
	const { store, view } = await setup({ layers });
	const tools = view.querySelector<HTMLElement>(".drawing-tools")!;
	tools.querySelector<HTMLButtonElement>(".tools-toggle")!.click();
	assert.ok(tools.classList.contains("collapsed"));
	const again = canvasView(store, { readOnly: false, layers });
	assert.ok(again.querySelector(".drawing-tools")!.classList.contains("collapsed"));
});

test("dragging on the empty board frames cards and drawings to select them; a click there clears the selection", async () => {
	const { store, view, card } = await setup({ layers });
	const boardId = store.data.boards[0]!.id;
	const box = addDrawing(store, boardId, { kind: "textbox", x: 120, y: 300, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
	addDrawing(store, boardId, { kind: "textbox", x: 900, y: 900, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
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
	const { store, view } = await setup({ layers });
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
	const { store, view: first, card } = await setup({ layers });
	const boardId = store.data.boards[0]!.id;
	const other = store.data.boards[0]!.cards.find((c) => c.id !== card.id)!; // Herbert's card at (400, 100): outside
	const box = addDrawing(store, boardId, { kind: "textbox", x: 120, y: 300, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
	// Made last, the group is still drawn below the box.
	const area = addDrawing(store, boardId, { kind: "area", x: 72, y: 72, width: 312, height: 312, color: "#c4dafa", text: "Team", textSize: "m" });
	first.remove();
	const view = canvasView(store, { readOnly: false, layers });
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

test("selecting a card keeps the areas it lies in from fading, and only those", async () => {
	const { store, card, boardId } = await setup({ layers });
	const around = addDrawing(store, boardId, { kind: "area", x: -48, y: -48, width: 600, height: 600, color: "#c4dafa", text: "Team", textSize: "m" });
	addDrawing(store, boardId, { kind: "area", x: 1200, y: 0, width: 240, height: 240, color: "#c4dafa", text: "", textSize: "m" });
	addDrawing(store, boardId, { kind: "textbox", x: 0, y: 0, width: 48, height: 48, color: "#4a4a4a", text: "", textSize: "m" });
	freshDom();
	const view = canvasView(store, { readOnly: false, layers });
	document.body.append(view);
	const inFocus = () => [...view.querySelectorAll(".drawings g.drawing.in-chain")].map((g) => g.getAttribute("data-id"));

	cardNode(view, card.id).querySelector("header")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.deepEqual(inFocus(), [around.id]);

	document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.deepEqual(inFocus(), []);
});
