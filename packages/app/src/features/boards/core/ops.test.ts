import assert from "node:assert/strict";
import { test } from "node:test";
import type { DraftProperty } from "../../data/core.js";
import { DATA_VERSION, NameTaken } from "../../../shared/core/index.js";
import { memoryStorage, open, assertEmpty, firstBoard, noLists, valueOf } from "../../../test-store.js";
import { REFERENCE_SCREEN } from "./normalize.js";
import { referencesOffBoard } from "./ops.js";

test("moveBoard reorders the boards, and the order is saved", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const second = store.addBoard("Second");
	store.addBoard("Third");

	store.moveBoard(second.id, 0);
	store.moveBoard("unknown", 0);
	assert.deepEqual(store.data.boards.map((b) => b.name), ["Second", "Board 1", "Third"]);

	const reloaded = await open(storage);
	assert.deepEqual(reloaded.data.boards.map((b) => b.name), ["Second", "Board 1", "Third"]);

	assert.ok(store.undo());
	assert.deepEqual(store.data.boards.map((b) => b.name), ["Board 1", "Second", "Third"]);
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

	store.fitCards(new Map([[a1.id, { width: 300, height: 200 }]]));
	store.moveCard(a1.id, 50, 60);

	assert.deepEqual(firstBoard(store).cards, [
		{ id: b1.id, entityId: b.id, x: 30, y: 40, width: 240, height: 168 },
		{ id: a2.id, entityId: a.id, x: 70, y: 80, width: 240, height: 168 },
		{ id: a1.id, entityId: a.id, x: 50, y: 60, width: 300, height: 200 },
	]);
});

/** Book (author: one Person, characters: several Persons) and Person; Dune (tagged Classic) with a card on a board. */
async function linkable() {
	const store = await open(memoryStorage());
	const person = store.addType("Person", [], "## Bio");
	const ref = (name: string, multiple: boolean): DraftProperty => ({
		name,
		kind: "reference",
		options: [],
		reference: { typeIds: [person.id], multiple, required: false, arrow: "to", lineLabel: "", inverseLabel: "" },
		cardDisplay: "line",
	});
	const book = store.addType("Book", [ref("author", false), ref("characters", true)], "");
	const [author, characters] = book.properties;
	const dune = store.addEntity(book.id, "Dune", "", {}, "", ["Classic"]);
	const boardId = firstBoard(store).id;
	const card = store.addCard(boardId, dune.id, 0, 0);
	return { store, person, book, author: author!, characters: characters!, dune, boardId, card };
}

test("addLinkedEntity also goes the other way: the new entity references the card's entity", async () => {
	const { store, book, author } = await linkable();
	const frank = store.addEntity(store.data.types[0]!.id, "Frank", "", {});
	const frankCard = store.addCard(firstBoard(store).id, frank.id, 0, 400);
	// From Frank: a new Book whose author he is.
	const made = store.addLinkedEntity(frankCard.id, { propId: author.id, direction: "inverse" }, book.id, "Children of Dune")!;
	assert.equal(made.entity.typeId, book.id);
	assert.equal(made.entity.values[author.id], frank.id);
	assert.deepEqual([made.card.x, made.card.y], [288, 408], "beside Frank's card, clear of Dune's");
});

test("linkEntity links an existing entity either way, showing its card: the one on the board, or a new one", async () => {
	const { store, book, author, characters, dune, boardId, card } = await linkable();
	const person = store.data.types[0]!;
	const frank = store.addEntity(person.id, "Frank", "", {});
	const paul = store.addEntity(person.id, "Paul", "", {});
	const paulCard = store.addCard(boardId, paul.id, 600, 600);

	const placed = store.linkEntity(card.id, { propId: author.id, direction: "forward" }, frank.id)!;
	assert.equal(valueOf(store, dune.id, author.id), frank.id);
	assert.deepEqual([placed.entityId, placed.x, placed.y], [frank.id, 288, 0], "a new card beside Dune's");
	const shown = store.linkEntity(card.id, { propId: characters.id, direction: "forward" }, paul.id)!;
	assert.equal(shown.id, paulCard.id, "Paul's card on the board");
	assert.equal(firstBoard(store).cards.length, 3, "no new one for Paul");
	assert.equal(store.linkEntity(card.id, { propId: characters.id, direction: "forward" }, paul.id), null, "linked already");

	// From Frank's card: Emma, an existing book, gets him as author.
	const emma = store.addEntity(book.id, "Emma", "", {});
	assert.ok(store.linkEntity(placed.id, { propId: author.id, direction: "inverse" }, emma.id));
	assert.equal(valueOf(store, emma.id, author.id), frank.id);
});

