import assert from "node:assert/strict";
import { test } from "node:test";
import type { Change } from "@bekbon/core";
import { httpData } from "./http-data.js";

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
 * like the real one, the workspace's version in etag where a version is asked about. */
function answer(status: number, text = "", headers: Record<string, string> = {}): Response {
	return new Response(status === 204 ? null : text, { status, headers });
}

/** A JSON answer, the way the API sends its lists and data. */
const jsonAnswer = (value: unknown, headers: Record<string, string> = {}) =>
	answer(200, JSON.stringify(value), { "content-type": "application/json; charset=utf-8", ...headers });

const JSON_BODY = { "content-type": "application/json" };

test("the workspaces are listed, made, renamed and deleted at their addresses, ids escaped", async () => {
	const api = fakeFetch((sent) => (sent.method === "GET" ? jsonAnswer([{ id: "a/b", name: "Erste" }]) : answer(sent.method === "POST" ? 201 : 204)));
	const port = httpData("http://api.local/");
	try {
		assert.deepEqual(await port.listWorkspaces(), [{ id: "a/b", name: "Erste" }]);
		await port.createWorkspace({ id: "a/b", name: "Erste" }, 1);
		await port.renameWorkspace("a/b", "Neu");
		await port.deleteWorkspace("a/b");
		assert.deepEqual(api.sent, [
			{ method: "GET", url: "http://api.local/workspaces", body: null, headers: {} },
			{ method: "POST", url: "http://api.local/workspaces", body: '{"id":"a/b","name":"Erste","dataVersion":1}', headers: JSON_BODY },
			{ method: "PATCH", url: "http://api.local/workspaces/a%2Fb", body: '{"name":"Neu"}', headers: JSON_BODY },
			{ method: "DELETE", url: "http://api.local/workspaces/a%2Fb", body: null, headers: {} },
		]);
	} finally {
		api.restore();
	}
});

test("load brings the workspace's data with the version its etag names; the API's 404 says null", async () => {
	const data = { version: 1, types: [], entities: [], boards: [] };
	const api = fakeFetch((sent) => (sent.url.includes("missing") ? answer(404) : jsonAnswer(data, { etag: "7" })));
	const port = httpData("http://api.local/");
	try {
		assert.deepEqual(await port.load("ws-1"), { data, version: "7" });
		assert.equal(await port.load("missing"), null);
		assert.equal(api.sent[0]!.url, "http://api.local/workspaces/ws-1/data");
		assert.equal(api.sent[0]!.method, "GET");
	} finally {
		api.restore();
	}
});

test("version HEADs the data's address and names the etag — the data itself never travels", async () => {
	const api = fakeFetch((sent) => (sent.url.includes("missing") ? answer(404) : answer(200, "", { etag: "8" })));
	const port = httpData("http://api.local/");
	try {
		assert.equal(await port.version("ws-1"), "8");
		assert.equal(await port.version("missing"), null);
		assert.deepEqual(api.sent[0], { method: "HEAD", url: "http://api.local/workspaces/ws-1/data", body: null, headers: {} });
	} finally {
		api.restore();
	}
});

test("an answer without a version is none the API gives: load and version reject", async () => {
	const api = fakeFetch(() => jsonAnswer({ version: 1, types: [], entities: [], boards: [] }));
	const port = httpData("http://api.local/");
	try {
		await assert.rejects(port.load("ws-1"));
		await assert.rejects(port.version("ws-1"));
	} finally {
		api.restore();
	}
});

test("saveChanges PUTs the change set to the workspace's changes route, settling with the API's answer", async () => {
	const api = fakeFetch(() => jsonAnswer({ version: "9", collided: ["ent-1"] }, { etag: "9" }));
	const port = httpData("http://api.local/");
	const changes: Change[] = [{ kind: "entity", id: "ent-1", before: null, after: { value: { id: "ent-1", typeId: "t", name: "Ada", content: "", description: "", values: {} }, position: 0 } }];
	try {
		assert.deepEqual(await port.saveChanges("ws-1", changes), { version: "9", collided: ["ent-1"] });
		assert.deepEqual(api.sent, [{ method: "PUT", url: "http://api.local/workspaces/ws-1/changes", body: JSON.stringify(changes), headers: JSON_BODY }]);
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
			: Promise.resolve(jsonAnswer({ version: "2", collided: [] })),
	);
	const port = httpData("http://api.local/");
	try {
		const saves = [port.saveChanges("ws-1", []), port.saveChanges("ws-2", [])];
		await new Promise((resolve) => setImmediate(resolve));
		// The first save is on its way, and the second isn't even sent before it is answered.
		assert.equal(api.sent.length, 1);
		answerTheFirst(jsonAnswer({ version: "1", collided: [] }));
		await Promise.all(saves);
		assert.deepEqual(api.sent.map((sent) => sent.url), ["http://api.local/workspaces/ws-1/changes", "http://api.local/workspaces/ws-2/changes"]);
	} finally {
		api.restore();
	}
});

test("a network gone to the API rejects each call of the port", async () => {
	const api = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
	const port = httpData("http://api.local/");
	try {
		await assert.rejects(port.listWorkspaces());
		await assert.rejects(port.load("ws-1"));
		await assert.rejects(port.saveChanges("ws-1", []));
		await assert.rejects(port.createWorkspace({ id: "x", name: "x" }, 1));
	} finally {
		api.restore();
	}
});

test("the API's 500 answers reject the calls, however readable their body looks", async () => {
	const api = fakeFetch(() => answer(500, "the database fell over"));
	const port = httpData("http://api.local/");
	try {
		await assert.rejects(port.listWorkspaces());
		await assert.rejects(port.load("ws-1"));
		await assert.rejects(port.version("ws-1"));
		await assert.rejects(port.saveChanges("ws-1", []));
		await assert.rejects(port.renameWorkspace("ws-1", "n"));
		await assert.rejects(port.deleteWorkspace("ws-1"));
	} finally {
		api.restore();
	}
});
