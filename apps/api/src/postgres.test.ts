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

test("a save builds on the version it was answered: an outdated one is refused and changes nothing", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const key = freshKey();
	try {
		await storage.init();
		// The first write passes without a stand to name: nothing is stored under the key yet.
		assert.equal(await storage.write(key, "the first text\nline for line", null), "1");
		const read = await storage.read(key);
		assert.deepEqual(read, { text: "the first text\nline for line", version: "1" });

		// A first-write claim over stored data is refused, too.
		assert.equal(await storage.write(key, "written over without a stand", null), null);

		// Someone else saves before us, building on the current version.
		const theirs = await storage.write(key, "someone else's text, two\nlines", read!.version);
		assert.ok(theirs);
		assert.notEqual(theirs, read!.version);

		// Our save, still on the stand we read: refused — the stored text stays word for word.
		assert.equal(await storage.write(key, "our text, on the outdated stand", read!.version), null);
		const after = await storage.read(key);
		assert.equal(after!.text, "someone else's text, two\nlines");
		assert.equal(after!.version, theirs);
	} finally {
		await storage.removeItem(key).catch(() => {});
		await storage.close();
	}
});

test("over HTTP, an outdated save is refused with 409 and the stored text stays; a current one goes through", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const key = freshKey();
	try {
		await storage.init();
		const api = await startApp(storage);
		const path = `texts/${encodeURIComponent(key)}`;
		try {
			assert.equal((await call(api.url, path)).status, 404);

			// The first write, without a stand to name.
			const first = await call(api.url, path, { method: "PUT", body: "the text under the key" });
			assert.equal(first.status, 204);
			assert.ok(first.header("etag"));
			const seen = first.header("etag")!;

			// The second writer saves first, building on the current version.
			const read = await call(api.url, path);
			const theirs = await call(api.url, path, {
				method: "PUT",
				body: "their newer text, saved in between",
				headers: { "if-match": read.header("etag")! },
			});
			assert.equal(theirs.status, 204);
			assert.ok(theirs.header("etag"));
			assert.notEqual(theirs.header("etag"), seen);

			// Our save, still on the stand we read: 409, and the stored text unchanged, word for word.
			const refused = await call(api.url, path, {
				method: "PUT",
				body: "the text under the key, ours",
				headers: { "if-match": seen },
			});
			assert.equal(refused.status, 409);
			assert.equal(refused.text, "");
			const current = await call(api.url, path);
			assert.equal(current.text, "their newer text, saved in between");
			assert.equal(current.header("etag"), theirs.header("etag"));

			// Over stored data, a save naming no stand is refused as well.
			const unnamed = await call(api.url, path, { method: "PUT", body: "written over without a stand" });
			assert.equal(unnamed.status, 409);
			assert.equal((await call(api.url, path)).text, "their newer text, saved in between");

			// Building on the current stand, saving goes through and answers the next version.
			const ours = await call(api.url, path, {
				method: "PUT",
				body: "the text under the key, ours",
				headers: { "if-match": theirs.header("etag")! },
			});
			assert.equal(ours.status, 204);
			const again = await call(api.url, path);
			assert.equal(again.text, "the text under the key, ours");
			assert.equal(again.header("etag"), ours.header("etag"));
		} finally {
			await api.close();
		}
	} finally {
		await storage.removeItem(key).catch(() => {});
		await storage.close();
	}
});
