import { ChangesUnsupported, SaveConflict, type SavedChanges, type StoragePort } from "@bekbon/core";

/**
 * The browser app's port into the storage API (apps/api), which keeps the texts under their keys — in
 * Postgres, of all places. The port is asynchronous, and so is HTTP: one call is one request, no
 * detour. Answers other than the API's own reject, the way the core expects a failing storage to.
 *
 * The API answers each text's version (the `etag` header), and this port keeps track of it per key:
 * the version a GET answered comes back with the next PUT under the key (`if-match`), so a save can
 * only build on the stand it read. When someone else saved in between, the API refuses with 409 and
 * nothing is written; this port passes that on as what it is — a SaveConflict — so the caller can tell
 * it from a broken storage.
 *
 * What the app's data saves, it saves as a change set (`saveChanges`): the units that changed, per id,
 * PUT to the API's changes route for the key. The version the save builds on travels along the same
 * way — the API doesn't refuse an out-of-date one; the units' own `before` stands decide which of them
 * collided, and the answer says so, with the last save winning. An API older than that route answers
 * 404 for it: this port tells the core about that (`ChangesUnsupported`), and the core falls back on
 * the whole document, its one way as ever — one request per session of the port, and then none.
 */
export function httpStorage(apiUrl: string): StoragePort {
	// One call after the other, in the order they came in. The browser's storage does its work at
	// once, so earlier saves are never overtaken; a request, once started, keeps running — without
	// waiting, a later save could arrive before an earlier one and leave older data behind as the
	// saved state.
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

	/** The version the API last named per key: remembered from a GET, taken over from a PUT's answer. */
	const versions = new Map<string, string>();

	return {
		/** GET answers the text stored under the key — the API's 404 says none is stored there (null, as the port promises). */
		async getItem(key) {
			return inOrder(async () => {
				const response = await fetch(textUrl(apiUrl, key));
				if (response.status === 404) {
					// Nothing stored under the key, so the next save under it is a first write.
					versions.delete(key);
					return null;
				}
				const text = await storedText(response);
				remember(key, response);
				return text;
			});
		},

		/** PUT stores the value under the key, naming the stand it read; the promise settles when the API has
		 * taken it — or refused it as outdated, which rejects as a SaveConflict. */
		async setItem(key, value) {
			await inOrder(async () => {
				const seen = versions.get(key);
				const response = await fetch(textUrl(apiUrl, key), {
					method: "PUT",
					body: value,
					headers: seen ? { "if-match": seen } : {},
				});
				if (response.status === 409) {
					// Someone else saved the key in between: this stand is outdated, not the storage broken.
					throw new SaveConflict(key);
				}
				takeOrReject(response);
				remember(key, response);
			});
		},

		/** PUTs the change set to the API's changes route, naming the stand the save builds on; the promise
		 * settles with the API's own answer: the new version and the units that collided (written anyway,
		 * the last save wins) — or rejects: 404 from an older API tells the core that change sets are
		 * nothing this API has (the whole document remains), anything else is a failing storage. */
		async saveChanges(key, changes, version) {
			return inOrder(async (): Promise<SavedChanges> => {
				const seen = version ?? versions.get(key) ?? null;
				const response = await fetch(changesUrl(apiUrl, key), {
					method: "PUT",
					body: JSON.stringify(changes),
					headers: {
						"content-type": "application/json",
						...(seen ? { "if-match": seen } : {}),
					},
				});
				if (response.status === 404) {
					// An API older than the route: not an error, no data at risk — the core's other way.
					throw new ChangesUnsupported(key);
				}
				takeOrReject(response);
				const answer = JSON.parse(await response.text()) as SavedChanges;
				versions.set(key, answer.version);
				return answer;
			});
		},

		/** DELETE takes what's stored under the key (if any); the promise settles when the API has. */
		async removeItem(key) {
			await inOrder(async () => {
				takeOrReject(await fetch(textUrl(apiUrl, key), { method: "DELETE" }));
				// The text is gone: a next save under this key starts over, as a first write.
				versions.delete(key);
			});
		},

		/** Names the version the text under the key is at right now — or null if none is stored — without carrying
		 * the text itself (a HEAD, one request). A look of its own: it never touches the stand this port names with
		 * its saves (`if-match`), which stays what getItem and setItem last saw — so a look can't quietly tune the
		 * next save to what someone else saved in between. Like the other calls, an answer other than the API's own
		 * rejects; where nothing is stored the API's 404 says null, as the port promises. */
		async version(key) {
			return inOrder(async () => {
				const response = await fetch(textUrl(apiUrl, key), { method: "HEAD" });
				if (response.status === 404) return null;
				const version = takeOrReject(response).headers.get("etag");
				if (version === null) throw new Error("the API answered without a version"); // a failed look, not an empty storage
				return version;
			});
		},
	};

	/** Takes the version the answer carries, so the next save under the key names this new stand. */
	function remember(key: string, response: Response): void {
		const version = response.headers.get("etag");
		if (version !== null) versions.set(key, version);
	}
}

/** The API's address of the text under `key`: escaped, so any key winds into one path. */
function textUrl(apiUrl: string, key: string): URL {
	return new URL(`texts/${encodeURIComponent(key)}`, apiUrl);
}

/** The API's address of the change set under `key`: the text's own path, with its changes route on it. */
function changesUrl(apiUrl: string, key: string): URL {
	return new URL(`texts/${encodeURIComponent(key)}/changes`, apiUrl);
}

/** The API's answer as the stored text. */
async function storedText(response: Response): Promise<string> {
	return (await takeOrReject(response)).text();
}

/** The API's own answer (2xx) — anything else (a 503 from a database gone, a 500, …) rejects. */
function takeOrReject(response: Response): Response {
	if (!response.ok) throw new Error(`the API answered ${response.status}`);
	return response;
}
