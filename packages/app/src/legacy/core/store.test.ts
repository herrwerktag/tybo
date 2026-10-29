import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppData, Entity } from "./model.js";
import { DATA_VERSION, MIGRATIONS, createStore, migrate } from "./store.js";
import { settle, WS, memoryStorage, open, assertEmpty, firstBoard, titleDraft, storedBoards } from "./test-store.js";

test("data persists across store instances", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const type = store.addType(" Book ", [titleDraft], "");
	const prop = type.properties[0]!;
	store.addEntity(type.id, "Dune", "", { [prop.id]: "Dune" });

	const reloaded = await open(storage);
	assert.equal(reloaded.data.types[0]?.name, "Book");
	assert.equal(reloaded.data.entities[0]?.name, "Dune");
	assert.equal(reloaded.data.entities[0]?.values[prop.id], "Dune");
});

test("a workspace that can't be loaded starts empty, and nothing is saved over it", async () => {
	const storage = memoryStorage({ version: 1, types: [{ id: "b", name: "Book", properties: [] }], entities: [], boards: [] });
	storage.failing.loads = true;
	const store = await open(storage);
	assertEmpty(store.data);
	assert.deepEqual(store.problems.load, { code: "unavailable" });

	// Changes work in memory, but nothing goes out: what's stored stays exactly as it was.
	store.addType("Film", [], "");
	await settle();
	assert.equal(store.data.types.length, 1);
	assert.equal(storage.saves.length, 0);

	// A workspace that isn't there (deleted elsewhere) is just as unavailable.
	const gone = await createStore(memoryStorage().port, "not-there");
	assert.deepEqual(gone.problems.load, { code: "unavailable" });

	// Reading anew once the storage answers again: the data is there, saving goes on.
	storage.failing.loads = false;
	await store.reload();
	assert.equal(store.problems.load, null);
	assert.deepEqual(store.data.types.map((t) => t.name), ["Book"]);
});

test("failed saves are reported until a save succeeds again — and then nothing of the failed ones is missing", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	let notified = 0;
	store.onProblemsChange(() => notified++);

	store.addBoard("A");
	await settle();
	assert.equal(store.problems.saveFailed, false);
	storage.failing.saves = true;
	store.addBoard("B");
	store.addBoard("C");
	await settle();
	assert.equal(store.problems.saveFailed, true);
	assert.equal(notified, 1);
	storage.failing.saves = false;
	store.addBoard("D");
	await settle();
	assert.equal(store.problems.saveFailed, false);
	assert.equal(notified, 2);
	assert.deepEqual(storedBoards(storage), ["Board 1", "A", "B", "C", "D"]);
});

test("saved() settles once the saves on their way have landed, and problems then say how they went", async () => {
	const storage = memoryStorage();
	const store = await open(storage);

	store.addBoard("A");
	await store.saved();
	assert.deepEqual(storedBoards(storage), ["Board 1", "A"]);
	storage.failing.saves = true;
	store.addBoard("B");
	await store.saved();
	assert.equal(store.problems.saveFailed, true);
});

test("a save that collided with someone else's is its own problem, and saving stops until it's read anew", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	let notified = 0;
	store.onProblemsChange(() => notified++);

	store.addBoard("A");
	await settle();
	assert.equal(store.problems.saveConflict, false);

	// Someone else renames board A in between; here it's renamed too — the same unit from two sides.
	const theirs = structuredClone(storage.data(WS)!) as unknown as AppData;
	theirs.boards[1]!.name = "Theirs";
	storage.saveElsewhere(WS, theirs as unknown as Record<string, unknown>);
	store.renameBoard(store.data.boards[1]!.id, "Mine");
	await settle();
	// Not a failed save (no storage problem) — a conflict, honestly named. The last save won.
	assert.deepEqual(store.problems, { load: null, saveFailed: false, saveConflict: true });
	assert.equal(notified, 1);
	assert.deepEqual(storedBoards(storage), ["Board 1", "Mine"]);

	// Further changes stay in memory; nothing more is written until the data is read anew.
	store.addBoard("C");
	await settle();
	assert.equal(notified, 1);
	assert.deepEqual(storedBoards(storage), ["Board 1", "Mine"]);

	// Reading anew makes this stand current again: the next change goes through.
	await store.reload();
	assert.equal(store.problems.saveConflict, false);
	store.addBoard("D");
	await settle();
	assert.deepEqual(storedBoards(storage), ["Board 1", "Mine", "D"]);
});


