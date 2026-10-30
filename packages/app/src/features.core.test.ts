import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION, MIGRATIONS, migrate, type AppData } from "./shared/core/index.js";
import type { Entity } from "./features/data/core.js";
import { createStore } from "./features.core.js";
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

/** Two tabs on the same workspace: each its own store on the one storage. */
async function twoTabs() {
	const storage = memoryStorage();
	const here = await open(storage);
	const book = here.addType("Book", [titleDraft], "");
	const dune = here.addEntity(book.id, "Dune", "", {});
	const there = await open(storage);
	return { storage, here, there, book, dune };
}

const rename = (store: Awaited<ReturnType<typeof open>>, entity: Entity, name: string) =>
	store.updateEntity(entity.id, name, entity.content, entity.values);
const names = (store: Awaited<ReturnType<typeof open>>) => store.data.entities.map((e) => e.name);

test("what another tab saved is taken over unit by unit, and the next save builds on it without a collision", async () => {
	const { storage, here, there, book } = await twoTabs();
	assert.equal(await here.takeNewer(), "current"); // nobody else saved anything

	there.addEntity(book.id, "Emma", "", {});
	await settle();
	assert.equal(await here.takeNewer(), "taken");
	assert.deepEqual(names(here), ["Dune", "Emma"]);
	assert.deepEqual(here.history, { canUndo: true, canRedo: false }); // nothing of the history given up
	assert.equal(await here.takeNewer(), "current"); // taken: the stand here is the newest now

	here.addBoard("Second");
	await settle();
	assert.deepEqual(here.problems, { load: null, saveFailed: false, saveConflict: false });
	assert.deepEqual((storage.data(WS)!.entities as Entity[]).map((e) => e.name), ["Dune", "Emma"]);
	assert.deepEqual(storedBoards(storage), ["Board 1", "Second"]);
});

test("a unit changed here and not saved yet keeps this stand, and its save tells the collision", async () => {
	const { storage, here, there, book, dune } = await twoTabs();
	storage.failing.saves = true;
	rename(here, dune, "Dune (here)");
	await settle();
	storage.failing.saves = false;

	rename(there, dune, "Dune (there)");
	there.addEntity(book.id, "Emma", "", {});
	await settle();
	assert.equal(await here.takeNewer(), "taken");
	assert.deepEqual(names(here), ["Dune (here)", "Emma"]);

	here.addBoard("Second"); // the save that carries the rename again
	await settle();
	assert.equal(here.problems.saveConflict, true);
});

test("undo after a take-over takes back only this tab's own step, never what was taken over", async () => {
	const { here, there, dune } = await twoTabs();
	here.addBoard("Mine");
	await settle();
	rename(there, there.data.entities[0]!, "Dune (there)");
	await settle();
	assert.equal(await here.takeNewer(), "taken");

	assert.equal(here.undo(), true);
	assert.deepEqual(here.data.boards.map((b) => b.name), ["Board 1"]);
	assert.deepEqual(names(here), ["Dune (there)"]);
	assert.equal(here.redo(), true);
	assert.deepEqual(here.data.boards.map((b) => b.name), ["Board 1", "Mine"]);
	assert.deepEqual(names(here), ["Dune (there)"]);

	// Further back too: the entity this tab made comes back as the other tab named it.
	while (here.undo());
	assert.deepEqual(here.data.types, []);
	assert.equal(here.redo(), true);
	assert.equal(here.redo(), true);
	assert.equal(here.data.entities.find((e) => e.id === dune.id)?.name, "Dune (there)");
});

test("this tab's pan and zoom stay its own when another tab's board comes in", async () => {
	const { here, there } = await twoTabs();
	const board = firstBoard(here);
	here.setViewport(board.id, { x: 10, y: 20, zoom: 1.5 });
	await settle();
	there.renameBoard(board.id, "Renamed");
	await settle();
	assert.equal(await here.takeNewer(), "taken");
	assert.equal(firstBoard(here).name, "Renamed");
	assert.deepEqual(firstBoard(here).viewport, { x: 10, y: 20, zoom: 1.5 });
});

test("a first board only read into a new workspace makes way for the one another tab saved", async () => {
	const storage = memoryStorage();
	const here = await open(storage); // its first board is only made by reading, not saved
	const there = await open(storage);
	const book = there.addType("Book", [], "");
	const dune = there.addEntity(book.id, "Dune", "", {});
	there.addCard(firstBoard(there).id, dune.id, 0, 0);
	await settle();

	assert.equal(await here.takeNewer(), "taken");
	assert.deepEqual(here.data.boards.map((b) => b.id), [firstBoard(there).id]);
	assert.equal(firstBoard(here).cards.length, 1);
});

test("while it may not be taken, nothing changes here; the next look takes it over", async () => {
	const { here, there, book } = await twoTabs();
	there.addEntity(book.id, "Emma", "", {});
	await settle();
	assert.equal(await here.takeNewer(() => false), "current");
	assert.deepEqual(names(here), ["Dune"]);
	assert.equal(await here.takeNewer(), "taken");
	assert.deepEqual(names(here), ["Dune", "Emma"]);
});

test("a newer stand that can't be read is reported, and nothing of it is taken over", async () => {
	const { storage, here } = await twoTabs();
	storage.saveElsewhere(WS, { version: DATA_VERSION + 1, types: [], entities: [], boards: [] });
	const seen = JSON.stringify(here.data);
	assert.equal(await here.takeNewer(), "unreadable");
	assert.equal(JSON.stringify(here.data), seen);
	assert.deepEqual(here.problems, { load: null, saveFailed: false, saveConflict: false });
});

test("after a save of its own, this stand is the newer one — no false alarm over its own work", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	assert.equal(await store.takeNewer(), "current"); // the stand this one read

	store.addBoard("A");
	// Even while the save is still on its way: the look waits behind the save, so it never takes this
	// stand's own brand-new save for someone else's.
	assert.equal(await store.takeNewer(), "current");
	await settle();
	assert.equal(await store.takeNewer(), "current"); // settled: the save's own stand, not a newer one

	store.addBoard("B");
	await settle();
	assert.equal(await store.takeNewer(), "current"); // and the one after that too
	assert.deepEqual(storedBoards(storage), ["Board 1", "A", "B"]);
});

test("a look the storage can't answer is no event: nothing changed, nothing reported", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	store.addBoard("A");
	await settle();
	storage.failing.looks = true;
	const seen = JSON.stringify(store.data);
	assert.equal(await store.takeNewer(), "current");
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
