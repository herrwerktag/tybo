import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "./store.js";
import { createWorkspaces, dataKey } from "./workspaces.js";

function memoryStorage(initial: Record<string, string> = {}) {
	const map = new Map(Object.entries(initial));
	return {
		map,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
	};
}

const workspaceName = (n: number) => `Workspace ${n}`;

const titleDraft = { name: "title", kind: "text" as const, options: [], reference: null, cardDisplay: "list" as const };

test("the first run creates the default workspace, which opens the data saved before workspaces", () => {
	const storage = memoryStorage();
	const before = createStore(storage, "entities-app");
	before.addType("Book", [], "");

	const workspaces = createWorkspaces(storage, workspaceName);
	assert.deepEqual(workspaces.list, [{ id: "default", name: "Workspace 1" }]);
	assert.equal(workspaces.active.id, "default");
	assert.equal(dataKey("default"), "entities-app");
	assert.deepEqual(
		workspaces.openStore("default").data.types.map((t) => t.name),
		["Book"],
	);
});

test("add, rename and setActive persist; empty names are ignored", () => {
	const storage = memoryStorage();
	const workspaces = createWorkspaces(storage, workspaceName);
	const second = workspaces.add(" Process B ");
	const third = workspaces.add("   ");
	assert.equal(second.name, "Process B");
	assert.equal(third.name, "Workspace 3");

	workspaces.rename(second.id, "Process C");
	workspaces.rename(second.id, "  ");
	workspaces.setActive(second.id);
	workspaces.setActive("unknown");

	const reloaded = createWorkspaces(storage, () => "ignored");
	assert.deepEqual(
		reloaded.list.map((w) => w.name),
		["Workspace 1", "Process C", "Workspace 3"],
	);
	assert.equal(reloaded.active.id, second.id);
});

test("remove deletes the workspace's data, moves the active one and never removes the last", () => {
	const storage = memoryStorage();
	const workspaces = createWorkspaces(storage, workspaceName);
	const second = workspaces.add("B");
	workspaces.openStore(second.id).addType("Note", [], "");
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

test("a new workspace can start with copies of entity types, keeping their ids", () => {
	const storage = memoryStorage();
	const workspaces = createWorkspaces(storage, workspaceName);
	const source = workspaces.openStore("default");
	const person = source.addType("Person", [titleDraft], "");
	const book = source.addType(
		"Book",
		[
			{
				name: "author",
				kind: "reference",
				options: [],
				reference: { typeId: person.id, multiple: false, arrow: "to", lineLabel: "" },
				cardDisplay: "list",
			},
		],
		"",
	);
	source.addEntity(person.id, "Frank", "", {});

	const copy = workspaces.openStore(workspaces.add("Copy", source.data.types).id);
	assert.deepEqual(
		copy.data.types.map((t) => t.id),
		[person.id, book.id],
	);
	assert.equal(copy.data.types[1]?.properties[0]?.reference?.typeId, person.id);
	assert.deepEqual(copy.data.entities, []);
	assert.equal(copy.data.boards.length, 1);
	assert.deepEqual(copy.data.boards[0]?.cards, []);
});

test("workspaces keep their data separate", () => {
	const storage = memoryStorage();
	const workspaces = createWorkspaces(storage, workspaceName);
	const other = workspaces.add("Other");
	workspaces.openStore(other.id).addType("Only here", [], "");
	workspaces.openStore(other.id).addBoard("Extra");

	const first = workspaces.openStore("default");
	assert.deepEqual(first.data.types, []);
	assert.equal(first.data.boards.length, 1);
	assert.deepEqual(
		workspaces.openStore(other.id).data.boards.map((b) => b.name),
		["Board 1", "Extra"],
	);
});
