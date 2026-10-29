import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION, moveItem, storedFeatureData } from "@tybo/app/core";
import type { HistoryPage } from "./history.js";
import { DEFAULT_PORT, portFromEnv, type Api } from "./http.js";
import { call, startApp } from "./test-server.js";

/** The API on workspaces held in memory — what the database does, without needing one. A change set isn't
 * applied (the database tests cover that); it only grows the revision by one, the way a save does, and
 * reports every unit it deletes as collided, so the answer has something to carry. It keeps the source each
 * write named (`sources`) and the pages the history was asked for (`pages`), answering no entries. */
function memoryApi(
	healthy: () => Promise<boolean> = async () => true,
): Api & { writes: () => number; sources: (string | null | undefined)[]; pages: { id: string; page: HistoryPage }[] } {
	let workspaces = new Map<string, { name: string; dataVersion: number; revision: number }>();
	let written = 0;
	const sources: (string | null | undefined)[] = [];
	const pages: { id: string; page: HistoryPage }[] = [];
	return {
		healthy,
		listWorkspaces: async () => [...workspaces].map(([id, { name }]) => ({ id, name })),
		createWorkspace: async ({ id, name }, dataVersion, source) => {
			sources.push(source);
			if (workspaces.has(id)) return false;
			workspaces.set(id, { name, dataVersion, revision: 0 });
			return true;
		},
		renameWorkspace: async (id, name, source) => {
			sources.push(source);
			const workspace = workspaces.get(id);
			if (!workspace) return false;
			workspace.name = name;
			return true;
		},
		moveWorkspace: async (id, to, source) => {
			sources.push(source);
			const entries = [...workspaces];
			const from = entries.findIndex(([key]) => key === id);
			if (from < 0) return false;
			workspaces = new Map(moveItem(entries, from, to));
			return true;
		},
		deleteWorkspace: async (id, source) => {
			sources.push(source);
			workspaces.delete(id);
		},
		readWorkspace: async (id) => {
			const workspace = workspaces.get(id);
			if (!workspace) return null;
			return { data: { version: workspace.dataVersion, types: [], entities: [], boards: [], ...storedFeatureData({}) }, revision: String(workspace.revision) };
		},
		workspaceRevision: async (id) => {
			const workspace = workspaces.get(id);
			return workspace ? String(workspace.revision) : null;
		},
		writeChanges: async (id, changes, source) => {
			sources.push(source);
			const workspace = workspaces.get(id);
			if (!workspace) return null;
			written++;
			workspace.revision++;
			return { version: String(workspace.revision), collided: changes.flatMap((c) => (c.after === null ? [c.id] : [])) };
		},
		readHistory: async (id, page) => {
			pages.push({ id, page });
			return [];
		},
		writes: () => written,
		sources,
		pages,
	};
}

/** The API against a storage whose every call fails, like a database that is gone. */
function failingApi(): Api {
	const gone = async (): Promise<never> => {
		throw new Error("the storage is gone");
	};
	return {
		healthy: async () => false,
		listWorkspaces: gone,
		createWorkspace: gone,
		renameWorkspace: gone,
		moveWorkspace: gone,
		deleteWorkspace: gone,
		readWorkspace: gone,
		workspaceRevision: gone,
		writeChanges: gone,
		readHistory: gone,
	};
}

/** A POST that makes the workspace `id`, answering what the API said. */
const create = (base: URL, id: string, name = "Arbeit", dataVersion = 1) =>
	call(base, "workspaces", { method: "POST", body: JSON.stringify({ id, name, dataVersion }) });

/** A change set of one new entity — enough of one for the route to take. */
const oneNewEntity = JSON.stringify([{ kind: "entity", id: "ent-1", before: null, after: { value: { id: "ent-1" }, position: 0 } }]);

