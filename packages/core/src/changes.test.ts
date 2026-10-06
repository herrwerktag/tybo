import assert from "node:assert/strict";
import { test } from "node:test";
import { changesBetween, jsonEqual, type Change } from "./changes.js";
import type { AppData, CanvasCard, Drawing, Entity, EntityType } from "./model.js";

/** A state to build stands from: one type with a text property, two entities, one board with two cards and
 * one drawing — enough of every unit to change, add and delete one each without touching another. */
function state(): AppData {
	const type: EntityType = {
		id: "type-person",
		name: "Person",
		properties: [{ id: "p-note", name: "Notiz", kind: "text", options: [], reference: null, cardDisplay: "list" }],
		contentTemplate: "",
		color: "#c4dafa",
	};
	const entity = (id: string, note: string | null): Entity => ({
		id,
		typeId: type.id,
		name: id,
		content: "",
		description: "",
		values: note === null ? {} : { "p-note": note },
	});
	const card = (id: string, entityId: string, x: number, y: number): CanvasCard => ({
		id,
		entityId,
		x,
		y,
		width: 240,
		height: 160,
	});
	const drawing: Drawing = { id: "draw-line", kind: "line", points: [{ x: 0, y: 0 }, { x: 9, y: 9 }], color: "#4a4a4a" };
	return {
		types: [type],
		entities: [entity("ent-ada", "mit Ruhe"), entity("ent-bob", null)],
		boards: [
			{
				id: "board-1",
				name: "Übersicht",
				kind: "whiteboard",
				cards: [card("card-ada", "ent-ada", 10, 20), card("card-bob", "ent-bob", 330, 40)],
				viewport: { x: 0, y: 0, zoom: 1 },
				drawings: [drawing],
				pages: [],
			},
		],
	};
}

/** The units of a change set, one line per kind with its ids (in input order). */
const outline = (changes: Change[]) => changes.map((c) => `${c.kind}:${c.id}${"boardId" in c ? `:${c.boardId}` : ""}`);

test("jsonEqual: equal in value whatever the records' key order is, different in anything else it might be", () => {
	assert.equal(jsonEqual({ a: 1, b: { c: [2, 3] } }, { b: { c: [2, 3] }, a: 1 }), true);
	assert.equal(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1, c: null }), false); // an extra key is a difference
	assert.equal(jsonEqual({ a: null }, { a: null, b: undefined }), false); // even a missing undefined one
	assert.equal(jsonEqual([1, 2, 3], [3, 2, 1]), false); // lists keep their order
	assert.equal(jsonEqual(0.1 + 0.2, 0.3), false); // numbers are compared as they are
	assert.equal(jsonEqual(null, null), true);
	assert.equal(jsonEqual("1", 1), false);
	assert.equal(jsonEqual(null, {}), false);
});

test("the same state on both sides is no change at all", () => {
	assert.deepEqual(changesBetween(state(), state()), []);
});

test("moving a card and changing an entity touch two units, never the same one — not the board either", () => {
	const before = state();
	const after = state();
	// Someone moves a card …
	const moved = after.boards[0]!.cards[0]!;
	assert.equal(moved.id, "card-ada");
	after.boards[0]!.cards[0] = { ...moved, x: 60, y: -5 };
	// … while someone else changes an entity's value.
	const ada = after.entities.find((e) => e.id === "ent-ada")!;
	ada.values = { "p-note": "im Eiltempo" };

	const changes = changesBetween(before, after);
	assert.deepEqual(outline(changes), ["entity:ent-ada", "card:card-ada:board-1"]);
	assert.equal(changes.some((c) => c.kind === "board"), false, "the board itself (name, viewport) didn't change");
});

