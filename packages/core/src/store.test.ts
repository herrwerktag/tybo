import assert from "node:assert/strict";
import { test } from "node:test";
import { TYPE_COLORS, type AppData, type DraftProperty } from "./model.js";
import { memoryDataPort } from "./memory-port.js";
import { DATA_VERSION, MIGRATIONS, createStore, migrate, type Store } from "./store.js";
import { isUlid } from "./ulid.js";

/** Lets background saves finish and report how they went (a failed save flips `problems.saveFailed` only then). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

/** The workspace the tests' stores open. */
const WS = "ws";

/** The data port in memory, with the workspace WS already there — holding `saved` when given (as data stored
 * by whatever version of the app saved it), or nothing at all, the way a workspace starts. */
function memoryStorage(saved: unknown = { version: DATA_VERSION, types: [], entities: [], boards: [] }) {
	return memoryDataPort({ [WS]: saved });
}

/** The store of the workspace WS, through the port in memory — once the saves on their way have landed, the
 * way another tab opening it a moment later would find them. */
const open = async (storage: ReturnType<typeof memoryStorage>) => {
	await settle();
	return createStore(storage.port, WS);
};

/** Checks for fresh data: no types or entities, and one empty default board. */
function assertEmpty(data: AppData) {
	assert.deepEqual(data.types, []);
	assert.deepEqual(data.entities, []);
	assert.equal(data.boards.length, 1);
	assert.deepEqual({ ...data.boards[0], id: "" }, { id: "", name: "Board 1", cards: [], viewport: { x: 0, y: 0, zoom: 1 }, drawings: [] });
}

/** The first board, which a fresh store always has. */
const firstBoard = (store: Store) => store.data.boards[0]!;

const titleDraft: DraftProperty = { name: "title", kind: "text", options: [], reference: null, cardDisplay: "list" };

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

test("addEntity assigns a ULID; updateEntity keeps it", async () => {
	const store = await open(memoryStorage());
	const type = store.addType("Book", [titleDraft], "");
	const prop = type.properties[0]!;
	const a = store.addEntity(type.id, " A ", "", { [prop.id]: "A" });
	const b = store.addEntity(type.id, "B", "", { [prop.id]: "B" });
	assert.ok(isUlid(a.id));
	assert.equal(a.name, "A");

	store.updateEntity(a.id, "A2", "", { [prop.id]: "A2" });
	const updated = store.data.entities.find((e) => e.id === a.id);
	assert.equal(updated?.name, "A2");
	assert.equal(updated?.values[prop.id], "A2");

	store.deleteEntity(b.id);
	assert.deepEqual(
		store.data.entities.map((e) => e.id),
		[a.id],
	);
});

test("updateType keeps property ids and migrates only that type's entities", async () => {
	const store = await open(memoryStorage());
	const book = store.addType("Book", [titleDraft, { name: "status", kind: "options", options: ["Draft", "Published"], reference: null, cardDisplay: "list" }], "");
	const film = store.addType("Film", [titleDraft], "");
	const title = book.properties[0]!;
	const status = book.properties[1]!;
	const draft = store.addEntity(book.id, "Dune", "", { [title.id]: "Dune", [status.id]: "Draft" });
	const published = store.addEntity(book.id, "Emma", "", { [title.id]: "Emma", [status.id]: "Published" });
	const movie = store.addEntity(film.id, "Alien", "", { [film.properties[0]!.id]: "Alien" });

	store.updateType(book.id, "Novel", [
		{ ...title, name: "name" },
		{ ...status, options: ["Published"] },
		{ name: "author", kind: "text", options: [], reference: null, cardDisplay: "list" },
	], "");

	const novel = store.data.types.find((t) => t.id === book.id)!;
	assert.equal(novel.name, "Novel");
	assert.deepEqual(
		novel.properties.map((p) => [p.name, p.id === title.id || p.id === status.id]),
		[
			["name", true],
			["status", true],
			["author", false],
		],
	);
	const values = (id: string) => store.data.entities.find((e) => e.id === id)?.values;
	assert.deepEqual(values(draft.id), { [title.id]: "Dune", [status.id]: null });
	assert.deepEqual(values(published.id), { [title.id]: "Emma", [status.id]: "Published" });
	assert.deepEqual(values(movie.id), movie.values);
});

