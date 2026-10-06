import assert from "node:assert/strict";
import { test } from "node:test";
import { SaveConflict } from "@bekbon/core";
import { httpStorage } from "./http-storage.js";

/** One request the port made to the API. */
interface Sent {
	method: string;
	url: string;
	body: string | null;
	headers: Record<string, string>;
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
			headers: (init?.headers as Record<string, string> | undefined) ?? {},
		};
		sent.push(request);
		return Promise.resolve(respond(request));
	};
	return { sent, restore: () => void (globalThis.fetch = actualFetch) };
}

/** The API's answer with `status`, carrying `text` — its 204 says nothing, so it carries no body — and,
 * like the real one, the text's version in etag where a version is asked about. */
function answer(status: number, text = "", headers: Record<string, string> = {}): Response {
	return new Response(status === 204 ? null : text, { status, headers });
}

test("getItem brings the text the API answers to its GET, asking at the key's address", async () => {
	const api = fakeFetch(() => answer(200, "the saved data", { etag: "7" }));
	const port = httpStorage("http://api.local/");
	try {
		assert.equal(await port.getItem("entities-app"), "the saved data");
		assert.deepEqual(api.sent, [{ method: "GET", url: "http://api.local/texts/entities-app", body: null, headers: {} }]);
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
		assert.deepEqual(api.sent, [{ method: "PUT", url: "http://api.local/texts/entities-app", body: "the new data", headers: {} }]);
	} finally {
		api.restore();
	}
});

test("removeItem DELETEs at the key's address, settling on the API's 204", async () => {
	const api = fakeFetch(() => answer(204));
	const port = httpStorage("http://api.local/");
	try {
		await port.removeItem("entities-app");
		assert.deepEqual(api.sent, [{ method: "DELETE", url: "http://api.local/texts/entities-app", body: null, headers: {} }]);
	} finally {
		api.restore();
	}
});

test("the port remembers the version a GET answered, and names it with the next PUT under the key", async () => {
	const api = fakeFetch(() => answer(200, "the saved data", { etag: "7" }));
	const port = httpStorage("http://api.local/");
	try {
		assert.equal(await port.getItem("entities-app"), "the saved data");
		await port.setItem("entities-app", "the new data");
		assert.deepEqual(api.sent[1], {
			method: "PUT",
			url: "http://api.local/texts/entities-app",
			body: "the new data",
			headers: { "if-match": "7" }, // the stand it read, so it can't run over what someone else saved
		});
	} finally {
		api.restore();
	}
});

test("the port takes over the version a successful save's answer names, for the next save under the key", async () => {
	const saves = ["first save", "second save"];
	const api = fakeFetch((sent) => (sent.method === "GET" ? answer(404) : answer(204, "", { etag: `${saves.indexOf(sent.body!) + 1}` })));
	const port = httpStorage("http://api.local/");
	try {
		await port.getItem("entities-app"); // nothing stored: no version to remember
		await port.setItem("entities-app", "first save");
		assert.deepEqual(api.sent[1]!.headers, {}); // a first write goes without a stand to name
		await port.setItem("entities-app", "second save");
		assert.deepEqual(api.sent[2]!.headers, { "if-match": "1" }); // the version the 204 itself answered
	} finally {
		api.restore();
	}
});

test("after a DELETE, the next save under the key goes without a stand to name again", async () => {
	const api = fakeFetch((sent) =>
		sent.method === "GET" ? answer(200, "the saved data", { etag: "7" }) : answer(204, "", { etag: "9" }),
	);
	const port = httpStorage("http://api.local/");
	try {
		await port.getItem("entities-app"); // remembers version 7
		await port.setItem("entities-app", "over it");
		await port.removeItem("entities-app"); // the text is gone: a next save under the key starts over
		await port.setItem("entities-app", "written anew");
		assert.deepEqual(api.sent.map((sent) => sent.headers), [{}, { "if-match": "7" }, {}, {}]);
	} finally {
		api.restore();
	}
});

test("the API's 409 rejects the save as a conflict, so the caller can tell it from a broken storage", async () => {
	const api = fakeFetch(() => answer(409));
	const port = httpStorage("http://api.local/");
	try {
		await assert.rejects(
			port.setItem("entities-app", "the new data"),
			(error: unknown) => error instanceof SaveConflict,
		);
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

test("version HEADs the key's address and names the etag — the text itself never travels", async () => {
	const api = fakeFetch(() => answer(200, "the saved data, worth carrying whole", { etag: "7" }));
	const port = httpStorage("http://api.local/");
	try {
		assert.equal(await port.version!("entities-app"), "7");
		assert.deepEqual([{ method: "HEAD", url: "http://api.local/texts/entities-app", body: null, headers: {} }], api.sent);
	} finally {
		api.restore();
	}
});

test("version says null where nothing is stored (the API's 404), and answers other than the API's reject", async () => {
	let nothingThere = true;
	const api = fakeFetch(() => (nothingThere ? answer(404) : answer(500, "the database fell over")));
	const port = httpStorage("http://api.local/");
	try {
		assert.equal(await port.version!("entities-app"), null);
		nothingThere = false;
		await assert.rejects(port.version!("entities-app"));
	} finally {
		api.restore();
	}
});

test("a look after version changes nothing: the stand this port's saves build on (if-match) stands", async () => {
	// GET answered etag 7; the HEAD looks at a newer stand, 9 — someone else saved. The next save here must
	// still name the stand it READ (7): the API refuses it as outdated instead of quietly overtaking the other's.
	const api = fakeFetch((sent) =>
		sent.method === "HEAD" ? answer(200, "", { etag: "9" }) : sent.method === "GET" ? answer(200, "the saved data", { etag: "7" }) : answer(204, "", { etag: "8" }),
	);
	const port = httpStorage("http://api.local/");
	try {
		await port.getItem("entities-app");
		assert.equal(await port.version!("entities-app"), "9");
		await port.setItem("entities-app", "the new data");
		assert.equal(api.sent[2]!.headers["if-match"], "7"); // what was read here, not what the look saw
	} finally {
		api.restore();
	}
});