test("addEntityWithCard creates an entity with its card at the first free spot, in one undo step", async () => {
	const { store, person, boardId } = await linkable();
	const made = store.addEntityWithCard(boardId, person.id, " Ada ", { x: 10, y: 10 }, ["Classic", "classic"])!;
	assert.deepEqual([made.entity.name, made.entity.tags, made.entity.description], ["Ada", ["Classic"], "## Bio"]);
	assert.deepEqual([made.card.x, made.card.y], [0, 192], "below Dune's card at 0, 0");
	assert.ok(firstBoard(store).cards.some((c) => c.id === made.card.id));
	store.undo();
	assert.equal(store.data.entities.some((e) => e.id === made.entity.id), false);
});

test("placeCards moves an entity's card that's there and adds the others on top, in one undo step", async () => {
	const store = await open(memoryStorage());
	const note = store.addType("Note", [], "");
	const boardId = firstBoard(store).id;
	const [a, b, c] = ["A", "B", "C"].map((name) => store.addEntity(note.id, name, "", {}));
	const aCard = store.addCard(boardId, a!.id, 0, 0);
	const before = store.data;

	const placed = store.placeCards(boardId, [
		{ entityId: b!.id, x: 48, y: 0 },
		{ entityId: a!.id, x: 24, y: 24 },
		{ entityId: c!.id, x: 96, y: 0 },
		{ entityId: b!.id, x: 48, y: 96 },
	]);
	assert.deepEqual(placed.map((card) => [card.entityId, card.x, card.y]), [[b!.id, 48, 96], [a!.id, 24, 24], [c!.id, 96, 0]], "B where it's given last");
	assert.equal(placed[1]!.id, aCard.id, "A's card moved, none added");
	assert.deepEqual(firstBoard(store).cards.map((card) => card.entityId), [a!.id, b!.id, c!.id]);
	store.undo();
	assert.deepEqual(store.data, before);
	assert.deepEqual(store.placeCards("no-board", [{ entityId: a!.id, x: 0, y: 0 }]), []);
});