test("cardDisplay is saved per property; line falls back to list for non-references", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const type = store.addType("Book", [{ ...titleDraft, cardDisplay: "hidden" }], "");
	assert.equal((await open(storage)).data.types[0]?.properties[0]?.cardDisplay, "hidden");

	store.updateType(type.id, "Book", [{ ...type.properties[0]!, cardDisplay: "line" }], "");
	assert.equal(store.data.types[0]?.properties[0]?.cardDisplay, "list");
});

test("the old showOnCard checkbox converts to cardDisplay", async () => {
	const prop = (id: string, extra: object) => ({ id, name: id, kind: "text", options: [], reference: null, ...extra });
	const old = {
		types: [{ id: "b", name: "Book", properties: [prop("shown", { showOnCard: true }), prop("off", { showOnCard: false }), prop("older", {})] }],
		entities: [],
	};
	const [shown, off, older] = (await open(memoryStorage(old))).data.types[0]!.properties;
	assert.deepEqual([shown?.cardDisplay, off?.cardDisplay, older?.cardDisplay], ["list", "hidden", "list"]);
	assert.ok(!("showOnCard" in shown!));
});

test("moveItems moves several cards and drawings together, in one undo step", async () => {
	const store = await open(memoryStorage());
	const note = store.addType("Note", [], "");
	const boardId = firstBoard(store).id;
	const a = store.addCard(boardId, store.addEntity(note.id, "A", "", {}).id, 0, 0);
	const b = store.addCard(boardId, store.addEntity(note.id, "B", "", {}).id, 48, 0);
	const box = store.addDrawing(boardId, { kind: "textbox", x: 10, y: 10, width: 50, height: 50, color: "#4a4a4a", text: "", textSize: "m" });
	const other = store.addDrawing(boardId, { kind: "textbox", x: 0, y: 0, width: 5, height: 5, color: "#4a4a4a", text: "", textSize: "m" });

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
	const rect = store.addDrawing(one.id, {
		kind: "textbox",
		x: 0,
		y: 0,
		width: 100,
		height: 50,
		color: "#f9c9c9",
		text: "Phase 1",
		textSize: "m",
	});
	const area = store.addDrawing(two.id, { kind: "area", x: 0, y: 0, width: 10, height: 10, color: "#4a4a4a", text: "", textSize: "m" });

	store.replaceDrawing({ ...rect, text: "Phase A" } as typeof rect);
	assert.deepEqual(
		(await open(storage)).data.boards.map((b) => b.drawings),
		[[{ ...rect, text: "Phase A" }], [area]],
	);

	store.removeDrawing(area.id);
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

test("reload takes over what another tab saved, so saving here keeps it", async () => {
	const storage = memoryStorage();
	const here = await open(storage);
	const otherTab = await open(storage);
	const book = otherTab.addType("Book", [titleDraft], "");

	await here.reload();
	assert.deepEqual(here.data.types.map((t) => t.name), ["Book"]);
	here.addEntity(book.id, "Dune", "", {});
	const saved = await open(storage);
	assert.deepEqual(saved.data.types.map((t) => t.name), ["Book"]);
	assert.deepEqual(saved.data.entities.map((e) => e.name), ["Dune"]);
});

test("undo and redo step through changes, and are saved", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	assert.deepEqual(store.history, { canUndo: false, canRedo: false });
	const book = store.addType("Book", [titleDraft], "");
	const dune = store.addEntity(book.id, "Dune", "", {});
	store.deleteEntity(dune.id);

	assert.equal(store.undo(), true);
	assert.deepEqual(store.data.entities.map((e) => e.name), ["Dune"]);
	assert.deepEqual((await open(storage)).data.entities.map((e) => e.name), ["Dune"]);
	assert.deepEqual(store.history, { canUndo: true, canRedo: true });

	store.undo();
	store.undo();
	assert.deepEqual(store.data.types, []);
	assert.equal(store.undo(), false);

	store.redo();
	store.redo();
	assert.deepEqual(store.data.entities.map((e) => e.name), ["Dune"]);

	// A new change drops what could be redone.
	store.addBoard("Second");
	assert.deepEqual(store.history, { canUndo: true, canRedo: false });
	assert.equal(store.redo(), false);
});

test("history is limited, cleared on reload, and changes to it are reported", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	let reported = 0;
	store.onHistoryChange(() => reported++);
	for (let i = 0; i < 120; i++) store.addBoard(`B${i}`);
	let undone = 0;
	while (store.undo()) undone++;
	assert.equal(undone, 100);
	assert.ok(reported > 0);

	store.redo();
	await store.reload(); // e.g. another tab saved: its changes mustn't be undone from here
	assert.deepEqual(store.history, { canUndo: false, canRedo: false });
});

