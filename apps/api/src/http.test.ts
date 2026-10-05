import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CORS_ORIGIN, corsOriginFromEnv, DEFAULT_PORT, portFromEnv, type Api } from "./http.js";
import { call, startApp } from "./test-server.js";

/** The API on whatever texts the map holds — like localStorage would, without needing any. Every write
 * grows the key's version by one, the way the storage's revision column does. */
function memoryApi(initial: Record<string, string> = {}, healthy: () => Promise<boolean> = async () => true): Api {
	const map = new Map(Object.entries(initial));
	const versions = new Map<string, number>();
	return {
		getItem: async (key) => map.get(key) ?? null,
		read: async (key) => {
			const text = map.get(key);
			return text === undefined ? null : { text, version: String(versions.get(key) ?? 0) };
		},
		setItem: async (key, value) => {
			map.set(key, value);
			versions.set(key, (versions.get(key) ?? 0) + 1);
		},
		write: async (key, value, seen) => {
			if (seen === null) {
				if (map.has(key)) return null;
				map.set(key, value);
				versions.set(key, 1);
				return "1";
			}
			if (String(versions.get(key) ?? 0) !== seen) return null;
			map.set(key, value);
			versions.set(key, Number(seen) + 1);
			return String(Number(seen) + 1);
		},
		removeItem: async (key) => {
			map.delete(key);
			versions.delete(key);
		},
		healthy,
	};
}