test("layOutReferences puts the listed entities off the board around the card: referenced right, referencing left", async () => {
	const store = await open(memoryStorage());
	const person = store.addType("Person", [], "");
	const ref = (name: string, typeId: string, cardDisplay: DraftProperty["cardDisplay"], multiple = false, inverseLabel = ""): DraftProperty => ({
		name,
		kind: "reference",
		options: [],
		reference: { typeIds: [typeId], multiple, required: false, arrow: "to", lineLabel: "", inverseLabel },
		cardDisplay,
	});
	const book = store.addType("Book", [ref("author", person.id, "line"), ref("characters", person.id, "list", true), ref("editor", person.id, "hidden")], "");
	// Only with a label is the other side listed on the card.
	const review = store.addType("Review", [ref("about", book.id, "line", false, "reviewed in")], "");
	const [author, characters, editor] = book.properties.map((p) => p.id);
	const [frank, paul, leto, ed] = ["Frank", "Paul", "Leto", "Ed"].map((name) => store.addEntity(person.id, name, "", {}));
	const dune = store.addEntity(book.id, "Dune", "", { [author!]: frank!.id, [characters!]: [paul!.id, leto!.id], [editor!]: ed!.id });
	const praise = store.addEntity(review.id, "Praise", "", { [review.properties[0]!.id]: dune.id });
	const boardId = firstBoard(store).id;
	const card = store.addCard(boardId, dune.id, 0, 0);
	store.addCard(boardId, paul!.id, 288, 0);

	// Paul is listed but on the board already; Ed isn't listed at all.
	assert.deepEqual(referencesOffBoard(store.data, card.id), { forward: [frank!.id, leto!.id], inverse: [praise.id] });
	const before = store.data;
	const sizes: Record<string, { width: number; height: number }> = {
		[frank!.id]: { width: 240, height: 120 },
		[leto!.id]: { width: 240, height: 168 },
		[praise.id]: { width: 192, height: 96 },
	};
	const placed = store.layOutReferences(card.id, (id) => sizes[id]!);
	assert.deepEqual(
		placed.map(({ entityId, x, y, width, height }) => [entityId, x, y, width, height]),
		[
			[frank!.id, 288, 192, 240, 120], // below Paul's card
			[leto!.id, 288, 336, 240, 168], // below Frank's
			[praise.id, -240, 0, 192, 96], // two grid steps left of Dune's
		],
	);
	assert.equal(firstBoard(store).cards.length, 5);
	assert.deepEqual(referencesOffBoard(store.data, card.id), { forward: [], inverse: [] });
	assert.deepEqual(store.layOutReferences(card.id, (id) => sizes[id]!), [], "nothing left to lay out");

	store.undo();
	assert.deepEqual(store.data, before, "one undo step");
});

