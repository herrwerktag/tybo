import { DATA_VERSION, type Change, type DataPort, type SavedChanges, type WorkspaceInfo } from "@tybo/app/core";

/**
 * The browser app's port into the storage API (apps/api), which keeps the workspaces and their data in
 * Postgres. The port is asynchronous, and so is HTTP: one call is one request, no detour. Answers other than
 * the API's own reject, the way the core expects a failing storage to.
 *
 * The API answers each workspace's version (the `etag` header) with its data, and with every save: the core
 * keeps it, and asks for it anew (a HEAD) to see whether someone else saved in between.
 *
 * `source` names who writes (say "web" or "mcp"): every write carries it in `X-Tybo-Source`, and the API's
 * history keeps it with each entry. Reads don't carry it — they write nothing. A save also names the format its
 * units are in (`X-Tybo-Data-Version`); the API refuses one in another format than its own.
 */
export function httpData(apiUrl: string, source?: string): DataPort {
	// One call after the other, in the order they came in: a request, once started, keeps running — without
	// waiting, a later save could arrive before an earlier one and leave older data behind as the saved state.
	let settled: Promise<unknown> = Promise.resolve();

	/** The call runs once the one before it is done, be that well or badly. */
	function inOrder<T>(call: () => Promise<T>): Promise<T> {
		const turn = settled.then(call);
		settled = turn.then(
			() => {},
			() => {},
		);
		return turn;
	}

	/** The API's address of `path` — the workspace ids in it escaped, so any id winds into one path. */
	const at = (...path: string[]) => new URL(path.map(encodeURIComponent).join("/"), apiUrl);

	/** The header naming who writes, when the port was told. */
	const named: Record<string, string> = source ? { "x-tybo-source": source } : {};

	/** Sends `body` as JSON, the way the API reads it — a write, so it names who writes. */
	const json = (method: string, body: unknown): RequestInit => ({
		method,
		body: JSON.stringify(body),
		headers: { "content-type": "application/json", ...named },
	});

	/** The request, naming the data format its units are in. */
	const inFormat = (init: RequestInit): RequestInit => ({
		...init,
		headers: { ...(init.headers as Record<string, string>), "x-tybo-data-version": String(DATA_VERSION) },
	});

	return {
		listWorkspaces() {
			return inOrder(async () => (await takeOrReject(await fetch(at("workspaces")))).json() as Promise<WorkspaceInfo[]>);
		},

		createWorkspace({ id, name }, dataVersion) {
			return inOrder(async () => void takeOrReject(await fetch(at("workspaces"), json("POST", { id, name, dataVersion }))));
		},

		renameWorkspace(id, name) {
			return inOrder(async () => void takeOrReject(await fetch(at("workspaces", id), json("PATCH", { name }))));
		},

		moveWorkspace(id, to) {
			return inOrder(async () => void takeOrReject(await fetch(at("workspaces", id), json("PATCH", { position: to }))));
		},

		deleteWorkspace(id) {
			return inOrder(async () => void takeOrReject(await fetch(at("workspaces", id), { method: "DELETE", headers: named })));
		},

		/** GET answers the workspace's data with its version in etag — the API's 404 says there is no such workspace. */
		load(id) {
			return inOrder(async () => {
				const response = await fetch(at("workspaces", id, "data"));
				if (response.status === 404) return null;
				const data: unknown = await takeOrReject(response).json();
				return { data, version: versionOf(response) };
			});
		},

		/** Names the version the workspace is at right now without carrying its data (a HEAD, one request) — or
		 * null where there is no such workspace (the API's 404). */
		version(id) {
			return inOrder(async () => {
				const response = await fetch(at("workspaces", id, "data"), { method: "HEAD" });
				if (response.status === 404) return null;
				return versionOf(takeOrReject(response));
			});
		},

		/** PUTs the change set to the workspace's changes route; settles with the API's own answer: the new
		 * version and the units that collided (written anyway, the last save wins). */
		saveChanges(id, changes: Change[]) {
			return inOrder(async () => (await takeOrReject(await fetch(at("workspaces", id, "changes"), inFormat(json("PUT", changes))))).json() as Promise<SavedChanges>);
		},
	};
}

/** The version an answer names in its etag; an answer without one is no answer the API gives. */
function versionOf(response: Response): string {
	const version = response.headers.get("etag");
	if (version === null) throw new Error("the API answered without a version");
	return version;
}

/** The API's own answer (2xx) — anything else (a 503 from a database gone, a 500, …) rejects. */
function takeOrReject(response: Response): Response {
	if (!response.ok) throw new Error(`the API answered ${response.status}`);
	return response;
}
