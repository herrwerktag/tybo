import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION, createStore } from "./store.js";
import { createWorkspaces, dataKey, exportWorkspace, readWorkspaceFile } from "./workspaces.js";

function memoryStorage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial));
	return {
		map,
		getItem: async (key: string) => map.get(key) ?? null,
		setItem: async (key: string, value: string) => void map.set(key, value),
		removeItem: async (key: string) => void map.delete(key),
	};
}

const workspaceName = (n: number) => `Workspace ${n}`;

const titleDraft = { name: "title", kind: "text" as const, options: [], reference: null, cardDisplay: "list" as const };

test("the first run creates the default workspace, which opens the data saved before workspaces", async () => {
	const storage = memoryStorage();
	const before = await createStore(storage, "entities-app");
	before.addType("Book", [], "");

	const workspaces = await createWorkspaces(storage, workspaceName);
	assert.deepEqual(workspaces.list, [{ id: "default", name: "Workspace 1" }]);
	assert.equal(workspaces.active.id, "default");
	assert.equal(dataKey("default"), "entities-app");
	assert.deepEqual(
		(await workspaces.openStore("default")).data.types.map((t) => t.name),
		["Book"],
	);
});

test("add, rename and setActive persist; empty names are ignored", async () => {
	const storage = memoryStorage();
	const workspaces = await createWorkspaces(storage, workspaceName);
	const second = await workspaces.add(" Process B ");
	const third = await workspaces.add("   ");
	assert.equal(second.name, "Process B");
	assert.equal(third.name, "Workspace 3");

	workspaces.rename(second.id, "Process C");
	workspaces.rename(second.id, "  ");
	workspaces.setActive(second.id);
	workspaces.setActive("unknown");

	const reloaded = await createWorkspaces(storage, () => "ignored");
	assert.deepEqual(
		reloaded.list.map((w) => w.name),
		["Workspace 1", "Process C", "Workspace 3"],
	);
	assert.equal(reloaded.active.id, second.id);
});

test("remove deletes the workspace's data, moves the active one and never removes the last", async () => {
	const storage = memoryStorage();
	const workspaces = await createWorkspaces(storage, workspaceName);
	const second = await workspaces.add("B");
	(await workspaces.openStore(second.id)).addType("Note", [], "");
	workspaces.setActive(second.id);
	assert.ok(storage.map.has(dataKey(second.id)));

	workspaces.remove(second.id);
	assert.ok(!storage.map.has(dataKey(second.id)));
	assert.equal(workspaces.active.id, "default");

	workspaces.remove("default");
	assert.deepEqual(
		workspaces.list.map((w) => w.id),
		["default"],
	);
});

