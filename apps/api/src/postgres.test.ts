import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DATA_VERSION, changesBetween, storedFeatureData, type AppData } from "@tybo/app/core";
import postgres from "postgres";
import { postgresStorage } from "@tybo/app/api";
import { call, startApp } from "./test-server.js";

/** The test database these tests run against (never the productive DATABASE_URL); without it they are skipped, not failed. */
const url = process.env.TEST_DATABASE_URL;

/** A workspace id no other run will have used before, so no test sees another one's rows. */
const freshId = () => `api-test:${randomUUID()}`;

/** One type with a property, an entity with a value, and a board with its card. */
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
				cards: [{ id: "card-1", entityId: "ent-1", x: 1, y: 2, width: 240, height: 160 }],
				viewport: { x: 0, y: 0, zoom: 1 },
				viewFrame: { x: -12.5, y: 0, width: 1280, height: 720 },
				drawings: [],
			},
		],
		analyses: [],
	};
}

const empty = (): AppData => ({ types: [], entities: [], boards: [], ...storedFeatureData({}) });

test("starting again and again leaves the schema as it is — nothing runs twice", { skip: !url }, async () => {
	const storage = postgresStorage(url!);
	try {
		await storage.init();
		assert.deepEqual(await storage.init(), [], "the second start has nothing left to do");
		assert.equal(await storage.healthy(), true);
	} finally {
		await storage.close();
	}
});

test("a workspace is made empty, renamed, listed, and deleted with every row of its data", { skip: !url }, async () => {
	const storage = postgresStorage(url!);
	const id = freshId();
	try {
		await storage.init();
		assert.equal(await storage.createWorkspace({ id, name: "Erst" }, 1), true);
		assert.equal(await storage.createWorkspace({ id, name: "Noch mal" }, 1), false, "an id is made once");

		const made = await storage.readWorkspace(id);
		assert.deepEqual(made, { data: { version: 1, ...empty() }, revision: "0" });

		assert.equal(await storage.renameWorkspace(id, "Umbenannt"), true);
		assert.equal(await storage.renameWorkspace(freshId(), "Niemand"), false);

		// A name another workspace has is refused, ignoring case and surrounding spaces; the workspace's own isn't.
		const other = freshId();
		assert.equal(await storage.createWorkspace({ id: other, name: ` ${id.toUpperCase()} ` }, 1), true);
		assert.equal(await storage.createWorkspace({ id: freshId(), name: id }, 1), false);
		assert.equal(await storage.renameWorkspace(id, id), "nameTaken");
		assert.equal(await storage.renameWorkspace(other, id), true);
		await storage.deleteWorkspace(other);
		const listed = (await storage.listWorkspaces()).find((w) => w.id === id);
		assert.deepEqual(listed, { id, name: "Umbenannt" });

		// Other tests' workspaces may be there too: the move is seen relative to them.
		assert.equal(await storage.moveWorkspace(id, 0), true);
		assert.equal(await storage.moveWorkspace(freshId(), 0), false);
		assert.equal((await storage.listWorkspaces())[0]?.id, id);

		const saved = await storage.writeChanges(id, changesBetween(empty(), sample()));
		assert.deepEqual(saved, { version: "1", collided: [] });
		assert.equal(await storage.workspaceRevision(id), "1");

		await storage.deleteWorkspace(id);
		assert.equal(await storage.readWorkspace(id), null);
		assert.equal(await storage.workspaceRevision(id), null);
		assert.equal((await storage.listWorkspaces()).some((w) => w.id === id), false);
		assert.equal(await storage.writeChanges(id, changesBetween(empty(), sample())), null, "no workspace, nothing written");
	} finally {
		await storage.deleteWorkspace(id);
		await storage.close();
	}
});