test("data saved before versions existed loads without a problem, and saving goes on from it", async () => {
	const storage = memoryStorage({ types: [{ id: "b", name: "Book", properties: [] }], entities: [] });
	const store = await open(storage);
	assert.equal(store.problems.load, null);
	store.addBoard("Second");
	await settle();
	assert.deepEqual((storage.data(WS)!.types as { name: string }[]).map((t) => t.name), ["Book"]);
	assert.deepEqual(storedBoards(storage), ["Board 1", "Second"]);
	assert.equal((await open(storage)).problems.load, null);
	assert.equal("version" in store.data, false);
});

test("migrate runs one step per version, in order, from the saved version up", () => {
	const steps = {
		0: (d: Record<string, unknown>) => ({ ...d, log: [...(d.log as string[]), "0→1"] }),
		1: (d: Record<string, unknown>) => ({ ...d, log: [...(d.log as string[]), "1→2"] }),
	};
	assert.deepEqual(migrate({ log: [] }, steps, 2), { log: ["0→1", "1→2"] });
	assert.deepEqual(migrate({ version: 1, log: [] }, steps, 2), { version: 1, log: ["1→2"] });
	assert.deepEqual(migrate({ version: 2, log: [] }, steps, 2), { version: 2, log: [] });
	assert.deepEqual(migrate({ version: "x", log: [] }, steps, 2), { version: "x", log: ["0→1", "1→2"] });

	// Every version before the current one has its step.
	for (let v = 0; v < DATA_VERSION; v++) assert.equal(typeof MIGRATIONS[v], "function", `no step from version ${v}`);
});

test("data from a newer version is shown as far as it's understood, but never saved over", async () => {
	const newer = { version: DATA_VERSION + 1, types: [{ id: "b", name: "Book", properties: [], icon: "📕" }], entities: [], future: true };
	const storage = memoryStorage(newer);
	const store = await open(storage);
	assert.deepEqual(store.problems.load, { code: "newerVersion" });
	assert.deepEqual(store.data.types.map((t) => t.name), ["Book"]);

	store.addType("Film", [titleDraft], "");
	await settle();
	assert.equal(store.data.types.length, 2);
	assert.deepEqual(storage.data(WS), newer);
	assert.equal(storage.saves.length, 0);
});

