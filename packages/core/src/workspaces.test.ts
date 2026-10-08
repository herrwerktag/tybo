import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryDataPort } from "./memory-port.js";
import { DATA_VERSION } from "./store.js";
import { createWorkspaces, exportWorkspace, readWorkspaceFile, type ActiveWorkspacePreference } from "./workspaces.js";

/** Lets background saves finish (a store's saves go out after the change that made them). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

/** A remembered active workspace, the way the browser remembers it per tab's preferences. */
function rememberedActive(initial: string | null = null): ActiveWorkspacePreference & { value: string | null } {
	return {
		value: initial,
		read() {
			return this.value;
		},
		write(id) {
			this.value = id;
		},
	};
}

const workspaceName = (n: number) => `Workspace ${n}`;

const titleDraft = { name: "title", kind: "text" as const, options: [], reference: null, cardDisplay: "list" as const };

test("the first run makes the first workspace; a storage that has some opens them", async () => {
	const storage = memoryDataPort();
	const workspaces = await createWorkspaces(storage.port, workspaceName, rememberedActive());
	assert.equal(workspaces.list.length, 1);
	const first = workspaces.list[0]!;
	assert.equal(first.name, "Workspace 1");
	assert.equal(workspaces.active.id, first.id);
	assert.equal(storage.name(first.id), "Workspace 1");
	assert.deepEqual(storage.data(first.id), { version: DATA_VERSION, types: [], entities: [], boards: [] });

	// The next start finds it: nothing more is made.
	const again = await createWorkspaces(storage.port, workspaceName, rememberedActive());
	assert.deepEqual(again.list, [first]);
});

test("without a storage that lists the workspaces, there's nothing to open — it rejects", async () => {
	const storage = memoryDataPort();
	storage.failing.workspaces = true;
	await assert.rejects(createWorkspaces(storage.port, workspaceName, rememberedActive()));
});

test("add and rename reach the storage; setActive is remembered; empty names are ignored", async () => {
	const storage = memoryDataPort();
	const preference = rememberedActive();
	const workspaces = await createWorkspaces(storage.port, workspaceName, preference);
	const second = (await workspaces.add(" Process B "))!;
	const third = (await workspaces.add("   "))!;
	assert.equal(second.name, "Process B");
	assert.equal(third.name, "Workspace 3");

	workspaces.rename(second.id, "Process C");
	workspaces.rename(second.id, "  ");
	workspaces.setActive(second.id);
	workspaces.setActive("unknown");
	assert.equal(preference.value, second.id);
	await settle();

	const reloaded = await createWorkspaces(storage.port, () => "ignored", preference);
	assert.deepEqual(
		reloaded.list.map((w) => w.name),
		["Workspace 1", "Process C", "Workspace 3"],
	);
	assert.equal(reloaded.active.id, second.id);

	// A remembered workspace that's gone opens the first.
	const elsewhere = await createWorkspaces(storage.port, workspaceName, rememberedActive("gone"));
	assert.equal(elsewhere.active.id, reloaded.list[0]!.id);
});

test("remove deletes the workspace with its data, moves the active one and never removes the last", async () => {
	const storage = memoryDataPort();
	const workspaces = await createWorkspaces(storage.port, workspaceName, rememberedActive());
	const first = workspaces.active.id;
	const second = (await workspaces.add("B"))!;
	(await workspaces.openStore(second.id)).addType("Note", [], "");
	workspaces.setActive(second.id);
	await settle();
	assert.ok(storage.data(second.id));

	workspaces.remove(second.id);
	await settle();
	assert.equal(storage.data(second.id), undefined);
	assert.equal(workspaces.active.id, first);

	workspaces.remove(first);
	assert.deepEqual(
		workspaces.list.map((w) => w.id),
		[first],
	);
});

