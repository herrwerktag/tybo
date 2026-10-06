import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { changesBetween, type AppData } from "@bekbon/core";
import { postgresStorage } from "./postgres.js";
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
		entities: [{ id: "ent-1", typeId: "type-1", name: "Ada", content: "", description: "", values: { "prop-1": "hier" } }],
		boards: [
			{
				id: "board-1",
				name: "Brett",
				kind: "whiteboard",
				cards: [{ id: "card-1", entityId: "ent-1", x: 1, y: 2, width: 240, height: 160 }],
				viewport: { x: 0, y: 0, zoom: 1 },
				drawings: [],
				pages: [],
			},
		],
	};
}

const empty = (): AppData => ({ types: [], entities: [], boards: [] });

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
		assert.deepEqual(made, { data: { version: 1, types: [], entities: [], boards: [] }, revision: "0" });

		assert.equal(await storage.renameWorkspace(id, "Umbenannt"), true);
		assert.equal(await storage.renameWorkspace(freshId(), "Niemand"), false);
		const listed = (await storage.listWorkspaces()).find((w) => w.id === id);
		assert.deepEqual(listed, { id, name: "Umbenannt" });

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
