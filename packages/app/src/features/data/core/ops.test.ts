import assert from "node:assert/strict";
import { test } from "node:test";
import { isUlid } from "../../../shared/core/index.js";
import { TYPE_COLORS } from "../core.js";
import { settle, WS, memoryStorage, open, titleDraft, referenceSetup } from "../../../test-store.js";

test("addEntities adds several entities as one change, keeping the ids given", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const type = store.addType("Book", [titleDraft], "");
	const prop = type.properties[0]!;
	await store.saved();
	const saves = storage.saves.length;

	const [a, b] = store.addEntities([
		{ id: "01JABCDEFGHJKMNPQRSTVWXYZ0", typeId: type.id, name: " A ", content: "", values: { [prop.id]: "A" }, tags: ["x, y"] },
		{ typeId: type.id, name: "B", content: "", values: {} },
	]);
	assert.equal(a!.id, "01JABCDEFGHJKMNPQRSTVWXYZ0");
	assert.equal(a!.name, "A");
	assert.deepEqual(a!.tags, ["x", "y"]);
	assert.ok(isUlid(b!.id));
	await store.saved();
	assert.equal(storage.saves.length, saves + 1);

	assert.ok(store.undo());
	assert.deepEqual(store.data.entities, []);
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

test("moveType and moveEntity reorder; entities move among their type's only, and the order is saved", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const book = store.addType("Book", [], "");
	const film = store.addType("Film", [], "");
	const a = store.addEntity(book.id, "A", "", {});
	const x = store.addEntity(film.id, "X", "", {});
	const b = store.addEntity(book.id, "B", "", {});
	const c = store.addEntity(book.id, "C", "", {});

	store.moveType(film.id, 0);
	assert.deepEqual(store.data.types.map((t) => t.name), ["Film", "Book"]);

	// C goes first among the books; the film X keeps its place in the list.
	store.moveEntity(c.id, 0);
	assert.deepEqual(store.data.entities.map((e) => e.name), ["C", "X", "A", "B"]);
	store.moveEntity(c.id, 2);
	assert.deepEqual(store.data.entities.map((e) => e.name), ["A", "X", "B", "C"]);
	store.moveEntity(a.id, 1);
	assert.deepEqual(store.data.entities.map((e) => e.id), [b.id, x.id, a.id, c.id]);

	const reloaded = await open(storage);
	assert.deepEqual(reloaded.data.types.map((t) => t.name), ["Film", "Book"]);
	assert.deepEqual(reloaded.data.entities.map((e) => e.name), ["B", "X", "A", "C"]);

	assert.ok(store.undo());
	assert.deepEqual(store.data.entities.map((e) => e.name), ["A", "X", "B", "C"]);
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
		{ name: "friend", kind: "reference", options: [], reference: { typeIds: [person.id], multiple: false, required: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
	], "");
	assert.deepEqual(store.typeReferrers(person.id), ["Book.author"]);
	assert.deepEqual(store.typeReferrers(tag.id), ["Book.tags"]);
	assert.deepEqual(store.typeReferrers(book.id), []);
});

test("updateType: changing a reference's target type clears its values", async () => {
	const { store, tag, book, author, tags, dune } = await referenceSetup();
	store.updateType(book.id, "Book", [{ ...author, reference: { typeIds: [tag.id], multiple: false, required: false, arrow: "to", lineLabel: "", inverseLabel: "" } }, tags], "");
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.values[author.id], null);
});

test("reference values persist across store instances", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	const tag = store.addType("Tag", [], "");
	const book = store.addType("Book", [
		{ name: "tags", kind: "reference", options: [], reference: { typeIds: [tag.id], multiple: true, required: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
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
	assert.deepEqual(author.reference, { typeIds: ["p"], multiple: false, required: false, arrow: "to", lineLabel: "", inverseLabel: "" });

	store.updateType(
		"b",
		"Book",
		[{ ...author, reference: { ...author.reference!, required: true, arrow: "from", lineLabel: "  wrote  ", inverseLabel: " author of " } }],
		"",
	);
	assert.deepEqual(store.data.types[1]!.properties[0]!.reference, {
		typeIds: ["p"],
		multiple: false,
		required: true,
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
