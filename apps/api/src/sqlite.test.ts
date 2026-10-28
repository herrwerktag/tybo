import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changesBetween, type AppData } from "@tybo/core";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_MIGRATIONS, sqliteStorage } from "./sqlite.js";
import { call, startApp } from "./test-server.js";

/** A state with every kind of unit: a type with a property, an entity with a value, a board with a card, a
 * text box. */
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
		entities: [{ id: "ent-1", typeId: "type-1", name: "Ada", content: "", description: "", tags: ["Analytik", "Pionierin"], values: { "prop-1": "hier" } }],
		boards: [
			{
				id: "board-1",
				name: "Brett",
				cards: [{ id: "card-1", entityId: "ent-1", x: 1.25, y: -2, width: 240, height: 160 }],
				viewport: { x: 0, y: 0, zoom: 1.5 },
				viewFrame: { x: -12.5, y: 0, width: 1280, height: 720 },
				drawings: [{ id: "draw-star", kind: "textbox", x: 40, y: 40.5, width: 96, height: 48, color: "#f6e8a6", text: "★", textSize: "l" }],
			},
		],
		analyses: [{ id: "ana-1", name: "Rollen", typeId: null, groups: [[{ propertyId: "gone", direction: "inverse" }]], columns: [[]] }],
	};
}

const empty = (): AppData => ({ types: [], entities: [], boards: [], analyses: [] });

/** A storage on a fresh file of its own; close() closes it and removes the file. */
async function fresh() {
	const dir = mkdtempSync(join(tmpdir(), "tybo-sqlite-"));
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
		assert.deepEqual(await storage.init(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
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

		await storage.createWorkspace({ id: "ws-2", name: "Zweit" }, 1);
		await storage.createWorkspace({ id: "ws-3", name: "Dritt" }, 1);
		assert.equal(await storage.moveWorkspace("ws-3", 0), true);
		assert.equal(await storage.moveWorkspace("none", 0), false);
		assert.deepEqual((await storage.listWorkspaces()).map((w) => w.id), ["ws-3", "ws", "ws-2"]);
		await storage.deleteWorkspace("ws-2");
		await storage.deleteWorkspace("ws-3");

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
		assert.equal((await storage.readHistory("ws", { limit: 100 })).filter((e) => e.revision === "2").length, 0, "no history of what wasn't written");

		const got = await call(api.url, "workspaces/ws/data");
		assert.deepEqual(JSON.parse(got.text), { version: 1, ...sample() });
		assert.equal(got.header("etag"), "1");
	} finally {
		await api.close();
		await close();
	}
});

