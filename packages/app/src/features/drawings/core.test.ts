import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStorage, open, firstBoard } from "../../test-store.js";
import { addDrawing, removeDrawing, replaceDrawing } from "./core.js";

test("moveItems moves several cards and drawings together, in one undo step", async () => {
	const store = await open(memoryStorage());
	const note = store.addType("Note", [], "");
	const boardId = firstBoard(store).id;
	const a = store.addCard(boardId, store.addEntity(note.id, "A", "", {}).id, 0, 0);
	const b = store.addCard(boardId, store.addEntity(note.id, "B", "", {}).id, 48, 0);
	const box = addDrawing(store, boardId, { kind: "textbox", x: 10, y: 10, width: 50, height: 50, color: "#4a4a4a", text: "", textSize: "m" });
	const other = addDrawing(store, boardId, { kind: "textbox", x: 0, y: 0, width: 5, height: 5, color: "#4a4a4a", text: "", textSize: "m" });

	store.moveItems(boardId, { cards: [a.id], drawings: [box.id, other.id] }, 24, -48);
	assert.deepEqual(firstBoard(store).cards.map((c) => [c.id, c.x, c.y]), [[a.id, 24, -48], [b.id, 48, 0]], "order kept, B stays");
	assert.deepEqual(firstBoard(store).drawings, [
		{ ...box, x: 34, y: -38 },
		{ ...other, x: 24, y: -48 },
	]);
	store.undo();
	assert.deepEqual([firstBoard(store).cards[0]!.x, firstBoard(store).drawings], [0, [box, other]]);
});

test("drawings: added, replaced and removed on their own board", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const one = firstBoard(store);
	const two = store.addBoard("Two");
	const rect = addDrawing(store, one.id, {
		kind: "textbox",
		x: 0,
		y: 0,
		width: 100,
		height: 50,
		color: "#f9c9c9",
		text: "Phase 1",
		textSize: "m",
	});
	const area = addDrawing(store, two.id, { kind: "area", x: 0, y: 0, width: 10, height: 10, color: "#4a4a4a", text: "", textSize: "m" });

	replaceDrawing(store, { ...rect, text: "Phase A" } as typeof rect);
	assert.deepEqual(
		(await open(storage)).data.boards.map((b) => b.drawings),
		[[{ ...rect, text: "Phase A" }], [area]],
	);

	removeDrawing(store, area.id);
	assert.deepEqual(store.data.boards[1]?.drawings, []);
	assert.equal(store.data.boards[0]?.drawings.length, 1);
});

test("the library saved before version 9 is left out, and so are the library drawings placed on boards", async () => {
	const box = { id: "box", kind: "textbox", x: 0, y: 0, width: 10, height: 10, color: "#4a4a4a", text: "Hi", textSize: "m" };
	const store = await open(
		memoryStorage({
			version: 8,
			types: [],
			entities: [],
			boards: [
				{
					id: "b",
					name: "B",
					cards: [],
					viewport: { x: 0, y: 0, zoom: 1 },
					drawings: [box, { id: "placed", kind: "symbol", libraryId: "lib", x: 0, y: 0, width: 10, height: 10 }],
				},
			],
			library: [{ id: "lib", name: "Star", tags: [], drawings: [{ ...box, id: "lib-box" }] }],
		}),
	);
	assert.equal("library" in store.data, false);
	assert.deepEqual(firstBoard(store).drawings.map((d) => d.id), ["box"]);
});

test("older boards load without drawings; malformed drawings are dropped", async () => {
	const saved = {
		types: [],
		entities: [],
		boards: [
			{ id: "old", name: "Old", cards: [], viewport: { x: 0, y: 0, zoom: 1 } },
			{
				id: "mixed",
				name: "Mixed",
				cards: [],
				viewport: { x: 0, y: 0, zoom: 1 },
				drawings: [
					{ id: "ok", kind: "textbox", x: 1, y: 2, width: 3, height: 4, color: "#c4dafa" },
					{ id: "no-size", kind: "textbox", x: 1, y: 2, color: "#c4dafa" },
					{ id: "unknown", kind: "star", color: "#c4dafa" },
					{ id: "image", kind: "image", x: 1, y: 2, width: 3, height: 4, src: "data:image/png;base64,AAAA" },
					{ id: "image-no-src", kind: "image", x: 1, y: 2, width: 3, height: 4 },
					{ id: "image-remote", kind: "image", x: 1, y: 2, width: 3, height: 4, src: "https://example.com/a.png" },
					{ id: "area", kind: "area", x: 1, y: 2, width: 3, height: 4, color: "#c4dafa", text: "Team" },
				],
			},
		],
	};
	const [old, mixed] = (await open(memoryStorage(saved))).data.boards;
	assert.deepEqual(old?.drawings, []);
	assert.deepEqual(
		mixed?.drawings.map((d) => d.id),
		["ok", "image", "area"],
	);
	assert.deepEqual(mixed?.drawings[2], { id: "area", kind: "area", x: 1, y: 2, width: 3, height: 4, color: "#c4dafa", text: "Team", textSize: "m" });
	assert.deepEqual(mixed?.drawings[1], { id: "image", kind: "image", x: 1, y: 2, width: 3, height: 4, src: "data:image/png;base64,AAAA" });
	// Missing text fields get defaults.
	assert.deepEqual(mixed?.drawings[0], { id: "ok", kind: "textbox", x: 1, y: 2, width: 3, height: 4, color: "#c4dafa", text: "", textSize: "m" });
});

test("rectangles, ellipses and free text saved before text boxes load as text boxes; lines, arrows and pen strokes are dropped", async () => {
	const at = { x: 1, y: 2, width: 3, height: 4, color: "#c4dafa", textSize: "l" };
	const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
	const saved = {
		types: [],
		entities: [],
		boards: [
			{
				id: "old",
				name: "Old",
				cards: [],
				viewport: { x: 0, y: 0, zoom: 1 },
				drawings: [
					{ id: "rect", kind: "rect", ...at, text: "Phase 1" },
					{ id: "line", kind: "line", points, color: "#c4dafa" },
					{ id: "ellipse", kind: "ellipse", ...at, text: "Idea" },
					{ id: "arrow", kind: "arrow", points, color: "#c4dafa" },
					{ id: "text", kind: "text", ...at, text: "Note" },
					{ id: "pen", kind: "pen", points, color: "#c4dafa", penStyle: "pen" },
				],
			},
		],
	};
	assert.deepEqual(firstBoard(await open(memoryStorage(saved))).drawings, [
		{ id: "rect", kind: "textbox", ...at, text: "Phase 1" },
		{ id: "ellipse", kind: "textbox", ...at, text: "Idea" },
		{ id: "text", kind: "textbox", ...at, text: "Note" },
	]);
});