test("deleteType removes its entities only", async () => {
	const store = await open(memoryStorage());
	const book = store.addType("Book", [titleDraft], "");
	const film = store.addType("Film", [titleDraft], "");
	store.addEntity(book.id, "Dune", "", {});
	const keep = store.addEntity(film.id, "Alien", "", {});

	store.deleteType(book.id);
	assert.deepEqual(
		store.data.types.map((t) => t.id),
		[film.id],
	);
	assert.deepEqual(
		store.data.entities.map((e) => e.id),
		[keep.id],
	);
});

test("loads data saved with the old number/boolean/date kinds as text", async () => {
	const old = {
		types: [{ id: "b", name: "Book", properties: [{ id: "p", name: "pages", kind: "number" }] }],
		entities: [{ id: "e", typeId: "b", values: { p: 42 } }],
	};
	const store = await open(memoryStorage(old));
	assert.deepEqual(store.data.types[0]?.properties[0], {
		id: "p",
		name: "pages",
		kind: "text",
		options: [],
		reference: null,
		cardDisplay: "list",
	});
	assert.equal(store.data.entities[0]?.values.p, "42");
});

test("gives old entities a ULID and a name from their first property", async () => {
	const old = {
		types: [
			{
				id: "b",
				name: "Book",
				properties: [
					{ id: "t", name: "title", kind: "text", options: [] },
					{ id: "a", name: "author", kind: "text", options: [] },
				],
			},
		],
		entities: [
			{ id: "5f0c6f3e-1b2a-4c3d-9e8f-0a1b2c3d4e5f", typeId: "b", values: { a: "Herbert", t: "Dune" } },
			{ id: "x", typeId: "b", values: { t: null } },
		],
	};
	const [dune, empty] = (await open(memoryStorage(old))).data.entities;
	assert.ok(isUlid(dune?.id));
	assert.equal(dune?.name, "Dune");
	assert.equal(empty?.name, "Untitled");
});

/** The names of the boards the workspace WS holds in the storage. */
const storedBoards = (storage: ReturnType<typeof memoryStorage>) =>
	(storage.data(WS)!.boards as { name: string }[]).map((b) => b.name);

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