test("sqlite: what was saved of stories, by any version before, is dropped; the board's frame reads as null", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tybo-sqlite-"));
	const path = join(dir, "test.sqlite");
	try {
		// A file as an old version made it: steps on boards, in story mode or not.
		const db = new DatabaseSync(path);
		for (const migration of SQLITE_MIGRATIONS.slice(0, 2)) migration.up(db);
		db.exec("pragma user_version = 2");
		db.exec("insert into workspaces (id, position, name, data_version) values ('ws', 0, 'Alt', 4)");
		const insert = db.prepare("insert into boards (workspace_id, id, position, name, viewport, story, pages) values ('ws', ?, ?, ?, null, ?, ?)");
		insert.run("on", 0, "An", 1, JSON.stringify([{ id: "p1", name: "Eins" }]));
		insert.run("null", 1, "Leer", null, null);
		db.close();

		const storage = sqliteStorage(path);
		assert.deepEqual(await storage.init(), [3, 4, 5, 6, 7, 8, 9]);
		const { data } = (await storage.readWorkspace("ws"))!;
		// Null, not missing: the app makes the frame of the board's pan/zoom.
		assert.deepEqual(
			data.boards.map((b) => [b.id, b.viewFrame, Object.keys(b).sort()]),
			[
				["on", null, ["cards", "drawings", "id", "name", "viewFrame", "viewport"]],
				["null", null, ["cards", "drawings", "id", "name", "viewFrame", "viewport"]],
			],
		);
		await storage.close();
		const columns = (new DatabaseSync(path).prepare("pragma table_info(boards)").all() as { name: string }[]).map((c) => c.name);
		assert.deepEqual(columns.sort(), ["id", "name", "position", "updated_at", "view_frame", "viewport", "workspace_id"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sqlite: step 8 drops the library and the library drawings placed on boards; other drawings stay", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tybo-sqlite-"));
	const path = join(dir, "test.sqlite");
	try {
		const db = new DatabaseSync(path);
		for (const migration of SQLITE_MIGRATIONS.slice(0, 7)) migration.up(db);
		db.exec("pragma user_version = 7");
		db.exec("insert into workspaces (id, position, name, data_version) values ('ws', 0, 'Alt', 8)");
		db.exec("insert into boards (workspace_id, id, position, name) values ('ws', 'b', 0, 'Flow')");
		const insert = db.prepare("insert into drawings (workspace_id, id, board_id, position, kind, body) values ('ws', ?, 'b', ?, ?, ?)");
		insert.run("box", 0, "textbox", JSON.stringify({ id: "box", kind: "textbox" }));
		insert.run("placed", 1, "symbol", JSON.stringify({ id: "placed", kind: "symbol", libraryId: "lib" }));
		db.exec("insert into library_drawings (workspace_id, id, position, name) values ('ws', 'lib', 0, 'Stern')");
		db.close();

		const storage = sqliteStorage(path);
		assert.deepEqual(await storage.init(), [8, 9]);
		await storage.close();
		const check = new DatabaseSync(path);
		assert.deepEqual(check.prepare("select name from sqlite_master where name = 'library_drawings'").all(), []);
		assert.deepEqual(check.prepare("select id from drawings").all().map((row) => row.id), ["box"]);
		check.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sqlite: step 5 gives boards their own frame, whichever form step 4 ran in", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tybo-sqlite-"));
	try {
		for (const brief of [false, true]) {
			const db = new DatabaseSync(join(dir, `${brief}.sqlite`));
			for (const migration of SQLITE_MIGRATIONS.slice(0, brief ? 3 : 4)) migration.up(db);
			// As step 4 briefly was: with `view_frame` already.
			if (brief) db.exec("alter table boards add column view_frame text; alter table boards add column frames text;");
			SQLITE_MIGRATIONS[4]!.up(db);
			const columns = (db.prepare("pragma table_info(boards)").all() as { name: string }[]).map((c) => c.name).filter((name) => name.includes("frame"));
			assert.deepEqual(columns.sort(), ["frames", "view_frame"]);
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sqlite: every write goes into the history, newest first, with the stand that was really written over", async () => {
	const { storage, close } = await fresh();
	try {
		await storage.init();
		await storage.createWorkspace({ id: "ws", name: "Erst" }, 1, "demo");
		const base = sample();
		await storage.writeChanges("ws", changesBetween(empty(), base), "demo");
		await storage.writeChanges("ws", [], "demo");

		const mine = structuredClone(base);
		mine.entities[0]!.name = "Ada A";
		const theirs = structuredClone(base);
		theirs.entities[0]!.name = "Ada B";
		await storage.writeChanges("ws", changesBetween(base, mine), "demo");
		await storage.writeChanges("ws", changesBetween(base, theirs), "mcp");

		await storage.renameWorkspace("ws", "Zweit");
		await storage.createWorkspace({ id: "other", name: "Andere" }, 1);
		await storage.moveWorkspace("ws", 1);

		const history = await storage.readHistory("ws", { limit: 100 });
		assert.deepEqual(
			history.map((e) => [e.operation, e.kind, e.revision, e.source]),
			[
				["move", null, "3", null],
				["rename", null, "3", null],
				["change", "entity", "3", "mcp"],
				["change", "entity", "2", "demo"],
				...["type", "entity", "analysis", "board", "card", "drawing"].map((kind) => ["change", kind, "1", "demo"]).reverse(),
				["create", null, "0", "demo"],
			],
			"one entry per unit written; nothing for the empty save",
		);
		const ids = history.map((e) => Number(e.id));
		assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
		assert.match(history[0]!.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

		const [move, rename, theirSave, mySave] = history;
		assert.deepEqual([move!.before, move!.after], [{ position: 0 }, { position: 1 }]);
		assert.deepEqual([rename!.before, rename!.after], [{ name: "Erst" }, { name: "Zweit" }]);
		assert.equal(mySave!.collided, false);
		assert.equal(theirSave!.collided, true);
		assert.deepEqual(theirSave!.before, { value: mine.entities[0], position: 0 }, "what the tables held, not what the saver thought");
		assert.deepEqual(theirSave!.after, { value: theirs.entities[0], position: 0 });
		assert.equal(history.find((e) => e.kind === "card")!.boardId, "board-1");
		assert.deepEqual(history.at(-1)!.after, { name: "Erst", position: 0, dataVersion: 1 });

		const page = await storage.readHistory("ws", { limit: 2, before: rename!.id });
		assert.deepEqual(page.map((e) => e.id), [theirSave!.id, mySave!.id]);
		assert.deepEqual((await storage.readHistory("other", { limit: 100 })).map((e) => e.operation), ["create"], "each workspace its own");
	} finally {
		await close();
	}
});

test("sqlite: a deleted workspace's history stays, ending with everything it held", async () => {
	const { storage, close } = await fresh();
	try {
		await storage.init();
		await storage.createWorkspace({ id: "ws", name: "Weg" }, 1);
		await storage.writeChanges("ws", changesBetween(empty(), sample()));
		await storage.deleteWorkspace("ws", "mcp");
		await storage.deleteWorkspace("ws", "mcp");

		const history = await storage.readHistory("ws", { limit: 100 });
		assert.equal(history.length, 8, "the second delete found nothing to delete, and wrote nothing");
		const [deleted] = history;
		assert.equal(deleted!.operation, "delete");
		assert.equal(deleted!.source, "mcp");
		assert.equal(deleted!.after, null);
		assert.deepEqual(deleted!.before, { name: "Weg", dataVersion: 1, revision: "1", data: sample() });
		assert.equal(await storage.renameWorkspace("ws", "Wieder"), false);
		assert.equal((await storage.readHistory("ws", { limit: 100 })).length, 8);
	} finally {
		await close();
	}
});

test("sqlite: a board that only panned or zoomed leaves no entry in the history; one renamed with it does", async () => {
	const { storage, close } = await fresh();
	try {
		await storage.init();
		await storage.createWorkspace({ id: "ws", name: "Test" }, 1);
		const base = sample();
		await storage.writeChanges("ws", changesBetween(empty(), base));
		const entries = async () => (await storage.readHistory("ws", { limit: 100 })).length;
		const before = await entries();

		const panned = structuredClone(base);
		panned.boards[0]!.viewport = { x: 120, y: -40, zoom: 2 };
		assert.deepEqual(await storage.writeChanges("ws", changesBetween(base, panned)), { version: "2", collided: [] }, "saved all the same");
		assert.deepEqual((await storage.readWorkspace("ws"))?.data.boards[0]!.viewport, { x: 120, y: -40, zoom: 2 });
		assert.equal(await entries(), before, "no entry for pan and zoom");

		const renamed = structuredClone(panned);
		renamed.boards[0]!.name = "Neu";
		renamed.boards[0]!.viewport = { x: 0, y: 0, zoom: 1 };
		await storage.writeChanges("ws", changesBetween(panned, renamed));
		const [entry] = await storage.readHistory("ws", { limit: 1 });
		assert.equal(entry!.kind, "board");
		assert.deepEqual(entry!.after, { value: { id: "board-1", name: "Neu", viewport: { x: 0, y: 0, zoom: 1 }, viewFrame: base.boards[0]!.viewFrame }, position: 0 });
		assert.equal(await entries(), before + 1);
	} finally {
		await close();
	}
});

test("sqlite: a workspace made before the history gets a baseline of everything it holds, once; a new one needs none", async () => {
	const { storage, path, close } = await fresh();
	try {
		await storage.init();
		// As before the history: the workspace's row is there, its making never recorded.
		const raw = new DatabaseSync(path);
		raw.prepare("insert into workspaces (id, position, name, data_version) values ('old', 0, 'Alt', 1)").run();
		raw.close();
		await storage.writeChanges("old", changesBetween(empty(), sample()), "demo");
		await storage.createWorkspace({ id: "new", name: "Neu" }, 1);

		assert.equal(await storage.recordBaselines(), 1);
		assert.equal(await storage.recordBaselines(), 0, "each has its start now");

		const [baseline, ...saved] = await storage.readHistory("old", { limit: 100 });
		assert.equal(baseline!.operation, "baseline");
		assert.equal(baseline!.source, null);
		assert.equal(baseline!.before, null);
		assert.deepEqual(baseline!.after, { name: "Alt", dataVersion: 1, revision: "1", data: sample() });
		assert.ok(saved.every((e) => e.operation === "change"), "entries already there stay before it");
		assert.deepEqual((await storage.readHistory("new", { limit: 100 })).map((e) => e.operation), ["create"]);
	} finally {
		await close();
	}
});
