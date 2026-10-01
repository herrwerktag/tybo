import assert from "node:assert/strict";
import { test } from "node:test";
import { TYPE_COLORS, type AppData, type DraftProperty } from "./model.js";
import { createStore, type Store } from "./store.js";
import { isUlid } from "./ulid.js";

function memoryStorage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
	};
}

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

test("data persists across store instances", () => {
	const storage = memoryStorage();
	const store = createStore(storage);
	const type = store.addType(" Book ", [titleDraft], "");
	const prop = type.properties[0]!;
	store.addEntity(type.id, "Dune", "", { [prop.id]: "Dune" });

	const reloaded = createStore(storage);
	assert.equal(reloaded.data.types[0]?.name, "Book");
	assert.equal(reloaded.data.entities[0]?.name, "Dune");
	assert.equal(reloaded.data.entities[0]?.values[prop.id], "Dune");
});

test("addEntity assigns a ULID; updateEntity keeps it", () => {
	const store = createStore(memoryStorage());
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

test("updateType keeps property ids and migrates only that type's entities", () => {
	const store = createStore(memoryStorage());
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

test("deleteType removes its entities only", () => {
	const store = createStore(memoryStorage());
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

test("loads data saved with the old number/boolean/date kinds as text", () => {
	const old = {
		types: [{ id: "b", name: "Book", properties: [{ id: "p", name: "pages", kind: "number" }] }],
		entities: [{ id: "e", typeId: "b", values: { p: 42 } }],
	};
	const store = createStore(memoryStorage({ "entities-app": JSON.stringify(old) }));
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

test("gives old entities a ULID and a name from their first property", () => {
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
	const [dune, empty] = createStore(memoryStorage({ "entities-app": JSON.stringify(old) })).data.entities;
	assert.ok(isUlid(dune?.id));
	assert.equal(dune?.name, "Dune");
	assert.equal(empty?.name, "Untitled");
});

test("falls back to empty data on corrupt or throwing storage", () => {
	assertEmpty(createStore(memoryStorage({ "entities-app": "{not json" })).data);
	assertEmpty(createStore(memoryStorage({ "entities-app": '{"types":1}' })).data);

	const throwing = {
		getItem: () => {
			throw new Error("blocked");
		},
		setItem: () => {
			throw new Error("blocked");
		},
	};
	const store = createStore(throwing);
	assertEmpty(store.data);
	store.addType("Book", [titleDraft], "");
	assert.equal(store.data.types.length, 1);
});

function referenceSetup() {
	const store = createStore(memoryStorage());
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

test("deleting an entity removes it from single and multiple references", () => {
	const { store, author, tags, frank, scifi, classic, dune } = referenceSetup();
	assert.equal(store.referencesTo(scifi.id), 1);
	assert.equal(store.referencesTo(dune.id), 0);

	store.deleteEntity(scifi.id);
	store.deleteEntity(frank.id);
	const values = store.data.entities.find((e) => e.id === dune.id)?.values;
	assert.deepEqual(values, { [author.id]: null, [tags.id]: [classic.id] });

	store.deleteEntity(classic.id);
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.values[tags.id], null);
});

test("typeReferrers lists other types' reference properties, not self-references", () => {
	const { store, person, tag, book } = referenceSetup();
	store.updateType(person.id, "Person", [
		{ name: "friend", kind: "reference", options: [], reference: { typeId: person.id, multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
	], "");
	assert.deepEqual(store.typeReferrers(person.id), ["Book.author"]);
	assert.deepEqual(store.typeReferrers(tag.id), ["Book.tags"]);
	assert.deepEqual(store.typeReferrers(book.id), []);
});

test("updateType: changing a reference's target type clears its values", () => {
	const { store, tag, book, author, tags, dune } = referenceSetup();
	store.updateType(book.id, "Book", [{ ...author, reference: { typeId: tag.id, multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" } }, tags], "");
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.values[author.id], null);
});

test("reference values persist across store instances", () => {
	const storage = memoryStorage();
	const store = createStore(storage);
	const tag = store.addType("Tag", [], "");
	const book = store.addType("Book", [
		{ name: "tags", kind: "reference", options: [], reference: { typeId: tag.id, multiple: true, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
	], "");
	const scifi = store.addEntity(tag.id, "Sci-fi", "", {});
	const dune = store.addEntity(book.id, "Dune", "", { [book.properties[0]!.id]: [scifi.id] });

	const reloaded = createStore(storage);
	assert.deepEqual(reloaded.data.entities.find((e) => e.id === dune.id)?.values, { [book.properties[0]!.id]: [scifi.id] });
});

test("content and the type's template keep their line breaks; template changes leave entities alone", () => {
	const store = createStore(memoryStorage());
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

test("old data without content fields loads with empty strings", () => {
	const old = {
		types: [{ id: "b", name: "Book", properties: [] }],
		entities: [{ id: "01ARYZ6S41TSV4RRFFQ69G5FAV", typeId: "b", name: "Dune", values: {} }],
	};
	const store = createStore(memoryStorage({ "entities-app": JSON.stringify(old) }));
	assert.equal(store.data.types[0]?.contentTemplate, "");
	assert.equal(store.data.entities[0]?.content, "");
});

test("an entity can have several cards; moveCard brings a card to the front", () => {
	const store = createStore(memoryStorage());
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

test("resizeCard enforces the minimum size; removeCard removes one card and keeps the entity", () => {
	const store = createStore(memoryStorage());
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

test("deleting an entity or its type removes its card", () => {
	const store = createStore(memoryStorage());
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

test("cards and viewport persist; bad canvas data falls back to empty", () => {
	const storage = memoryStorage();
	const store = createStore(storage);
	const note = store.addType("Note", [], "");
	const a = store.addEntity(note.id, "A", "", {});
	store.addCard(firstBoard(store).id, a.id, 5, 6);
	store.setViewport(firstBoard(store).id, { x: 100, y: -50, zoom: 9 });

	const reloaded = createStore(storage);
	assert.equal(firstBoard(reloaded).cards[0]?.x, 5);
	assert.deepEqual(firstBoard(reloaded).viewport, { x: 100, y: -50, zoom: 2 });

	const bad = { types: [], entities: [], boards: [{ cards: [{ entityId: "x", x: "1" }], viewport: null }] };
	assertEmpty(createStore(memoryStorage({ "entities-app": JSON.stringify(bad) })).data);
});

test("the single canvas saved before boards existed becomes Board 1; its cards get ids", () => {
	const old = {
		types: [{ id: "n", name: "Note", properties: [], contentTemplate: "" }],
		entities: [{ id: "01ARYZ6S41TSV4RRFFQ69G5FAV", typeId: "n", name: "A", content: "", values: {} }],
		canvas: {
			cards: [{ entityId: "01ARYZ6S41TSV4RRFFQ69G5FAV", x: 1, y: 2, width: 240, height: 160 }],
			viewport: { x: 0, y: 0, zoom: 1 },
		},
	};
	const { boards } = createStore(memoryStorage({ "entities-app": JSON.stringify(old) })).data;
	assert.equal(boards.length, 1);
	assert.equal(boards[0]?.name, "Board 1");
	const [card] = boards[0]!.cards;
	assert.equal(typeof card?.id, "string");
	assert.equal(card?.x, 1);
});

test("boards can be added, renamed and deleted, but never the last one", () => {
	const store = createStore(memoryStorage());
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

test("each board has its own cards and viewport; card changes stay on their board", () => {
	const store = createStore(memoryStorage());
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

test("types get distinct palette colors; a chosen color is kept and can be changed", () => {
	const palette = TYPE_COLORS.map((c) => c.value);
	const store = createStore(memoryStorage());
	const a = store.addType("A", [], "");
	const b = store.addType("B", [], "", palette[3]);
	const c = store.addType("C", [], "");
	assert.deepEqual([a.color, b.color, c.color], [palette[0], palette[3], palette[1]]);

	store.updateType(a.id, "A", [], "");
	assert.equal(store.data.types[0]?.color, palette[0]);
	store.updateType(a.id, "A", [], "", palette[5]);
	assert.equal(store.data.types[0]?.color, palette[5]);
});

test("types saved without a color get the next free ones in order", () => {
	const palette = TYPE_COLORS.map((c) => c.value);
	const old = {
		types: [
			{ id: "a", name: "A", properties: [] },
			{ id: "b", name: "B", properties: [], color: palette[0] },
			{ id: "c", name: "C", properties: [], color: "not a color" },
		],
		entities: [],
	};
	const { types } = createStore(memoryStorage({ "entities-app": JSON.stringify(old) })).data;
	assert.deepEqual(
		types.map((t) => t.color),
		[palette[1], palette[0], palette[2]],
	);
});

test("cardDisplay is saved per property; line falls back to list for non-references", () => {
	const storage = memoryStorage();
	const store = createStore(storage);
	const type = store.addType("Book", [{ ...titleDraft, cardDisplay: "hidden" }], "");
	assert.equal(createStore(storage).data.types[0]?.properties[0]?.cardDisplay, "hidden");

	store.updateType(type.id, "Book", [{ ...type.properties[0]!, cardDisplay: "line" }], "");
	assert.equal(store.data.types[0]?.properties[0]?.cardDisplay, "list");
});

test("the old showOnCard checkbox converts to cardDisplay", () => {
	const prop = (id: string, extra: object) => ({ id, name: id, kind: "text", options: [], reference: null, ...extra });
	const old = {
		types: [{ id: "b", name: "Book", properties: [prop("shown", { showOnCard: true }), prop("off", { showOnCard: false }), prop("older", {})] }],
		entities: [],
	};
	const [shown, off, older] = createStore(memoryStorage({ "entities-app": JSON.stringify(old) })).data.types[0]!.properties;
	assert.deepEqual([shown?.cardDisplay, off?.cardDisplay, older?.cardDisplay], ["list", "hidden", "list"]);
	assert.ok(!("showOnCard" in shown!));
});

test("references get arrow, line label and inverse label defaults; labels are trimmed", () => {
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
	const store = createStore(memoryStorage({ "entities-app": JSON.stringify(old) }));
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

test("description: saved on add, kept when an update leaves it out, defaults to empty for older data", () => {
	const storage = memoryStorage();
	const store = createStore(storage);
	const type = store.addType("Note", [], "");
	const note = store.addEntity(type.id, "A", "short", {}, "Long\n\ndetails");
	assert.equal(createStore(storage).data.entities[0]?.description, "Long\n\ndetails");

	store.updateEntity(note.id, "A", "short", {});
	assert.equal(store.data.entities[0]?.description, "Long\n\ndetails");
	store.updateEntity(note.id, "A", "short", {}, "");
	assert.equal(store.data.entities[0]?.description, "");
	assert.equal(store.addEntity(type.id, "B", "", {}).description, "");

	const old = {
		types: [{ id: "n", name: "Note", properties: [] }],
		entities: [{ id: "01ARYZ6S41TSV4RRFFQ69G5FAV", typeId: "n", name: "Old", content: "", values: {} }],
	};
	assert.equal(createStore(memoryStorage({ "entities-app": JSON.stringify(old) })).data.entities[0]?.description, "");
});

test("drawings: added, replaced and removed on their own board", () => {
	const storage = memoryStorage();
	const store = createStore(storage);
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
		createStore(storage).data.boards.map((b) => b.drawings),
		[[{ ...rect, text: "Phase A" }], [arrow]],
	);

	store.removeDrawing(arrow.id);
	assert.deepEqual(store.data.boards[1]?.drawings, []);
	assert.equal(store.data.boards[0]?.drawings.length, 1);
});

test("older boards load without drawings; malformed drawings are dropped", () => {
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
	const [old, mixed] = createStore(memoryStorage({ "entities-app": JSON.stringify(saved) })).data.boards;
	assert.deepEqual(old?.drawings, []);
	assert.deepEqual(
		mixed?.drawings.map((d) => d.id),
		["ok", "pen"],
	);
	// Missing text fields get defaults.
	assert.deepEqual(mixed?.drawings[0], { id: "ok", kind: "ellipse", x: 1, y: 2, width: 3, height: 4, color: "#c4dafa", text: "", textSize: "m" });
});
