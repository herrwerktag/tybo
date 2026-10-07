import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changesBetween, type AppData } from "@bekbon/core";
import { sqliteStorage } from "./sqlite.js";
import { call, startApp } from "./test-server.js";

/** A state with every kind of unit: a type with a property, an entity with a value, a board in story mode
 * with a card, a drawing placed from the library, and that library drawing. */
function sample(): AppData {
	return {
		types: [
			{
				id: "type-1",
				name: "Person",
				properties: [{ id: "prop-1", name: "Notiz", kind: "text", options: [], reference: null, cardDisplay: "list" }],
				contentTemplate: "",
				color: "#c4dafa",
			},
		],
		entities: [{ id: "ent-1", typeId: "type-1", name: "Ada", content: "", description: "", values: { "prop-1": "hier" } }],
		boards: [
			{
				id: "board-1",
				name: "Brett",
				cards: [{ id: "card-1", entityId: "ent-1", x: 1.25, y: -2, width: 240, height: 160 }],
				viewport: { x: 0, y: 0, zoom: 1.5 },
				drawings: [{ id: "draw-star", kind: "symbol", libraryId: "lib-star", x: 40, y: 40.5, width: 96, height: 48 }],
				story: true,
				pages: [],
			},
		],
		library: [{ id: "lib-star", name: "Stern", tags: ["Form"], drawings: [{ id: "lib-rect", kind: "rect", x: 0, y: 0, width: 20, height: 10.5, color: "#f6e8a6", text: "★", textSize: "l" }] }],
	};
}

const empty = (): AppData => ({ types: [], entities: [], boards: [], library: [] });

/** A storage on a fresh file of its own; close() closes it and removes the file. */
async function fresh() {
	const dir = mkdtempSync(join(tmpdir(), "bekbon-sqlite-"));
	const path = join(dir, "test.sqlite");
	const storage = sqliteStorage(path);
	return {
		storage,
		path,
		close: async () => {
			await storage.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("sqlite: the schema is made once, and survives reopening the file", async () => {
	const { storage, path, close } = await fresh();
	try {
		assert.deepEqual(await storage.init(), [1]);
		assert.deepEqual(await storage.init(), [], "the second start has nothing left to do");
		assert.equal(await storage.healthy(), true);
		await storage.createWorkspace({ id: "ws", name: "Bleibt" }, 1);
		await storage.close();

		const again = sqliteStorage(path);
		assert.deepEqual(await again.init(), []);
		assert.deepEqual(await again.listWorkspaces(), [{ id: "ws", name: "Bleibt" }]);
		await again.close();
	} finally {
		await close().catch(() => {});
	}
});

test("sqlite: a workspace is made empty, saved, read back as saved, renamed and deleted with its rows", async () => {
	const { storage, close } = await fresh();
	try {
		await storage.init();
		assert.equal(await storage.createWorkspace({ id: "ws", name: "Erst" }, 1), true);
		assert.equal(await storage.createWorkspace({ id: "ws", name: "Noch mal" }, 1), false, "an id is made once");
		assert.deepEqual(await storage.readWorkspace("ws"), { data: { version: 1, ...empty() }, revision: "0" });

		assert.deepEqual(await storage.writeChanges("ws", changesBetween(empty(), sample())), { version: "1", collided: [] });
		assert.deepEqual(await storage.readWorkspace("ws"), { data: { version: 1, ...sample() }, revision: "1" });
		assert.deepEqual(await storage.writeChanges("ws", []), { version: "1", collided: [] }, "nothing to write moves nothing");

		assert.equal(await storage.renameWorkspace("ws", "Umbenannt"), true);
		assert.equal(await storage.renameWorkspace("none", "Niemand"), false);
		assert.deepEqual(await storage.listWorkspaces(), [{ id: "ws", name: "Umbenannt" }]);

		// Deleting the type takes its entity, the entity's card and value with it.
		const withoutType = { ...sample(), types: [], entities: [], boards: [{ ...sample().boards[0]!, cards: [] }] };
		await storage.writeChanges("ws", changesBetween(sample(), { ...sample(), types: [] }).filter((c) => c.kind === "type"));
		assert.deepEqual((await storage.readWorkspace("ws"))?.data, { version: 1, ...withoutType });

		await storage.deleteWorkspace("ws");
		assert.equal(await storage.readWorkspace("ws"), null);
		assert.equal(await storage.workspaceRevision("ws"), null);
		assert.equal(await storage.writeChanges("ws", changesBetween(empty(), sample())), null, "no workspace, nothing written");
	} finally {
		await close();
	}
});

test("sqlite: the same unit from two sides is reported as collided, and the last save wins", async () => {
	const { storage, close } = await fresh();
	try {
		await storage.init();
		await storage.createWorkspace({ id: "ws", name: "Test" }, 1);
		const base = sample();
		await storage.writeChanges("ws", changesBetween(empty(), base));

		const mine = structuredClone(base);
		mine.entities[0]!.values = { "prop-1": "von A" };
		const theirs = structuredClone(base);
		theirs.entities[0]!.values = { "prop-1": "von B" };

		assert.deepEqual(await storage.writeChanges("ws", changesBetween(base, mine)), { version: "2", collided: [] });
		assert.deepEqual(await storage.writeChanges("ws", changesBetween(base, theirs)), { version: "3", collided: ["ent-1"] });
		assert.deepEqual((await storage.readWorkspace("ws"))?.data, { version: 1, ...theirs });
	} finally {
		await close();
	}
});

test("sqlite: a change set the tables refuse writes nothing half — 503 over HTTP, data and version as they were", async () => {
	const { storage, close } = await fresh();
	await storage.init();
	const api = await startApp(storage);
	try {
		await storage.createWorkspace({ id: "ws", name: "Test" }, 1);
		await storage.writeChanges("ws", changesBetween(empty(), sample()));

		const refused = await call(api.url, "workspaces/ws/changes", {
			method: "PUT",
			body: JSON.stringify([
				{ kind: "entity", id: "ent-2", before: null, after: { value: { id: "ent-2", typeId: "type-1", name: "Bob", content: "", description: "", values: {} }, position: 1 } },
				{ kind: "card", id: "card-dream", boardId: "board-1", before: null, after: { value: { id: "card-dream", entityId: "ent-gone", x: 0, y: 0, width: 10, height: 10 }, position: 1 } },
			]),
		});
		assert.equal(refused.status, 503);

		const got = await call(api.url, "workspaces/ws/data");
		assert.deepEqual(JSON.parse(got.text), { version: 1, ...sample() });
		assert.equal(got.header("etag"), "1");
	} finally {
		await api.close();
		await close();
	}
});
