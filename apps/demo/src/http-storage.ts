import type { StoragePort } from "@bekbon/core";

/**
 * The browser app's port into the storage API (apps/api), which keeps the texts under their keys — in
 * Postgres, of all places. The port is asynchronous, and so is HTTP: one call is one request, no
 * detour. Answers other than the API's own reject, the way the core expects a failing storage to.
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

	return {
		/** GET answers the text stored under the key — the API's 404 says none is (null, as the port promises). */
		async getItem(key) {
			return inOrder(async () => {
				const response = await fetch(textUrl(apiUrl, key));
				if (response.status === 404) return null;
				return storedText(response);
			});
		},

		/** PUT stores the value under the key; the promise settles when the API has taken it. */
		async setItem(key, value) {
			await inOrder(async () => {
				takeOrReject(await fetch(textUrl(apiUrl, key), { method: "PUT", body: value }));
			});
		},

		/** DELETE takes what's stored under the key (if any); the promise settles when the API has. */
		async removeItem(key) {
			await inOrder(async () => {
				takeOrReject(await fetch(textUrl(apiUrl, key), { method: "DELETE" }));
			});
		},
	};
}

/** The API's address of the text under `key`: escaped, so any key winds into one path. */
function textUrl(apiUrl: string, key: string): URL {
	return new URL(`texts/${encodeURIComponent(key)}`, apiUrl);
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