test("two workspaces keep their own rows — even under the very same ids", { skip: !url }, async () => {
	const storage = postgresStorage(url!);
	const first = freshId();
	const second = freshId();
	try {
		await storage.init();
		await storage.createWorkspace({ id: first, name: "Eins" }, 1);
		await storage.createWorkspace({ id: second, name: "Zwei" }, 1);
		// The second starts with copies of the first one's types, ids and all — the way "copy the types" makes one.
		await storage.writeChanges(first, changesBetween(empty(), sample()));
		await storage.writeChanges(second, changesBetween(empty(), { ...empty(), types: sample().types }));

		// A change in the one stays out of the other.
		const renamed = sample();
		renamed.types[0]!.name = "Mensch";
		await storage.writeChanges(second, changesBetween({ ...empty(), types: sample().types }, { ...empty(), types: renamed.types }));

		assert.deepEqual((await storage.readWorkspace(first))?.data, { version: 1, ...sample() });
		assert.deepEqual((await storage.readWorkspace(second))?.data, { version: 1, ...empty(), types: renamed.types });

		// Deleting the one takes only its own rows.
		await storage.deleteWorkspace(second);
		assert.deepEqual((await storage.readWorkspace(first))?.data, { version: 1, ...sample() });
	} finally {
		await storage.deleteWorkspace(first);
		await storage.deleteWorkspace(second);
		await storage.close();
	}
});

test("the served API answers end to end against Postgres", { skip: !url }, async () => {
	const storage = postgresStorage(url!);
	await storage.init();
	const api = await startApp(storage);
	const id = freshId();
	const path = `workspaces/${encodeURIComponent(id)}`;
	try {
		assert.equal((await call(api.url, "health")).status, 200);
		const made = await call(api.url, "workspaces", { method: "POST", body: JSON.stringify({ id, name: "Über HTTP", dataVersion: 1 }) });
		assert.equal(made.status, 201);
		assert.ok(JSON.parse((await call(api.url, "workspaces")).text).some((w: { id: string }) => w.id === id));

		const saved = await call(api.url, `${path}/changes`, { method: "PUT", body: JSON.stringify(changesBetween(empty(), sample())) });
		assert.equal(saved.status, 200);
		assert.equal(saved.header("etag"), "1");

		const got = await call(api.url, `${path}/data`);
		assert.equal(got.status, 200);
		assert.deepEqual(JSON.parse(got.text), { version: 1, ...sample() });
		assert.equal(got.header("etag"), "1");
		assert.equal((await call(api.url, `${path}/data`, { method: "HEAD" })).header("etag"), "1");

		assert.equal((await call(api.url, path, { method: "DELETE" })).status, 204);
		assert.equal((await call(api.url, `${path}/data`)).status, 404);
	} finally {
		await api.close();
		await storage.deleteWorkspace(id);
		await storage.close();
	}
});

