import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PORT, portFromEnv, type Api } from "./http.js";
import { call, startApp } from "./test-server.js";

/** The API on whatever texts the map holds — like localStorage would, without needing any. */
function memoryApi(initial: Record<string, string> = {}, healthy: () => Promise<boolean> = async () => true): Api {
	const map = new Map(Object.entries(initial));
	return {
		getItem: async (key) => map.get(key) ?? null,
		setItem: async (key, value) => void map.set(key, value),
		removeItem: async (key) => void map.delete(key),
		healthy,
	};
}

/** The API against a storage whose every call fails, like a database that is gone. */
function failingApi(): Api {
	const gone = async () => {
		throw new Error("the storage is gone");
	};
	return { getItem: gone, setItem: gone, removeItem: gone, healthy: async () => false };
}

test("GET answers 404 under a key nothing is stored, as with paths that lead nowhere", async () => {
	const api = await startApp(memoryApi());
	try {
		assert.equal((await call(api.url, "texts/nothing-here")).status, 404);
		assert.equal((await call(api.url, "texts/")).status, 404);
		assert.equal((await call(api.url, "texts")).status, 404);
		assert.equal((await call(api.url, "nowhere")).status, 404);
	} finally {
		await api.close();
	}
});

test("PUT stores the request body under the key, answering 204, and GET answers it back", async () => {
	const api = await startApp(memoryApi());
	try {
		const put = await call(api.url, "texts/entities-app", { method: "PUT", body: "the saved data" });
		assert.equal(put.status, 204);

		const get = await call(api.url, "texts/entities-app");
		assert.equal(get.status, 200);
		assert.equal(get.text, "the saved data");
	} finally {
		await api.close();
	}
});

test("PUT overwrites what was stored, and an empty body is a text of its own, not none at all", async () => {
	const api = await startApp(memoryApi());
	try {
		await call(api.url, "texts/entities-app", { method: "PUT", body: "first" });
		await call(api.url, "texts/entities-app", { method: "PUT", body: "" });

		const get = await call(api.url, "texts/entities-app");
		assert.equal(get.status, 200);
		assert.equal(get.text, "");
	} finally {
		await api.close();
	}
});

test("keys keep the characters they came with, escaped in the URL", async () => {
	const api = await startApp(memoryApi());
	const key = "entities-app:backup:2026-10-04/ähm +1";
	try {
		await call(api.url, `texts/${encodeURIComponent(key)}`, { method: "PUT", body: "backed up" });
		assert.equal((await call(api.url, `texts/${encodeURIComponent(key)}`)).text, "backed up");
	} finally {
		await api.close();
	}
});

test("DELETE answers 204 whether anything was stored, and takes the stored text away", async () => {
	const api = await startApp(memoryApi());
	try {
		assert.equal((await call(api.url, "texts/entities-app", { method: "DELETE" })).status, 204);

		await call(api.url, "texts/entities-app", { method: "PUT", body: "the saved data" });
		assert.equal((await call(api.url, "texts/entities-app", { method: "DELETE" })).status, 204);
		assert.equal((await call(api.url, "texts/entities-app")).status, 404);
		assert.equal((await call(api.url, "texts/entities-app", { method: "DELETE" })).status, 204);
	} finally {
		await api.close();
	}
});

test("/health says 200 while the storage answers, and 503 once it doesn't", async () => {
	const api = await startApp(memoryApi());
	try {
		const healthy = await call(api.url, "health");
		assert.equal(healthy.status, 200);
	} finally {
		await api.close();
	}

	const sick = await startApp(memoryApi({}, async () => false));
	try {
		assert.equal((await call(sick.url, "health")).status, 503);
	} finally {
		await sick.close();
	}
});

test("requests the API doesn't serve answer 404, or 405 where only the method is wrong", async () => {
	const api = await startApp(memoryApi());
	try {
		assert.equal((await call(api.url, "nowhere")).status, 404);
		assert.equal((await call(api.url, "texts/anything", { method: "POST", body: "x" })).status, 405);
		assert.equal((await call(api.url, "health", { method: "PUT", body: "x" })).status, 405);
	} finally {
		await api.close();
	}
});

test("a failing storage answers 503, without anything that could explain why", async () => {
	const api = await startApp(failingApi());
	try {
		const get = await call(api.url, "texts/entities-app");
		assert.equal(get.status, 503);
		assert.equal(get.text, "");

		const put = await call(api.url, "texts/entities-app", { method: "PUT", body: "x" });
		assert.equal(put.status, 503);

		const remove = await call(api.url, "texts/entities-app", { method: "DELETE" });
		assert.equal(remove.status, 503);
	} finally {
		await api.close();
	}
});

test("the port comes from PORT, with its fallback", () => {
	assert.equal(portFromEnv("4321"), 4321);
	assert.equal(portFromEnv(undefined), DEFAULT_PORT);
	assert.equal(portFromEnv("not a port"), DEFAULT_PORT);
	assert.equal(portFromEnv("0"), DEFAULT_PORT);
});