test("a workspace that can't be made isn't added", async () => {
	const storage = memoryDataPort();
	const workspaces = await createWorkspaces(storage.port, workspaceName, rememberedActive());
	storage.failing.workspaces = true;
	assert.equal(await workspaces.add("X"), null);
	assert.equal(workspaces.list.length, 1);

	// Made, but its data didn't make it in: it isn't kept half-filled either.
	storage.failing.workspaces = false;
	storage.failing.saves = true;
	assert.equal(await workspaces.addImported("Y", { types: [{ id: "t", name: "Book", properties: [] }], entities: [] }), null);
	assert.equal(workspaces.list.length, 1);
	assert.equal((await storage.port.listWorkspaces()).length, 1);
});

test("a new workspace can start with copies of entity types, keeping their ids", async () => {
	const storage = memoryDataPort();
	const workspaces = await createWorkspaces(storage.port, workspaceName, rememberedActive());
	const source = await workspaces.openStore(workspaces.active.id);
	const person = source.addType("Person", [titleDraft], "");
	const book = source.addType(
		"Book",
		[
			{
				name: "author",
				kind: "reference",
				options: [],
				reference: { typeIds: [person.id], multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" },
				cardDisplay: "list",
			},
		],
		"",
	);
	source.addEntity(person.id, "Frank", "", {});

	const added = (await workspaces.add("Copy", source.data.types))!;
	const copy = await workspaces.openStore(added.id);
	assert.deepEqual(
		copy.data.types.map((t) => t.id),
		[person.id, book.id],
	);
	assert.deepEqual(copy.data.types[1]?.properties[0]?.reference?.typeIds, [person.id]);
	assert.deepEqual(copy.data.entities, []);
	assert.equal(copy.data.boards.length, 1);
	assert.deepEqual(copy.data.boards[0]?.cards, []);
	assert.equal(storage.data(added.id)!.version, DATA_VERSION);
});

test("workspaces keep their data separate", async () => {
	const storage = memoryDataPort();
	const workspaces = await createWorkspaces(storage.port, workspaceName, rememberedActive());
	const first = workspaces.active.id;
	const other = (await workspaces.add("Other"))!;
	const store = await workspaces.openStore(other.id);
	store.addType("Only here", [], "");
	store.addBoard("Extra");
	await settle();

	const firstStore = await workspaces.openStore(first);
	assert.deepEqual(firstStore.data.types, []);
	assert.equal(firstStore.data.boards.length, 1);
	assert.deepEqual(
		(await workspaces.openStore(other.id)).data.boards.map((b) => b.name),
		["Board 1", "Extra"],
	);
});

test("an exported workspace imports as a new one with the same data; the others stay untouched", async () => {
	const storage = memoryDataPort();
	const workspaces = await createWorkspaces(storage.port, workspaceName, rememberedActive());
	const source = await workspaces.openStore(workspaces.active.id);
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

test("importing damaged data keeps what can be read; data from a newer version isn't imported", async () => {
	const storage = memoryDataPort();
	const workspaces = await createWorkspaces(storage.port, workspaceName, rememberedActive());
	const damaged = { types: [{ id: "t", name: "Book", properties: [] }, "bad"], entities: [] };
	const store = await workspaces.openStore((await workspaces.addImported("Damaged", damaged))!.id);
	assert.deepEqual(
		store.data.types.map((t) => t.name),
		["Book"],
	);
	assert.equal(store.problems.load, null);

	assert.equal(await workspaces.addImported("Newer", { version: DATA_VERSION + 1, types: [], entities: [] }), null);
	assert.equal(workspaces.list.length, 2);
});

test("reload picks up another tab's workspaces but keeps this tab's own, unless it was deleted there", async () => {
	const storage = memoryDataPort();
	const here = await createWorkspaces(storage.port, workspaceName, rememberedActive());
	const first = here.active.id;
	const otherTab = await createWorkspaces(storage.port, workspaceName, rememberedActive());
	const second = (await otherTab.add("Second"))!;
	otherTab.setActive(second.id);

	await here.reload();
	assert.deepEqual(here.list.map((w) => w.name), ["Workspace 1", "Second"]);
	assert.equal(here.active.id, first);

	here.setActive(second.id);
	await otherTab.reload();
	otherTab.remove(second.id);
	await settle();
	await here.reload();
	assert.deepEqual(here.list.map((w) => w.id), [first]);
	assert.equal(here.active.id, first);
});
