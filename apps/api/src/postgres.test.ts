import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { postgresStorage } from "./postgres.js";
import { call, startApp } from "./test-server.js";

/** The database these tests run against; without it they are skipped, not failed. */
const url = process.env.DATABASE_URL;

/** A key no other run will have used before, so no test sees another one's text. */
const freshKey = () => `api-test:${randomUUID()}`;

test("the table is there after start, no matter how many times it's started", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	try {
		await storage.init();
		await storage.init();
		assert.equal(await storage.healthy(), true);
	} finally {
		await storage.close();
	}
});

test("a text stored under its key is answered back, overwritten, and removed — empty counts as stored", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const key = freshKey();
	try {
		await storage.init();
		assert.equal(await storage.getItem(key), null);

		await storage.setItem(key, 'saved { "version": 1 }\n');
		assert.equal(await storage.getItem(key), 'saved { "version": 1 }\n');

		await storage.setItem(key, "");
		assert.equal(await storage.getItem(key), "");

		await storage.removeItem(key);
		assert.equal(await storage.getItem(key), null);
		await storage.removeItem(key);
	} finally {
		await storage.removeItem(key).catch(() => {});
		await storage.close();
	}
});

test("every key keeps the text of its own", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const first = freshKey();
	const second = freshKey();
	try {
		await storage.init();
		await storage.setItem(first, "the text of the first");
		await storage.setItem(second, "the text of the second");

		assert.equal(await storage.getItem(first), "the text of the first");
		assert.equal(await storage.getItem(second), "the text of the second");

		await storage.removeItem(first);
		assert.equal(await storage.getItem(second), "the text of the second");
	} finally {
		await storage.close();
	}
});

test("the served API answers the storage port against Postgres, end to end", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const key = freshKey();
	try {
		await storage.init();
		const api = await startApp(storage);
		try {
			const empty = await call(api.url, `texts/${encodeURIComponent(key)}`);
			assert.equal(empty.status, 404);

			const stored = await call(api.url, `texts/${encodeURIComponent(key)}`, {
				method: "PUT",
				body: "the text under the key",
			});
			assert.equal(stored.status, 204);

			const read = await call(api.url, `texts/${encodeURIComponent(key)}`);
			assert.equal(read.status, 200);
			assert.equal(read.text, "the text under the key");

			const removed = await call(api.url, `texts/${encodeURIComponent(key)}`, { method: "DELETE" });
			assert.equal(removed.status, 204);

			const gone = await call(api.url, `texts/${encodeURIComponent(key)}`);
			assert.equal(gone.status, 404);

			const health = await call(api.url, "health");
			assert.equal(health.status, 200);
		} finally {
			await api.close();
		}
	} finally {
		await storage.removeItem(key).catch(() => {});
		await storage.close();
	}
});