test("a new workspace can start with copies of entity types, keeping their ids", async () => {
	const storage = memoryStorage();
	const workspaces = await createWorkspaces(storage, workspaceName);
	const source = await workspaces.openStore("default");
	const person = source.addType("Person", [titleDraft], "");
	const book = source.addType(
		"Book",
		[
			{
				name: "author",
				kind: "reference",
				options: [],
				reference: { typeId: person.id, multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" },
				cardDisplay: "list",
			},
		],
		"",
	);
	source.addEntity(person.id, "Frank", "", {});

	const copy = await workspaces.openStore((await workspaces.add("Copy", source.data.types)).id);
	assert.deepEqual(
		copy.data.types.map((t) => t.id),
		[person.id, book.id],
	);
	assert.equal(copy.data.types[1]?.properties[0]?.reference?.typeId, person.id);
	assert.deepEqual(copy.data.entities, []);
	assert.equal(copy.data.boards.length, 1);
	assert.equal(JSON.parse(storage.map.get(dataKey(workspaces.list[1]!.id))!).version, DATA_VERSION);
	assert.deepEqual(copy.data.boards[0]?.cards, []);
});

test("workspaces keep their data separate", async () => {
	const storage = memoryStorage();
	const workspaces = await createWorkspaces(storage, workspaceName);
	const other = await workspaces.add("Other");
	(await workspaces.openStore(other.id)).addType("Only here", [], "");
	(await workspaces.openStore(other.id)).addBoard("Extra");

	const first = await workspaces.openStore("default");
	assert.deepEqual(first.data.types, []);
	assert.equal(first.data.boards.length, 1);
	assert.deepEqual(
		(await workspaces.openStore(other.id)).data.boards.map((b) => b.name),
		["Board 1", "Extra"],
	);
});

test("an exported workspace imports as a new one with the same data; the others stay untouched", async () => {
	const storage = memoryStorage();
	const workspaces = await createWorkspaces(storage, workspaceName);
	const source = await workspaces.openStore("default");
	const book = source.addType("Book", [titleDraft], "");
	const dune = source.addEntity(book.id, "Dune", "Spice", { [book.properties[0]!.id]: "Dune" });
	source.addCard(source.data.boards[0]!.id, dune.id, 10, 20);

	const file = readWorkspaceFile(exportWorkspace("Library", source.data));
	assert.equal(file?.name, "Library");
	const imported = await workspaces.addImported(file!.name ?? "", file!.data);
	assert.equal(imported?.name, "Library");
	assert.deepEqual(
		workspaces.list.map((w) => w.name),
		["Workspace 1", "Library"],
	);
	const store = await workspaces.openStore(imported!.id);
	assert.deepEqual(store.data, source.data);
	assert.equal(store.problems.load, null);
	assert.equal(file!.data && (file!.data as { version?: unknown }).version, DATA_VERSION);
});

test("workspace files: plain saved data is accepted too; anything else is rejected", () => {
	const data = { types: [], entities: [], boards: [] };
	assert.deepEqual(readWorkspaceFile(JSON.stringify(data)), { name: null, data });
	assert.equal(readWorkspaceFile("{not json"), null);
	assert.equal(readWorkspaceFile('{"hello":1}'), null);
	assert.equal(readWorkspaceFile(JSON.stringify({ format: "entities-app-workspace", version: 1, name: "X", data: {} })), null);
});

test("importing damaged data repairs and backs it up; with storage full nothing is added", async () => {
	const storage = memoryStorage();
	const workspaces = await createWorkspaces(storage, workspaceName);
	const damaged = { types: [{ id: "t", name: "Book", properties: [] }, "bad"], entities: [] };
	const store = await workspaces.openStore((await workspaces.addImported("Damaged", damaged))!.id);
	assert.deepEqual(
		store.data.types.map((t) => t.name),
		["Book"],
	);
	assert.equal(store.problems.load?.code, "partlyUnreadable");

	const full = { ...memoryStorage(), setItem: () => {
		throw new Error("quota");
	} };
	const blocked = await createWorkspaces(full, workspaceName);
	assert.equal(await blocked.addImported("X", { types: [], entities: [] }), null);
	assert.equal(blocked.list.length, 1);
});

test("works without crypto.randomUUID, which browsers only offer on HTTPS and localhost", async () => {
	Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
	try {
		const workspaces = await createWorkspaces(memoryStorage(), workspaceName);
		const store = await workspaces.openStore((await workspaces.add("Plain HTTP")).id);
		const type = store.addType("Book", [titleDraft], "");
		const entity = store.addEntity(type.id, "Dune", "", {});
		const board = store.addBoard("Second");
		store.addCard(board.id, entity.id, 0, 0);
		store.addDrawing(board.id, { kind: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: "#4a4a4a" });
		assert.equal(store.data.boards[1]?.drawings.length, 1);
	} finally {
		delete (crypto as { randomUUID?: unknown }).randomUUID; // the prototype's method shows through again
	}
	assert.equal(typeof crypto.randomUUID, "function");
});

test("reload picks up another tab's workspaces but keeps this tab's own, unless it was deleted there", async () => {
	const storage = memoryStorage();
	const here = await createWorkspaces(storage, workspaceName);
	const otherTab = await createWorkspaces(storage, workspaceName);
	const second = await otherTab.add("Second");
	otherTab.setActive(second.id);

	await here.reload();
	assert.deepEqual(here.list.map((w) => w.name), ["Workspace 1", "Second"]);
	assert.equal(here.active.id, "default");

	here.setActive(second.id);
	await otherTab.reload();
	otherTab.remove(second.id);
	await here.reload();
	assert.deepEqual(here.list.map((w) => w.id), ["default"]);
	assert.equal(here.active.id, "default");
});