test("a newer stand is seen by looking only — nothing in memory changes, nothing is given up", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const book = store.addType("Book", [titleDraft], "");
	store.addEntity(book.id, "Dune", "", {});
	await settle();
	assert.equal(await store.checkForNewer(), false); // this stand is the one the save reached

	storage.saveElsewhere(WS); // someone else saved in between
	const seen = JSON.stringify(store.data);
	assert.equal(await store.checkForNewer(), true);

	// The look only looked: the data, the history and the problems stand as they stood.
	assert.equal(JSON.stringify(store.data), seen);
	assert.deepEqual(store.history, { canUndo: true, canRedo: false });
	assert.deepEqual(store.problems, { load: null, saveFailed: false, saveConflict: false });

	// Nothing was reloaded or discarded for it: the history still undoes, and the undo's save reaches the
	// storage — its version is this store's own stand again, no look's doing.
	assert.equal(store.undo(), true);
	assert.equal(store.data.entities.some((e) => e.name === "Dune"), false);
	assert.equal(await store.checkForNewer(), false);

	// Reading anew is nobody's decision but the user's; once read, the newer stand is simply this one.
	storage.saveElsewhere(WS);
	await store.reload();
	assert.equal(await store.checkForNewer(), false);
});

test("after a save of its own, this stand is the newer one — no false alarm over its own work", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	assert.equal(await store.checkForNewer(), false); // the stand this one read

	store.addBoard("A");
	// Even while the save is still on its way: the look waits behind the save, so it never reports this
	// stand's own brand-new save as someone else's.
	assert.equal(await store.checkForNewer(), false);
	await settle();
	assert.equal(await store.checkForNewer(), false); // settled: the save's own stand, not a newer one

	store.addBoard("B");
	await settle();
	assert.equal(await store.checkForNewer(), false); // and the one after that too
});

test("a look the storage can't answer is no event: false, nothing changed, nothing reported", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	store.addBoard("A");
	await settle();
	storage.failing.looks = true;
	const seen = JSON.stringify(store.data);
	assert.equal(await store.checkForNewer(), false);
	assert.equal(storage.looks(), 1);
	assert.equal(JSON.stringify(store.data), seen);
	assert.deepEqual(store.history, { canUndo: true, canRedo: false });
	assert.deepEqual(store.problems, { load: null, saveFailed: false, saveConflict: false });
});

test("saves go out as change sets of only what changed", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const type = store.addType("Book", [titleDraft], "");
	const board = firstBoard(store);
	await settle();
	// The workspace started with nothing stored: the first save brings the board it opened with, and the type.
	assert.deepEqual(storage.saves[0]!.map((c) => `${c.kind}:${c.id}`), [`type:${type.id}`, `board:${board.id}`]);

	const entity = store.addEntity(type.id, "Dune", "", {});
	await settle();
	const [unit] = storage.saves[1]!;
	assert.equal(storage.saves[1]!.length, 1);
	assert.equal(unit?.kind, "entity");
	assert.equal(unit?.id, entity.id);
	assert.equal(unit?.before, null);
	assert.equal((unit?.after?.value as Entity | undefined)?.name, "Dune");

	const card = store.addCard(board.id, entity.id, 5, 6);
	await settle();
	assert.deepEqual(storage.saves[2]!.map((c) => c.kind), ["card"]);

	// Panning and zooming is the board's own unit — the card on it stays out of it.
	store.setViewport(board.id, { x: 3, y: 4, zoom: 1 });
	await settle();
	assert.deepEqual(storage.saves[3]!.map((c) => c.kind), ["board"]);

	store.moveCard(card.id, 66, 77);
	await settle();
	assert.deepEqual(storage.saves.at(-1)!.map((c) => c.kind), ["card"]);

	// What the storage holds is exactly what the store holds.
	assert.deepEqual((await open(storage)).data, store.data);
});

test("a save that changes nothing never goes out — not one call", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	store.addBoard("Extra");
	await settle();
	assert.equal(storage.saves.length, 1);

	const board = store.data.boards[0]!;
	store.setViewport(board.id, { ...board.viewport }); // the same stand of the board, saved anyway
	store.renameBoard(board.id, board.name); // changed nothing
	await settle();
	assert.equal(storage.saves.length, 1);
});
