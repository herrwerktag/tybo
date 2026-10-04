/**
 * How the core reaches its saved data: texts under keys, asynchronously. The environment provides the port —
 * the browser app wraps localStorage in one, a server could keep the very same core in Postgres instead.
 *
 * Calls that can't be carried out reject, and the core reacts to that the way it reacts today to blocked local
 * storage: it keeps working with what it holds in memory and reports the failure where the user can act on it.
 */
export interface StoragePort {
	/** The text saved under `key`, or null if there is none (yet). */
	getItem(key: string): Promise<string | null>;
	/** Saves `text` under `key`; rejects if the text can't be saved. */
	setItem(key: string, value: string): Promise<void>;
	/** Removes the text under `key` (if any); rejects if it can't be removed. */
	removeItem(key: string): Promise<void>;
}