test("fitCards saves measured sizes outside the undo history; removeCard removes one card and keeps the entity", async () => {
	const store = await open(memoryStorage());
	const note = store.addType("Note", [], "");
	const a = store.addEntity(note.id, "A", "", {});
	const first = store.addCard(firstBoard(store).id, a.id, 0, 0);
	const second = store.addCard(firstBoard(store).id, a.id, 100, 0);

	store.fitCards(new Map([[first.id, { width: 192, height: 96 }]]));
	assert.deepEqual(firstBoard(store).cards[0], { id: first.id, entityId: a.id, x: 0, y: 0, width: 192, height: 96 });
	store.undo(); // not the measuring, but the change before: adding the second card
	assert.equal(firstBoard(store).cards.length, 1);
	store.redo();

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

test("boards can be added, renamed and deleted, even the last one", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const first = firstBoard(store);
	const second = store.addBoard(" Planning ");
	assert.equal(second.name, "Planning");
	assert.equal(store.addBoard("  ").name, "Board 2", "the first number no board has");

	store.renameBoard(second.id, "Roadmap");
	store.renameBoard(second.id, "   ");
	assert.equal(store.data.boards[1]?.name, "Roadmap");

	store.deleteBoard(second.id);
	store.deleteBoard(store.data.boards[1]!.id);
	assert.deepEqual(
		store.data.boards.map((b) => b.id),
		[first.id],
	);
	store.addEntity(store.addType("Book", [], "").id, "Dune", "", {});
	store.deleteBoard(first.id);
	assert.deepEqual(store.data.boards, []);
	assert.deepEqual((await open(storage)).data.boards, [], "no new first board once there are entities");
});

test("a board may not have the name of another one, ignoring case and spaces", async () => {
	const store = await open(memoryStorage());
	const first = firstBoard(store);
	const second = store.addBoard("Planning");
	assert.throws(() => store.addBoard(" board 1 "), NameTaken);
	assert.throws(() => store.renameBoard(second.id, "BOARD 1"), NameTaken);
	store.renameBoard(first.id, "board 1");
	assert.deepEqual(store.data.boards.map((b) => b.name), ["board 1", "Planning"]);
});

test("boards with the same name from before stay, and can be renamed", async () => {
	const twice = { id: "b1", name: "Plan", cards: [], frames: [] };
	const store = await open(memoryStorage({ version: DATA_VERSION, types: [], entities: [], boards: [twice, { ...twice, id: "b2" }] }));
	assert.deepEqual(store.data.boards.map((b) => b.name), ["Plan", "Plan"]);
	store.renameBoard("b2", "Plan B");
	assert.deepEqual(store.data.boards.map((b) => b.name), ["Plan", "Plan B"]);
});

test("a new workspace starts with a first board, also when it got copies of entity types", async () => {
	const store = await open(memoryStorage({ version: DATA_VERSION, types: [{ id: "b", name: "Book", properties: [] }], entities: [], boards: [] }));
	assert.deepEqual(store.data.boards.map((b) => b.name), ["Board 1"]);
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
	store.fitCards(new Map([[onTwo.id, { width: 400, height: 300 }]]));
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

test("stories saved before version 8 are left out; a board saved before frames gets its frame of its pan/zoom", async () => {
	const saved = {
		version: 5,
		types: [],
		entities: [],
		boards: [
			{
				id: "b",
				name: "Flow",
				cards: [],
				viewport: { x: -100, y: 50, zoom: 2 },
				drawings: [],
				story: true,
				pages: [{ id: "p", cardIds: [] }],
				stories: [{ id: "s", name: "One", pages: [{ id: "q", cardIds: [] }] }],
			},
			{
				id: "c",
				name: "Framed",
				cards: [],
				viewport: { x: 0, y: 0, zoom: 1 },
				viewFrame: { x: 10, y: 20, width: 320, height: 180 },
				drawings: [],
				frames: [{ id: "f", name: "F", x: 0, y: 0, width: 320, height: 180 }],
				stories: [],
			},
		],
	};
	const [board, framed] = (await open(memoryStorage(saved))).data.boards;
	const { width, height } = REFERENCE_SCREEN;
	// The board's frame shows what its pan/zoom did (the viewer showed the board so).
	assert.deepEqual(board, {
		id: "b",
		name: "Flow",
		cards: [],
		viewport: { x: -100, y: 50, zoom: 2 },
		viewFrame: { x: 50, y: -25, width: width / 2, height: height / 2 },
		...noLists,
	});
	assert.deepEqual(framed, {
		id: "c",
		name: "Framed",
		cards: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		viewFrame: { x: 10, y: 20, width: 320, height: 180 },
		...noLists,
	});
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

test("addLinkedEntity creates an entity the card's entity references, with its card beside it, in one undo step", async () => {
	const { store, person, author, characters, dune, card } = await linkable();
	const made = store.addLinkedEntity(card.id, { propId: author.id, direction: "forward" }, person.id, " Frank Herbert ")!;
	assert.deepEqual(
		{ ...made.entity, id: "" },
		{ id: "", typeId: person.id, name: "Frank Herbert", content: "", description: "## Bio", tags: ["Classic"], values: {} },
	);
	assert.equal(valueOf(store, dune.id, author.id), made.entity.id);
	assert.deepEqual([made.card.entityId, made.card.x, made.card.y], [made.entity.id, 288, 0]);
	assert.deepEqual(firstBoard(store).cards.map((c) => c.id), [card.id, made.card.id]);

	// The author is set now: a second one doesn't fit (nothing changes).
	assert.equal(store.addLinkedEntity(card.id, { propId: author.id, direction: "forward" }, person.id, "Other"), null);
	// A reference allowing several gets one more; the next card goes below the first one.
	const paul = store.addLinkedEntity(card.id, { propId: characters.id, direction: "forward" }, person.id, "Paul")!;
	assert.deepEqual(valueOf(store, dune.id, characters.id), [paul.entity.id]);
	assert.deepEqual([paul.card.x, paul.card.y], [288, 192]);
	assert.equal(store.data.entities.length, 3);

	store.undo();
	assert.equal(store.data.entities.some((e) => e.id === paul.entity.id), false);
	assert.equal(valueOf(store, dune.id, characters.id), undefined);
	assert.equal(firstBoard(store).cards.length, 2);
});
