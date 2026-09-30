import assert from "node:assert/strict";
import { test } from "node:test";
import type { DraftProperty } from "./model.js";
import { createStore } from "./store.js";
import { isUlid } from "./ulid.js";

function memoryStorage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
	};
}

const titleDraft: DraftProperty = { name: "title", kind: "text", options: [], reference: null };

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
	const book = store.addType("Book", [titleDraft, { name: "status", kind: "options", options: ["Draft", "Published"], reference: null }], "");
	const film = store.addType("Film", [titleDraft], "");
	const title = book.properties[0]!;
	const status = book.properties[1]!;
	const draft = store.addEntity(book.id, "Dune", "", { [title.id]: "Dune", [status.id]: "Draft" });
	const published = store.addEntity(book.id, "Emma", "", { [title.id]: "Emma", [status.id]: "Published" });
	const movie = store.addEntity(film.id, "Alien", "", { [film.properties[0]!.id]: "Alien" });

	store.updateType(book.id, "Novel", [
		{ ...title, name: "name" },
		{ ...status, options: ["Published"] },
		{ name: "author", kind: "text", options: [], reference: null },
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
	assert.deepEqual(createStore(memoryStorage({ "entities-app": "{not json" })).data, { types: [], entities: [] });
	assert.deepEqual(createStore(memoryStorage({ "entities-app": '{"types":1}' })).data, { types: [], entities: [] });

	const throwing = {
		getItem: () => {
			throw new Error("blocked");
		},
		setItem: () => {
			throw new Error("blocked");
		},
	};
	const store = createStore(throwing);
	assert.deepEqual(store.data, { types: [], entities: [] });
	store.addType("Book", [titleDraft], "");
	assert.equal(store.data.types.length, 1);
});

function referenceSetup() {
	const store = createStore(memoryStorage());
	const person = store.addType("Person", [], "");
	const tag = store.addType("Tag", [], "");
	const book = store.addType("Book", [
		{ name: "author", kind: "reference", options: [], reference: { typeId: person.id, multiple: false } },
		{ name: "tags", kind: "reference", options: [], reference: { typeId: tag.id, multiple: true } },
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
		{ name: "friend", kind: "reference", options: [], reference: { typeId: person.id, multiple: false } },
	], "");
	assert.deepEqual(store.typeReferrers(person.id), ["Book.author"]);
	assert.deepEqual(store.typeReferrers(tag.id), ["Book.tags"]);
	assert.deepEqual(store.typeReferrers(book.id), []);
});

test("updateType: changing a reference's target type clears its values", () => {
	const { store, tag, book, author, tags, dune } = referenceSetup();
	store.updateType(book.id, "Book", [{ ...author, reference: { typeId: tag.id, multiple: false } }, tags], "");
	assert.equal(store.data.entities.find((e) => e.id === dune.id)?.values[author.id], null);
});

test("reference values persist across store instances", () => {
	const storage = memoryStorage();
	const store = createStore(storage);
	const tag = store.addType("Tag", [], "");
	const book = store.addType("Book", [
		{ name: "tags", kind: "reference", options: [], reference: { typeId: tag.id, multiple: true } },
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