test("workspaces are listed, made, renamed and deleted — each answer with its status", async () => {
	const api = await startApp(memoryApi());
	try {
		assert.deepEqual(JSON.parse((await call(api.url, "workspaces")).text), []);

		assert.equal((await create(api.url, "ws-1", "Erste")).status, 201);
		assert.equal((await create(api.url, "ws-2", "Zweite")).status, 201);
		const list = await call(api.url, "workspaces");
		assert.equal(list.status, 200);
		assert.equal(list.header("content-type"), "application/json; charset=utf-8");
		assert.deepEqual(JSON.parse(list.text), [
			{ id: "ws-1", name: "Erste" },
			{ id: "ws-2", name: "Zweite" },
		]);

		const renamed = await call(api.url, "workspaces/ws-1", { method: "PATCH", body: JSON.stringify({ name: "  Neu  " }) });
		assert.equal(renamed.status, 204);
		assert.equal(JSON.parse((await call(api.url, "workspaces")).text)[0].name, "Neu", "the name is kept trimmed");

		const moved = await call(api.url, "workspaces/ws-2", { method: "PATCH", body: JSON.stringify({ position: 0 }) });
		assert.equal(moved.status, 204);
		assert.deepEqual(
			JSON.parse((await call(api.url, "workspaces")).text).map((w: { id: string }) => w.id),
			["ws-2", "ws-1"],
		);

		assert.equal((await call(api.url, "workspaces/ws-1", { method: "DELETE" })).status, 204);
		assert.equal((await call(api.url, "workspaces/ws-1", { method: "DELETE" })).status, 204, "gone already is no error");
		assert.deepEqual(JSON.parse((await call(api.url, "workspaces")).text), [{ id: "ws-2", name: "Zweite" }]);
	} finally {
		await api.close();
	}
});

test("a workspace id that is taken answers 409, and a body that says too little answers 400", async () => {
	const api = await startApp(memoryApi());
	try {
		assert.equal((await create(api.url, "ws-1", "Erste")).status, 201);
		assert.equal((await create(api.url, "ws-1", "Noch eine")).status, 409);
		assert.equal(JSON.parse((await call(api.url, "workspaces")).text)[0].name, "Erste", "nothing was written over");

		for (const body of ["not json", "{}", '{"id":"x","name":"  ","dataVersion":1}', '{"id":"","name":"n","dataVersion":1}', '{"id":"x","name":"n","dataVersion":-1}', '{"id":"x","name":"n"}']) {
			assert.equal((await call(api.url, "workspaces", { method: "POST", body })).status, 400, `"${body}" makes no workspace`);
		}
		for (const body of ["not json", "{}", '{"name":""}', '{"name":5}', '{"position":-1}', '{"position":1.5}']) {
			assert.equal((await call(api.url, "workspaces/ws-1", { method: "PATCH", body })).status, 400, `"${body}" is no name`);
		}
		assert.equal((await call(api.url, "workspaces/none", { method: "PATCH", body: '{"name":"n"}' })).status, 404);
		assert.equal((await call(api.url, "workspaces/none", { method: "PATCH", body: '{"position":0}' })).status, 404);
	} finally {
		await api.close();
	}
});