test("every write goes into the history, which outlives the workspace — also over HTTP, with its source", { skip: !url }, async () => {
	const storage = postgresStorage(url!);
	await storage.init();
	const api = await startApp(storage);
	const id = freshId();
	const path = `workspaces/${encodeURIComponent(id)}`;
	try {
		await storage.createWorkspace({ id, name: "Erst" }, 1, "web");
		const base = sample();
		await storage.writeChanges(id, changesBetween(empty(), base), "web");
		await storage.writeChanges(id, [], "web");

		const mine = structuredClone(base);
		mine.entities[0]!.name = "Ada A";
		const theirs = structuredClone(base);
		theirs.entities[0]!.name = "Ada B";
		await storage.writeChanges(id, changesBetween(base, mine), "web");
		const put = await call(api.url, `${path}/changes`, {
			method: "PUT",
			headers: { "x-tybo-source": "mcp" },
			body: JSON.stringify(changesBetween(base, theirs)),
		});
		assert.deepEqual(JSON.parse(put.text), { version: "3", collided: ["ent-1"] });
		await storage.renameWorkspace(id, "Zweit");
		await storage.moveWorkspace(id, 0);

		const history = await storage.readHistory(id, { limit: 100 });
		assert.deepEqual(
			history.map((e) => [e.operation, e.kind, e.revision, e.source]),
			[
				["move", null, "3", null],
				["rename", null, "3", null],
				["change", "entity", "3", "mcp"],
				["change", "entity", "2", "web"],
				...["type", "entity", "board", "card"].map((kind) => ["change", kind, "1", "web"]).reverse(),
				["create", null, "0", "web"],
			],
		);
		const [, rename, theirSave, mySave] = history;
		assert.deepEqual([rename!.before, rename!.after], [{ name: "Erst" }, { name: "Zweit" }]);
		assert.equal(mySave!.collided, false);
		assert.equal(theirSave!.collided, true);
		assert.deepEqual(theirSave!.before, { value: mine.entities[0], position: 0 }, "what the tables held, not what the saver thought");
		assert.equal(history.find((e) => e.kind === "card")!.boardId, "board-1");
		assert.ok(!Number.isNaN(Date.parse(history[0]!.at)));
		assert.ok(history.every((e) => e.dataVersion === DATA_VERSION), "each entry names its format");

		const page = await call(api.url, `${path}/history?limit=2&before=${rename!.id}`);
		assert.deepEqual(JSON.parse(page.text).map((e: { id: string }) => e.id), [theirSave!.id, mySave!.id]);

		await storage.deleteWorkspace(id, "mcp");
		const [deleted] = await storage.readHistory(id, { limit: 1 });
		assert.equal(deleted!.operation, "delete");
		assert.deepEqual(deleted!.before, { name: "Zweit", revision: "3", data: theirs });
		assert.equal((await storage.readHistory(id, { limit: 100 })).length, history.length + 1);
	} finally {
		await api.close();
		await storage.deleteWorkspace(id);
		await storage.close();
	}
});

test("the history comes newest first also where its ids gain a digit (…99, then …00)", { skip: !url }, async () => {
	const storage = postgresStorage(url!);
	const raw = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	const id = freshId();
	try {
		await storage.init();
		// The next ids run over a power of ten: the making gets the last one with fewer digits, the save the ones after.
		const [row] = await raw`select coalesce(max(id), 0)::text as last from history`;
		const power = 10 ** String(Number(row!.last) + 2).length;
		await raw`select setval(pg_get_serial_sequence('history', 'id'), ${power - 2})`;
		await storage.createWorkspace({ id, name: "Stelle" }, 1, "web");
		await storage.writeChanges(id, changesBetween(empty(), sample()), "web");

		const history = await storage.readHistory(id, { limit: 100 });
		const ids = history.map((e) => Number(e.id));
		assert.equal(ids.at(-1), power - 1);
		assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "by number, not as text");
		assert.equal(history.at(-1)!.operation, "create");
	} finally {
		await raw.end({ timeout: 5 });
		await storage.deleteWorkspace(id);
		await storage.close();
	}
});

test("a workspace made before the history gets a baseline of everything it holds, once", { skip: !url }, async () => {
	const storage = postgresStorage(url!);
	const raw = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	const id = freshId();
	try {
		await storage.init();
		// As before the history: the workspace's row is there, its making never recorded.
		await raw`insert into workspaces (id, position, name, data_version) values (${id}, 0, 'Alt', 1)`;
		await storage.writeChanges(id, changesBetween(empty(), sample()), "web");

		assert.ok((await storage.recordBaselines()) >= 1);
		await storage.recordBaselines();

		const history = await storage.readHistory(id, { limit: 100 });
		assert.deepEqual(history.filter((e) => e.operation === "baseline").length, 1, "once");
		const [baseline] = history;
		assert.equal(baseline!.operation, "baseline");
		assert.deepEqual(baseline!.after, { name: "Alt", revision: "1", data: sample() });
	} finally {
		await raw.end({ timeout: 5 });
		await storage.deleteWorkspace(id);
		await storage.close();
	}
});