test("one malformed type or entity is dropped on its own — and left as it is stored, not deleted", async () => {
	const saved = {
		types: [
			{ id: "broken", name: "Broken" }, // no properties: loads with none
			{ id: "b", name: "Book", properties: [{ id: "t", name: "title", kind: "text" }, "not a property"] },
			"not a type",
		],
		entities: [
			{ id: "x", typeId: "b", name: "Dune", values: { t: "Dune" } },
			{ id: "y", typeId: "b", name: "No values" },
			{ name: "no type id" },
		],
		boards: [],
	};
	const storage = memoryStorage(saved);
	const store = await open(storage);
	assert.deepEqual(
		store.data.types.map((t) => [t.id, t.properties.map((p) => p.id)]),
		[["broken", []], ["b", ["t"]]],
	);
	assert.deepEqual(
		store.data.entities.map((e) => [e.name, e.values]),
		[["Dune", { t: "Dune" }], ["No values", {}]],
	);
	assert.equal(store.problems.load, null);

	// Saving writes what changed — what couldn't be read was never this store's to delete.
	store.addBoard("New");
	await settle();
	assert.ok((storage.data(WS)!.types as unknown[]).includes("not a type"));
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

async function referenceSetup() {
	const store = await open(memoryStorage());
	const person = store.addType("Person", [], "");
	const tag = store.addType("Tag", [], "");
	const book = store.addType("Book", [
		{ name: "author", kind: "reference", options: [], reference: { typeId: person.id, multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
		{ name: "tags", kind: "reference", options: [], reference: { typeId: tag.id, multiple: true, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
	], "");
	const [author, tags] = [book.properties[0]!, book.properties[1]!];
	const frank = store.addEntity(person.id, "Frank", "", {});
	const scifi = store.addEntity(tag.id, "Sci-fi", "", {});
	const classic = store.addEntity(tag.id, "Classic", "", {});
	const dune = store.addEntity(book.id, "Dune", "", { [author.id]: frank.id, [tags.id]: [scifi.id, classic.id] });
	return { store, person, tag, book, author, tags, frank, scifi, classic, dune };
}

test("deleting an entity removes it from single and multiple references", async () => {
	const { store, author, tags, frank, scifi, classic, dune } = await referenceSetup();
	assert.equal(store.referencesTo(scifi.id), 1);
	assert.equal(store.referencesTo(dune.id), 0);

	store.deleteEntity(scifi.id);
	store.deleteEntity(frank.id);
	const values = store.data.entities.find((e) => e.id === dune.id)?.values;
	assert.deepEqual(values, { [author.id]: null, [tags.id]: [classic.id] });

	store.deleteEntity(classic.id);
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.values[tags.id], null);
});

test("typeReferrers lists other types' reference properties, not self-references", async () => {
	const { store, person, tag, book } = await referenceSetup();
	store.updateType(person.id, "Person", [
		{ name: "friend", kind: "reference", options: [], reference: { typeId: person.id, multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
	], "");
	assert.deepEqual(store.typeReferrers(person.id), ["Book.author"]);
	assert.deepEqual(store.typeReferrers(tag.id), ["Book.tags"]);
	assert.deepEqual(store.typeReferrers(book.id), []);
});

test("updateType: changing a reference's target type clears its values", async () => {
	const { store, tag, book, author, tags, dune } = await referenceSetup();
	store.updateType(book.id, "Book", [{ ...author, reference: { typeId: tag.id, multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" } }, tags], "");
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.values[author.id], null);
});

test("reference values persist across store instances", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const tag = store.addType("Tag", [], "");
	const book = store.addType("Book", [
		{ name: "tags", kind: "reference", options: [], reference: { typeId: tag.id, multiple: true, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
	], "");
	const scifi = store.addEntity(tag.id, "Sci-fi", "", {});
	const dune = store.addEntity(book.id, "Dune", "", { [book.properties[0]!.id]: [scifi.id] });

	const reloaded = await open(storage);
	assert.deepEqual(reloaded.data.entities.find((e) => e.id === dune.id)?.values, { [book.properties[0]!.id]: [scifi.id] });
});

test("content and the type's template keep their line breaks; template changes leave entities alone", async () => {
	const store = await open(memoryStorage());
	const note = store.addType("Note", [], "# Title\n\n- ");
	assert.equal(note.contentTemplate, "# Title\n\n- ");

	const entity = store.addEntity(note.id, "First", "# Title\n\n- one\n", {});
	assert.equal(entity.content, "# Title\n\n- one\n");

	store.updateType(note.id, "Note", [], "changed");
	assert.equal(store.data.types[0]?.contentTemplate, "changed");
	assert.equal(store.data.entities[0]?.content, "# Title\n\n- one\n");

	store.updateEntity(entity.id, "First", "  edited\n  text", {});
	assert.equal(store.data.entities[0]?.content, "  edited\n  text");
});

test("old data without content fields loads with empty strings", async () => {
	const old = {
		types: [{ id: "b", name: "Book", properties: [] }],
		entities: [{ id: "01ARYZ6S41TSV4RRFFQ69G5FAV", typeId: "b", name: "Dune", values: {} }],
	};
	const store = await open(memoryStorage(old));
	assert.equal(store.data.types[0]?.contentTemplate, "");
	assert.equal(store.data.entities[0]?.content, "");
});

test("an entity can have several cards; moveCard brings a card to the front", async () => {
	const store = await open(memoryStorage());
	const note = store.addType("Note", [], "");
	const a = store.addEntity(note.id, "A", "", {});
	const b = store.addEntity(note.id, "B", "", {});

	const a1 = store.addCard(firstBoard(store).id, a.id, 10, 20);
	const b1 = store.addCard(firstBoard(store).id, b.id, 30, 40);
	const a2 = store.addCard(firstBoard(store).id, a.id, 70, 80);
	assert.notEqual(a1.id, a2.id);

	store.resizeCard(a1.id, 300, 200);
	store.moveCard(a1.id, 50, 60);

	assert.deepEqual(firstBoard(store).cards, [
		{ id: b1.id, entityId: b.id, x: 30, y: 40, width: 240, height: 160 },
		{ id: a2.id, entityId: a.id, x: 70, y: 80, width: 240, height: 160 },
		{ id: a1.id, entityId: a.id, x: 50, y: 60, width: 300, height: 200 },
	]);
});

test("resizeCard enforces the minimum size; removeCard removes one card and keeps the entity", async () => {
	const store = await open(memoryStorage());
	const note = store.addType("Note", [], "");
	const a = store.addEntity(note.id, "A", "", {});
	const first = store.addCard(firstBoard(store).id, a.id, 0, 0);
	const second = store.addCard(firstBoard(store).id, a.id, 100, 0);

	store.resizeCard(first.id, 10, 10);
	assert.deepEqual(firstBoard(store).cards[0], { id: first.id, entityId: a.id, x: 0, y: 0, width: 160, height: 80 });

	store.removeCard(first.id);
	assert.deepEqual(
		firstBoard(store).cards.map((c) => c.id),
		[second.id],
	);
	assert.equal(store.data.entities.length, 1);
});

test("deleting an entity or its type removes its card", async () => {
	const store = await open(memoryStorage());
	const note = store.addType("Note", [], "");
	const other = store.addType("Other", [], "");
	const a = store.addEntity(note.id, "A", "", {});
	const b = store.addEntity(other.id, "B", "", {});
	const c = store.addEntity(other.id, "C", "", {});
	store.addCard(firstBoard(store).id, a.id, 0, 0);
	store.addCard(firstBoard(store).id, a.id, 0, 0);
	store.addCard(firstBoard(store).id, b.id, 0, 0);
	store.addCard(firstBoard(store).id, c.id, 0, 0);

	store.deleteEntity(a.id);
	store.deleteType(other.id);
	assert.deepEqual(firstBoard(store).cards, []);
});

test("cards and viewport persist; bad canvas data falls back to empty", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const note = store.addType("Note", [], "");
	const a = store.addEntity(note.id, "A", "", {});
	store.addCard(firstBoard(store).id, a.id, 5, 6);
	store.setViewport(firstBoard(store).id, { x: 100, y: -50, zoom: 9 });

	const reloaded = await open(storage);
	assert.equal(firstBoard(reloaded).cards[0]?.x, 5);
	assert.deepEqual(firstBoard(reloaded).viewport, { x: 100, y: -50, zoom: 2 });

	const bad = { types: [], entities: [], boards: [{ cards: [{ entityId: "x", x: "1" }], viewport: null }] };
	assertEmpty((await open(memoryStorage(bad))).data);
});

test("the single canvas saved before boards existed becomes Board 1; its cards get ids", async () => {
	const old = {
		types: [{ id: "n", name: "Note", properties: [], contentTemplate: "" }],
		entities: [{ id: "01ARYZ6S41TSV4RRFFQ69G5FAV", typeId: "n", name: "A", content: "", values: {} }],
		canvas: {
			cards: [{ entityId: "01ARYZ6S41TSV4RRFFQ69G5FAV", x: 1, y: 2, width: 240, height: 160 }],
			viewport: { x: 0, y: 0, zoom: 1 },
		},
	};
	const { boards } = (await open(memoryStorage(old))).data;
	assert.equal(boards.length, 1);
	assert.equal(boards[0]?.name, "Board 1");
	const [card] = boards[0]!.cards;
	assert.equal(typeof card?.id, "string");
	assert.equal(card?.x, 1);
});

test("boards can be added, renamed and deleted, but never the last one", async () => {
	const store = await open(memoryStorage());
	const first = firstBoard(store);
	const second = store.addBoard(" Planning ");
	assert.equal(second.name, "Planning");
	assert.equal(store.addBoard("  ").name, "Board 3");

	store.renameBoard(second.id, "Roadmap");
	store.renameBoard(second.id, "   ");
	assert.equal(store.data.boards[1]?.name, "Roadmap");

	store.deleteBoard(second.id);
	store.deleteBoard(store.data.boards[1]!.id);
	assert.deepEqual(
		store.data.boards.map((b) => b.id),
		[first.id],
	);
	store.deleteBoard(first.id);
	assert.equal(store.data.boards.length, 1);
});

test("each board has its own cards and viewport; card changes stay on their board", async () => {
	const store = await open(memoryStorage());
	const note = store.addType("Note", [], "");
	const a = store.addEntity(note.id, "A", "", {});
	const one = firstBoard(store);
	const two = store.addBoard("Two");

	const onOne = store.addCard(one.id, a.id, 0, 0);
	const onTwo = store.addCard(two.id, a.id, 10, 10);
	store.moveCard(onTwo.id, 99, 99);
	store.resizeCard(onTwo.id, 400, 300);
	store.setViewport(two.id, { x: 5, y: 5, zoom: 1.5 });

	const [b1, b2] = store.data.boards;
	assert.deepEqual(b1?.cards, [{ ...onOne }]);
	assert.deepEqual(b1?.viewport, { x: 0, y: 0, zoom: 1 });
	assert.deepEqual(b2?.cards, [{ ...onTwo, x: 99, y: 99, width: 400, height: 300 }]);
	assert.deepEqual(b2?.viewport, { x: 5, y: 5, zoom: 1.5 });

	store.removeCard(onTwo.id);
	assert.equal(store.data.boards[0]?.cards.length, 1);
	assert.equal(store.data.boards[1]?.cards.length, 0);

	store.addCard(two.id, a.id, 0, 0);
	store.deleteEntity(a.id);
	assert.deepEqual(
		store.data.boards.map((b) => b.cards.length),
		[0, 0],
	);
});

test("types get distinct palette colors; a chosen color is kept and can be changed", async () => {
	const palette = TYPE_COLORS.map((c) => c.value);
	const store = await open(memoryStorage());
	const a = store.addType("A", [], "");
	const b = store.addType("B", [], "", palette[3]);
	const c = store.addType("C", [], "");
	assert.deepEqual([a.color, b.color, c.color], [palette[0], palette[3], palette[1]]);

	store.updateType(a.id, "A", [], "");
	assert.equal(store.data.types[0]?.color, palette[0]);
	store.updateType(a.id, "A", [], "", palette[5]);
	assert.equal(store.data.types[0]?.color, palette[5]);
});

test("types saved without a color get the next free ones in order", async () => {
	const palette = TYPE_COLORS.map((c) => c.value);
	const old = {
		types: [
			{ id: "a", name: "A", properties: [] },
			{ id: "b", name: "B", properties: [], color: palette[0] },
			{ id: "c", name: "C", properties: [], color: "not a color" },
		],
		entities: [],
	};
	const { types } = (await open(memoryStorage(old))).data;
	assert.deepEqual(
		types.map((t) => t.color),
		[palette[1], palette[0], palette[2]],
	);
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

test("references get arrow, line label and inverse label defaults; labels are trimmed", async () => {
	const old = {
		types: [
			{ id: "p", name: "Person", properties: [] },
			{
				id: "b",
				name: "Book",
				properties: [{ id: "a", name: "author", kind: "reference", options: [], reference: { typeId: "p", multiple: false } }],
			},
		],
		entities: [],
	};
	const store = await open(memoryStorage(old));
	const author = store.data.types[1]!.properties[0]!;
	assert.deepEqual(author.reference, { typeId: "p", multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" });

	store.updateType(
		"b",
		"Book",
		[{ ...author, reference: { ...author.reference!, arrow: "from", lineLabel: "  wrote  ", inverseLabel: " author of " } }],
		"",
	);
	assert.deepEqual(store.data.types[1]!.properties[0]!.reference, {
		typeId: "p",
		multiple: false,
		arrow: "from",
		lineLabel: "wrote",
		inverseLabel: "author of",
	});
});

test("description: saved on add, kept when an update leaves it out, defaults to empty for older data", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const type = store.addType("Note", [], "");
	const note = store.addEntity(type.id, "A", "short", {}, "Long\n\ndetails");
	assert.equal((await open(storage)).data.entities[0]?.description, "Long\n\ndetails");

	store.updateEntity(note.id, "A", "short", {});
	assert.equal(store.data.entities[0]?.description, "Long\n\ndetails");
	store.updateEntity(note.id, "A", "short", {}, "");
	assert.equal(store.data.entities[0]?.description, "");
	assert.equal(store.addEntity(type.id, "B", "", {}).description, "");

	const old = {
		types: [{ id: "n", name: "Note", properties: [] }],
		entities: [{ id: "01ARYZ6S41TSV4RRFFQ69G5FAV", typeId: "n", name: "Old", content: "", values: {} }],
	};
	assert.equal((await open(memoryStorage(old))).data.entities[0]?.description, "");
});

test("drawings: added, replaced and removed on their own board", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const one = firstBoard(store);
	const two = store.addBoard("Two");
	const rect = store.addDrawing(one.id, {
		kind: "rect",
		x: 0,
		y: 0,
		width: 100,
		height: 50,
		color: "#f9c9c9",
		text: "Phase 1",
		textSize: "m",
	});
	const arrow = store.addDrawing(two.id, { kind: "arrow", points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], color: "#4a4a4a" });

	store.replaceDrawing({ ...rect, text: "Phase A" } as typeof rect);
	assert.deepEqual(
		(await open(storage)).data.boards.map((b) => b.drawings),
		[[{ ...rect, text: "Phase A" }], [arrow]],
	);

	store.removeDrawing(arrow.id);
	assert.deepEqual(store.data.boards[1]?.drawings, []);
	assert.equal(store.data.boards[0]?.drawings.length, 1);
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
					{ id: "ok", kind: "ellipse", x: 1, y: 2, width: 3, height: 4, color: "#c4dafa" },
					{ id: "no-size", kind: "rect", x: 1, y: 2, color: "#c4dafa" },
					{ id: "one-point", kind: "line", points: [{ x: 0, y: 0 }], color: "#c4dafa" },
					{ id: "three-points", kind: "arrow", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], color: "#c4dafa" },
					{ id: "pen", kind: "pen", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], color: "#c4dafa" },
					{ id: "unknown", kind: "star", color: "#c4dafa" },
				],
			},
		],
	};
	const [old, mixed] = (await open(memoryStorage(saved))).data.boards;
	assert.deepEqual(old?.drawings, []);
	assert.deepEqual(
		mixed?.drawings.map((d) => d.id),
		["ok", "pen"],
	);
	// Missing text fields get defaults.
	assert.deepEqual(mixed?.drawings[0], { id: "ok", kind: "ellipse", x: 1, y: 2, width: 3, height: 4, color: "#c4dafa", text: "", textSize: "m" });
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

test("pan and zoom aren't undone, and undo keeps the current view; changes that change nothing aren't recorded", async () => {
	const store = await open(memoryStorage());
	const board = firstBoard(store);
	const card = store.addCard(board.id, "missing", 0, 0); // entity check happens on load only
	store.setViewport(board.id, { x: 10, y: 20, zoom: 2 });
	assert.deepEqual(store.history, { canUndo: true, canRedo: false });

	store.moveCard(card.id, 0, 0); // same place
	store.renameBoard(board.id, board.name);
	store.undo();
	assert.deepEqual(firstBoard(store).cards, []);
	assert.deepEqual(firstBoard(store).viewport, { x: 10, y: 20, zoom: 2 });
	assert.equal(store.history.canUndo, false);
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
	assert.equal(unit?.after?.value.name, "Dune");

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