test("a card brought to the front is a change even when nothing else about it moved", () => {
	const before = state();
	const after = state();
	const board = after.boards[0]!;
	board.cards = [...board.cards.slice(1), board.cards[0]!];
	const changes = changesBetween(before, after);
	assert.deepEqual(outline(changes), ["card:card-ada:board-1", "card:card-bob:board-1"]);
	const [ada, bob] = changes as [Extract<Change, { kind: "card" }>, Extract<Change, { kind: "card" }>];
	assert.deepEqual([ada.before!.position, ada.after!.position], [0, 1]);
	assert.deepEqual([bob.before!.position, bob.after!.position], [1, 0]);
	assert.deepEqual(ada.before!.value, ada.after!.value, "its content didn't change — only its place");
});

test("categories compare by id, never by the position they happen to sit at in the array", () => {
	const before = state();
	const after = state();
	// The entities swapp places (as a delete in between would move them up): same content, other places.
	after.entities = [...after.entities.slice(1), after.entities[0]!];
	after.types = [...after.types]; // no change in the types
	const changes = changesBetween(before, after);
	assert.deepEqual(outline(changes), ["entity:ent-ada", "entity:ent-bob"]);
	assert.equal(changes[0]!.before!.position, 0);
	assert.equal(changes[0]!.after!.position, 1);
});

test("a new unit has no before; a deleted one has no after; both say what was there", () => {
	const before = state();
	const after = state();
	const added: Entity = {
		id: "ent-chef",
		typeId: "type-person",
		name: "Chef",
		content: "",
		description: "",
		values: { "p-note": "kocht" },
	};
	after.entities = [...after.entities, added];
	const drawn = after.boards[0]!.drawings[0]!;
	assert.equal(drawn.id, "draw-line");
	after.boards[0]!.drawings = [];

	const changes = changesBetween(before, after);
	assert.deepEqual(outline(changes), ["entity:ent-chef", "drawing:draw-line:board-1"]);
	const [entityChange, drawingChange] = changes as [Extract<Change, { kind: "entity" }>, Extract<Change, { kind: "drawing" }>];
	assert.equal(entityChange.before, null);
	assert.deepEqual(entityChange.after!.value, added);
	assert.equal(entityChange.after!.position, 2);
	assert.equal(drawingChange.after, null);
	assert.deepEqual(drawingChange.before!.value, before.boards[0]!.drawings[0], "what was deleted is described, so the writer can compare");
});

test("a type is one unit with its properties; a board is one without its cards and drawings", () => {
	const before = state();
	const after = state();
	const type = after.types[0]!;
	type.properties = [
		...type.properties,
		{ id: "p-status", name: "Status", kind: "text", options: [], reference: null, cardDisplay: "list" },
	];
	after.boards[0]!.viewport = { x: 12, y: 34, zoom: 0.5 };
	// Cards and drawings changing is not the board changing:
	after.boards[0]!.name = "Unbenannt";

	const changes = changesBetween(before, after);
	assert.deepEqual(outline(changes), ["type:type-person", "board:board-1"]);
	const [typeChange, boardChange] = changes as [Extract<Change, { kind: "type" }>, Extract<Change, { kind: "board" }>];
	assert.deepEqual(typeChange.after!.value.properties.map((p) => p.id), ["p-note", "p-status"]);
	assert.deepEqual(boardChange.after!.value, { id: "board-1", name: "Unbenannt", kind: "whiteboard", viewport: { x: 12, y: 34, zoom: 0.5 }, pages: [] });
	assert.deepEqual(boardChange.before!.value, { id: "board-1", name: "Übersicht", kind: "whiteboard", viewport: { x: 0, y: 0, zoom: 1 }, pages: [] });
});

test("a storyboard page shown or hidden is a change of the board alone, never of its cards", () => {
	const before = state();
	const page = {
		id: "page-1",
		name: "Step 1",
		description: "",
		descriptionPosition: { x: 72, y: 16 },
		viewport: { x: 0, y: 0, zoom: 1 },
		cardIds: ["card-ada"],
		drawingIds: [],
	};
	before.boards[0] = { ...before.boards[0]!, kind: "storyboard", pages: [page] };
	const after = structuredClone(before);
	after.boards[0]!.pages[0]!.cardIds.push("card-bob");

	assert.deepEqual(outline(changesBetween(before, after)), ["board:board-1"]);
});
