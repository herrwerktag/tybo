import type { Change, DataPort, SavedChanges, WorkspaceInfo } from "@tybo/core";

/**
 * The browser app's port into the storage API (apps/api), which keeps the workspaces and their data in
 * Postgres. The port is asynchronous, and so is HTTP: one call is one request, no detour. Answers other than
 * the API's own reject, the way the core expects a failing storage to.
 *
 * The API answers each workspace's version (the `etag` header) with its data, and with every save: the core
 * keeps it, and asks for it anew (a HEAD) to see whether someone else saved in between.
 */
export function httpData(apiUrl: string): DataPort {
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

	/** Sends `body` as JSON, the way the API reads it. */
	const json = (method: string, body: unknown): RequestInit => ({
		method,
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
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

		deleteWorkspace(id) {
			return inOrder(async () => void takeOrReject(await fetch(at("workspaces", id), { method: "DELETE" })));
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
			return inOrder(async () => (await takeOrReject(await fetch(at("workspaces", id, "changes"), json("PUT", changes)))).json() as Promise<SavedChanges>);
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
