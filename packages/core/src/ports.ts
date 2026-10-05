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

/**
 * What a storage rejects a save with when the data under the key was changed by someone else since it was
 * read here — another tab, another device. The stand it was read from is outdated, and writing it would
 * quietly run over the other's work, so the storage refuses and throws this instead. The core tells it
 * from an ordinary failure (full or blocked storage, say) and reports the conflict as its own problem.
 *
 * A storage throws this where it can tell the difference: the HTTP storage from the API's 409, for instance.
 */
export class SaveConflict extends Error {
	/** `key` names the data someone else has saved over in the meantime. */
	constructor(key: string) {
		super(`the data under "${key}" was changed by someone else in the meantime`);
		this.name = "SaveConflict";
	}
}
