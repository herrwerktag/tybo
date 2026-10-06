import type { Change } from "./changes.js";

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
	/** The version the text under `key` is at right now, or null if none is stored there. Optional, because only a
	 * storage that keeps versions can answer it: without this method, nothing is worse off — asking newer questions
	 * simply gets no answer (always "nothing newer"), and every call of the core runs as before. The version tells
	 * the stand someone would save against from the stand saved meanwhile, without carrying the whole text. */
	version?(key: string): Promise<string | null>;
	/** Saves only the units that changed since the stand they were last read or saved at, each with its
	 * `before` and `after` (see `changesBetween` in changes.js). Optional, because only a storage that writes
	 * to addressable units can take a change set: without this method, every save writes the whole document
	 * over `setItem` — exactly as before — and localStorage, whose texts have no units, stays as it is. A save
	 * that names a unit someone else wrote in between doesn't reject: the answer lists it under `collided`,
	 * it was written anyway (last one wins), and the user can reload to see the other's stand. */
	saveChanges?(key: string, changes: Change[], version: string | null): Promise<SavedChanges>;
}

/** What a save of a change set answers: the stand's new version, and which units collided. */
export interface SavedChanges {
	/** The version the data under `key` is at now — the stand the units were merged into. */
	version: string;
	/** The ids of the units someone else had changed since this stand last read or saved them. They were
	 * written anyway (last one wins), so the save went through — but it built on older units than it
	 * thought, and the saver tells its user about that the way it tells a `SaveConflict` (the same banner,
	 * the same reload): here its own save stands, and the other's was written over by it. */
	collided: string[];
}

/**
 * What a storage throws from `saveChanges` when it has no place the units could be written to — the changes
 * route isn't there (an older API), say, or the key's data isn't kept in addressable units at all. Nothing is
 * lost for it: the core then saves the whole document over `setItem`, the way it always has.
 */
export class ChangesUnsupported extends Error {
	constructor(key: string) {
		super(`the storage can't write change sets under "${key}"`);
		this.name = "ChangesUnsupported";
	}
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
