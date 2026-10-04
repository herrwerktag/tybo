import assert from "node:assert/strict";
import { test } from "node:test";
import { httpStorage } from "./http-storage.js";

/** One request the port made to the API. */
interface Sent {
	method: string;
	url: string;
	body: string | null;
}

/** The API the tests answer as (no network, no database): every request is recorded, `respond` says what
 * comes back — a Response, or a promise of one. restore() puts the real fetch back in its place. */
function fakeFetch(respond: (sent: Sent) => Response | Promise<Response>): { sent: Sent[]; restore: () => void } {
	const actualFetch = globalThis.fetch;
	const sent: Sent[] = [];
	globalThis.fetch = (input, init) => {
		const request: Sent = {
			method: init?.method ?? "GET",
			url: String(input),
			body: typeof init?.body === "string" ? init.body : null,
		};
		sent.push(request);
		return Promise.resolve(respond(request));
	};
	return { sent, restore: () => void (globalThis.fetch = actualFetch) };
}

/** The API's answer with `status`, carrying `text` — its 204 says nothing, so it carries no body. */
function answer(status: number, text = ""): Response {
	return new Response(status === 204 ? null : text, { status });
}

test("getItem brings the text the API answers to its GET, asking at the key's address", async () => {
	const api = fakeFetch(() => answer(200, "the saved data"));
	const port = httpStorage("http://api.local/");
	try {
		assert.equal(await port.getItem("entities-app"), "the saved data");
		assert.deepEqual(api.sent, [{ method: "GET", url: "http://api.local/texts/entities-app", body: null }]);
	} finally {
		api.restore();
	}
});

test("where nothing is stored the API answers 404, and getItem says null, as the port promises", async () => {
	const api = fakeFetch(() => answer(404));
	const port = httpStorage("http://api.local/");
	try {
		assert.equal(await port.getItem("entities-app"), null);
	} finally {
		api.restore();
	}
});

test("setItem PUTs the value under the key, settling on the API's 204", async () => {
	const api = fakeFetch(() => answer(204));
	const port = httpStorage("http://api.local/");
	try {
		await port.setItem("entities-app", "the new data");
		assert.deepEqual(api.sent, [{ method: "PUT", url: "http://api.local/texts/entities-app", body: "the new data" }]);
	} finally {
		api.restore();
	}
});

test("removeItem DELETEs at the key's address, settling on the API's 204", async () => {
	const api = fakeFetch(() => answer(204));
	const port = httpStorage("http://api.local/");
	try {
		await port.removeItem("entities-app");
		assert.deepEqual(api.sent, [{ method: "DELETE", url: "http://api.local/texts/entities-app", body: null }]);
	} finally {
		api.restore();
	}
});

test("keys the address wouldn't survive arrive escaped, one path per key", async () => {
	const api = fakeFetch(() => answer(204));
	const key = "entities-app:backup:2026-10-04/ähm +1";
	try {
		await httpStorage("http://api.local/").setItem(key, "backed up");
		assert.equal(api.sent[0]?.url, `http://api.local/texts/${encodeURIComponent(key)}`);
	} finally {
		api.restore();
	}
});

test("nothing is sent before the request before it is answered — saves keep their order", async () => {
	let answers = 0;
	let answerTheFirst: (response: Response) => void = () => {};
	const api = fakeFetch(() =>
		answers++ === 0
			? new Promise<Response>((resolve) => (answerTheFirst = resolve))
			: Promise.resolve(answer(204)),
	);
	const port = httpStorage("http://api.local/");
	try {
		const saves = [port.setItem("entities-app", "first"), port.setItem("entities-app", "second")];
		await new Promise((resolve) => setImmediate(resolve));
		// The first save is on its way, and the second isn't even sent before it is answered.
		assert.equal(api.sent.length, 1);
		answerTheFirst(answer(204));
		await Promise.all(saves);
		assert.deepEqual(api.sent.map((sent) => sent.body), ["first", "second"]);
	} finally {
		api.restore();
	}
});

test("a network gone to the API rejects each call of the port", async () => {
	const api = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
	const port = httpStorage("http://api.local/");
	try {
		await assert.rejects(port.getItem("entities-app"));
		await assert.rejects(port.setItem("entities-app", "the new data"));
		await assert.rejects(port.removeItem("entities-app"));
	} finally {
		api.restore();
	}
});

test("the API's 500 answers reject the calls, however readable their body looks", async () => {
	const api = fakeFetch(() => answer(500, "the database fell over"));
	const port = httpStorage("http://api.local/");
	try {
		await assert.rejects(port.getItem("entities-app"));
		await assert.rejects(port.setItem("entities-app", "the new data"));
		await assert.rejects(port.removeItem("entities-app"));
	} finally {
		api.restore();
	}
});