/** The API against a storage whose every call fails, like a database that is gone. */
function failingApi(): Api {
	const gone = async () => {
		throw new Error("the storage is gone");
	};
	return {
		getItem: gone,
		read: gone,
		setItem: gone,
		write: gone,
		removeItem: gone,
		healthy: async () => false,
	};
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

test("a first PUT stores the request body under the key, answering 204 with the new version in etag", async () => {
	const api = await startApp(memoryApi());
	try {
		const put = await call(api.url, "texts/entities-app", { method: "PUT", body: "the saved data" });
		assert.equal(put.status, 204);
		assert.ok(put.header("etag"), "the answer names the version it saved");

		const get = await call(api.url, "texts/entities-app");
		assert.equal(get.status, 200);
		assert.equal(get.text, "the saved data");
		assert.equal(get.header("etag"), put.header("etag"));
	} finally {
		await api.close();
	}
});

test("a PUT naming the current version overwrites what was stored, and an empty body is a text of its own", async () => {
	const api = await startApp(memoryApi());
	try {
		await call(api.url, "texts/entities-app", { method: "PUT", body: "first" });
		const first = await call(api.url, "texts/entities-app");
		const second = await call(api.url, "texts/entities-app", {
			method: "PUT",
			body: "",
			headers: { "if-match": first.header("etag")! },
		});
		assert.equal(second.status, 204);
		assert.notEqual(second.header("etag"), first.header("etag"));

		const get = await call(api.url, "texts/entities-app");
		assert.equal(get.status, 200);
		assert.equal(get.text, "");
	} finally {
		await api.close();
	}
});

test("a save over stored data without naming the stand it read is refused with 409, and writes nothing", async () => {
	const api = await startApp(memoryApi({ "entities-app": "the saved data" }));
	try {
		const refused = await call(api.url, "texts/entities-app", { method: "PUT", body: "quietly over" });
		assert.equal(refused.status, 409);
		assert.equal(refused.text, "");

		// Nothing was written, not a part of it either.
		const get = await call(api.url, "texts/entities-app");
		assert.equal(get.status, 200);
		assert.equal(get.text, "the saved data");
	} finally {
		await api.close();
	}
});

test("a save on an outdated stand loses, word for word: 409, nothing changed; on the current stand it wins", async () => {
	const api = await startApp(memoryApi());
	try {
		const read = await call(api.url, "texts/entities-app", { method: "PUT", body: "the text we read" });
		const seen = read.header("etag")!;

		// Someone else saves first, building on the current version.
		const theirs = await call(api.url, "texts/entities-app", {
			method: "PUT",
			body: "someone else's text, saved first",
			headers: { "if-match": seen },
		});
		assert.equal(theirs.status, 204);
		assert.ok(theirs.header("etag"));
		assert.notEqual(theirs.header("etag"), seen);

		// Our save, still on the stand we read: refused without touching anything.
		const refused = await call(api.url, "texts/entities-app", {
			method: "PUT",
			body: "our text, based on the old stand",
			headers: { "if-match": seen },
		});
		assert.equal(refused.status, 409);
		assert.equal(refused.text, "");
		const current = await call(api.url, "texts/entities-app");
		assert.equal(current.text, "someone else's text, saved first");
		assert.equal(current.header("etag"), theirs.header("etag"));

		// Building on the current stand, the same save goes through and answers the next version.
		const ours = await call(api.url, "texts/entities-app", {
			method: "PUT",
			body: "our text, now on the current stand",
			headers: { "if-match": theirs.header("etag")! },
		});
		assert.equal(ours.status, 204);
		const again = await call(api.url, "texts/entities-app");
		assert.equal(again.text, "our text, now on the current stand");
		assert.equal(again.header("etag"), ours.header("etag"));
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

/** The origin the tests name as allowed, the way CORS_ORIGIN would in a running server. */
const demoOrigin = "http://the-demo.example:5173";

/** Whether an answer says what the browser needs to see it from another origin: whose, which ways, sending
 * what, and which answer headers JavaScript may read. */
function assertCrossOriginAllowed(response: Awaited<ReturnType<typeof call>>, origin: string): void {
	assert.equal(response.header("access-control-allow-origin"), origin);
	assert.equal(response.header("access-control-allow-methods"), "GET, PUT, DELETE");
	assert.equal(response.header("access-control-allow-headers"), "Content-Type, If-Match");
	assert.equal(response.header("access-control-expose-headers"), "ETag");
}

test("the browser's preflight (OPTIONS before PUT and DELETE) is answered 204 with what it asks for", async () => {
	const api = await startApp(memoryApi(), demoOrigin);
	try {
		const preflight = await call(api.url, "texts/entities-app", {
			method: "OPTIONS",
			headers: {
				// What the browser asks before sending the request it actually wants to send (If-Match, since
				// a save names the stand it read):
				"access-control-request-method": "PUT",
				"access-control-request-headers": "content-type, if-match",
			},
		});
		assert.equal(preflight.status, 204);
		assertCrossOriginAllowed(preflight, demoOrigin);
	} finally {
		await api.close();
	}
});

test("the answers of GET, PUT, 409 and DELETE carry the same allowance, so the browser accepts them", async () => {
	const api = await startApp(memoryApi(), demoOrigin);
	try {
		const put = await call(api.url, "texts/entities-app", { method: "PUT", body: "the saved data" });
		assert.equal(put.status, 204);
		assertCrossOriginAllowed(put, demoOrigin);

		const get = await call(api.url, "texts/entities-app");
		assert.equal(get.status, 200);
		assertCrossOriginAllowed(get, demoOrigin);

		// The browser would otherwise hide the 409 from the app, and it would look like any failure.
		const refused = await call(api.url, "texts/entities-app", { method: "PUT", body: "over it quietly" });
		assert.equal(refused.status, 409);
		assertCrossOriginAllowed(refused, demoOrigin);

		const remove = await call(api.url, "texts/entities-app", { method: "DELETE" });
		assert.equal(remove.status, 204);
		assertCrossOriginAllowed(remove, demoOrigin);
	} finally {
		await api.close();
	}
});

test("even a 404 says whose origin it may be read from — the browser would otherwise hide the answer", async () => {
	const api = await startApp(memoryApi(), demoOrigin);
	try {
		const nothingStored = await call(api.url, "texts/entities-app");
		assert.equal(nothingStored.status, 404);
		assertCrossOriginAllowed(nothingStored, demoOrigin);
	} finally {
		await api.close();
	}
});

test("the allowed origin comes from CORS_ORIGIN, with its fallback", () => {
	assert.equal(corsOriginFromEnv("https://demo.example"), "https://demo.example");
	assert.equal(corsOriginFromEnv(undefined), DEFAULT_CORS_ORIGIN);
	assert.equal(corsOriginFromEnv(""), DEFAULT_CORS_ORIGIN);
});