test("a workspace's data is answered as JSON with its revision in etag; HEAD answers the revision alone", async () => {
	const api = await startApp(memoryApi());
	try {
		assert.equal((await call(api.url, "workspaces/ws-1/data")).status, 404);
		assert.equal((await call(api.url, "workspaces/ws-1/data", { method: "HEAD" })).status, 404);

		await create(api.url, "ws-1");
		const got = await call(api.url, "workspaces/ws-1/data");
		assert.equal(got.status, 200);
		assert.equal(got.header("content-type"), "application/json; charset=utf-8");
		assert.deepEqual(JSON.parse(got.text), { version: 1, types: [], entities: [], boards: [], ...storedFeatureData({}) });
		assert.equal(got.header("etag"), "0");

		const head = await call(api.url, "workspaces/ws-1/data", { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.text, ""); // a HEAD carries no body
		assert.equal(head.header("etag"), "0");

		// Someone saves: the next look names the newer revision, still without the data.
		await call(api.url, "workspaces/ws-1/changes", { method: "PUT", body: oneNewEntity });
		assert.equal((await call(api.url, "workspaces/ws-1/data", { method: "HEAD" })).header("etag"), "1");
	} finally {
		await api.close();
	}
});

test("ids keep the characters they came with, escaped in the URL", async () => {
	const api = await startApp(memoryApi());
	try {
		const id = "ws/ü?#1";
		assert.equal((await create(api.url, id)).status, 201);
		assert.equal((await call(api.url, `workspaces/${encodeURIComponent(id)}/data`)).status, 200);
		assert.equal((await call(api.url, `workspaces/${encodeURIComponent(id)}`, { method: "PATCH", body: '{"name":"n"}' })).status, 204);
	} finally {
		await api.close();
	}
});

test("the change-set route answers version and collisions, with the version in etag", async () => {
	const behind = memoryApi();
	const api = await startApp(behind);
	try {
		await create(api.url, "ws-1");
		const body = JSON.stringify([
			{ kind: "entity", id: "ent-1", before: null, after: { value: { id: "ent-1" }, position: 0 } },
			{ kind: "card", id: "card-1", boardId: "board-1", before: { value: { id: "card-1" }, position: 0 }, after: null },
		]);
		const put = await call(api.url, "workspaces/ws-1/changes", { method: "PUT", body });
		assert.equal(put.status, 200);
		assert.equal(put.header("content-type"), "application/json; charset=utf-8");
		assert.deepEqual(JSON.parse(put.text), { version: "1", collided: ["card-1"] });
		assert.equal(put.header("etag"), "1");
		assert.equal(behind.writes(), 1);

		assert.equal((await call(api.url, "workspaces/none/changes", { method: "PUT", body })).status, 404);
	} finally {
		await api.close();
	}
});

test("a change set that isn't one answers 400 and writes nothing", async () => {
	const behind = memoryApi();
	const api = await startApp(behind);
	try {
		await create(api.url, "ws-1");
		// Not JSON, not an array, not a unit: refused, nothing asked of the storage behind. (An empty
		// change set is a valid one — it just has nothing to write, the DB tests cover it.)
		for (const body of ["not json", "{}", '[{"kind":"star","id":"x"}]', '[{"kind":"type","id":""}]', '[{"kind":"card","id":"c"}]', '[{"kind":"type","id":"t","before":null,"after":null}]']) {
			const refused = await call(api.url, "workspaces/ws-1/changes", { method: "PUT", body });
			assert.equal(refused.status, 400, `"${body}" should not be a change set`);
		}
		assert.equal(behind.writes(), 0);
	} finally {
		await api.close();
	}
});

test("every write hands the storage the source the request named itself with, or null", async () => {
	const behind = memoryApi();
	const api = await startApp(behind);
	try {
		const from = (source: string) => ({ "x-tybo-source": source });
		await call(api.url, "workspaces", { method: "POST", headers: from("demo"), body: JSON.stringify({ id: "ws-1", name: "A", dataVersion: 1 }) });
		await call(api.url, "workspaces/ws-1", { method: "PATCH", headers: from(" mcp "), body: '{"name":"B"}' });
		await call(api.url, "workspaces/ws-1", { method: "PATCH", headers: from(""), body: '{"position":0}' });
		await call(api.url, "workspaces/ws-1/changes", { method: "PUT", headers: from("x".repeat(65)), body: oneNewEntity });
		await call(api.url, "workspaces/ws-1", { method: "DELETE" });
		assert.deepEqual(behind.sources, ["demo", "mcp", null, null, null], "trimmed; empty, overlong or missing is none");
	} finally {
		await api.close();
	}
});

test("the history route answers the storage's entries for the page asked, and 400 for a page that isn't one", async () => {
	const behind = memoryApi();
	const api = await startApp(behind);
	try {
		const all = await call(api.url, "workspaces/gone/history");
		assert.equal(all.status, 200, "also for a workspace that isn't there (anymore)");
		assert.deepEqual(JSON.parse(all.text), []);
		assert.equal((await call(api.url, "workspaces/ws-1/history?limit=5&before=42")).status, 200);
		assert.equal((await call(api.url, "workspaces/ws-1/history?limit=1000")).status, 200);
		assert.deepEqual(behind.pages, [
			{ id: "gone", page: { limit: 100 } },
			{ id: "ws-1", page: { limit: 5, before: "42" } },
			{ id: "ws-1", page: { limit: 1000 } },
		]);
		for (const query of ["limit=0", "limit=1001", "limit=x", "limit=1.5", "before=-1", "before=abc", "before="]) {
			assert.equal((await call(api.url, `workspaces/ws-1/history?${query}`)).status, 400, `${query} isn't a page`);
		}
		assert.equal(behind.pages.length, 3);
	} finally {
		await api.close();
	}
});

test("a change set in another data format than the API's answers 409 and writes nothing; one naming none is taken", async () => {
	const behind = memoryApi();
	const api = await startApp(behind);
	try {
		await create(api.url, "ws-1");
		const put = (headers: Record<string, string>) => call(api.url, "workspaces/ws-1/changes", { method: "PUT", headers, body: oneNewEntity });
		assert.equal((await put({ "x-tybo-data-version": String(DATA_VERSION - 1) })).status, 409, "an older tab");
		assert.equal((await put({ "x-tybo-data-version": "neu" })).status, 409);
		assert.equal(behind.writes(), 0);
		assert.equal((await put({ "x-tybo-data-version": String(DATA_VERSION) })).status, 200);
		assert.equal((await put({})).status, 200);
		assert.equal(behind.writes(), 2);
	} finally {
		await api.close();
	}
});

test("/health says 200 while the storage answers, and 503 once it doesn't", async () => {
	const api = await startApp(memoryApi());
	try {
		assert.equal((await call(api.url, "health")).status, 200);
	} finally {
		await api.close();
	}

	const sick = await startApp(memoryApi(async () => false));
	try {
		assert.equal((await call(sick.url, "health")).status, 503);
	} finally {
		await sick.close();
	}
});

test("requests the API doesn't serve answer 404, or 405 where only the method is wrong", async () => {
	const api = await startApp(memoryApi());
	try {
		for (const path of ["nowhere", "texts/entities-app", "workspaces/", "workspaces/ws-1/elsewhere", "workspaces/ws-1/data/more"]) {
			assert.equal((await call(api.url, path)).status, 404, `${path} leads nowhere`);
		}
		assert.equal((await call(api.url, "workspaces", { method: "DELETE" })).status, 405);
		assert.equal((await call(api.url, "workspaces/ws-1")).status, 405);
		assert.equal((await call(api.url, "workspaces/ws-1/data", { method: "PUT", body: "{}" })).status, 405);
		assert.equal((await call(api.url, "workspaces/ws-1/changes")).status, 405);
		assert.equal((await call(api.url, "workspaces/ws-1/history", { method: "DELETE" })).status, 405);
		assert.equal((await call(api.url, "health", { method: "PUT", body: "x" })).status, 405);
	} finally {
		await api.close();
	}
});

test("a failing storage answers 503, without anything that could explain why", async () => {
	const api = await startApp(failingApi());
	try {
		const list = await call(api.url, "workspaces");
		assert.equal(list.status, 503);
		assert.equal(list.text, "");
		assert.equal((await create(api.url, "ws-1")).status, 503);
		assert.equal((await call(api.url, "workspaces/ws-1/data")).status, 503);
		assert.equal((await call(api.url, "workspaces/ws-1/data", { method: "HEAD" })).status, 503);
		assert.equal((await call(api.url, "workspaces/ws-1/changes", { method: "PUT", body: oneNewEntity })).status, 503);
		assert.equal((await call(api.url, "workspaces/ws-1", { method: "DELETE" })).status, 503);
		assert.equal((await call(api.url, "workspaces/ws-1/history")).status, 503);
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
	assert.equal(response.header("access-control-allow-methods"), "GET, HEAD, POST, PUT, PATCH, DELETE");
	assert.equal(response.header("access-control-allow-headers"), "Content-Type, X-Tybo-Source, X-Tybo-Data-Version");
	assert.equal(response.header("access-control-expose-headers"), "ETag");
}

test("the browser's preflight is answered 204 with what it asks for", async () => {
	const api = await startApp(memoryApi(), demoOrigin);
	try {
		const preflight = await call(api.url, "workspaces/ws-1/changes", {
			method: "OPTIONS",
			headers: { "access-control-request-method": "PUT", "access-control-request-headers": "content-type, x-tybo-source" },
		});
		assert.equal(preflight.status, 204);
		assertCrossOriginAllowed(preflight, demoOrigin);
	} finally {
		await api.close();
	}
});

test("every answer carries the same allowance, a 404 and a HEAD included, so the browser accepts them", async () => {
	const api = await startApp(memoryApi(), demoOrigin);
	try {
		const answers = [
			await create(api.url, "ws-1"),
			await call(api.url, "workspaces"),
			await call(api.url, "workspaces/ws-1/data"),
			await call(api.url, "workspaces/ws-1/data", { method: "HEAD" }),
			await call(api.url, "workspaces/ws-1/changes", { method: "PUT", body: oneNewEntity }),
			await call(api.url, "workspaces/ws-1", { method: "PATCH", body: '{"name":"n"}' }),
			await call(api.url, "workspaces/none/data"),
			await call(api.url, "workspaces/ws-1", { method: "DELETE" }),
		];
		for (const answer of answers) assertCrossOriginAllowed(answer, demoOrigin);
		assert.equal(answers[6]!.status, 404);
	} finally {
		await api.close();
	}
});
