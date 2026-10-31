import { unitKey, type Change } from "./changes.js";
import type { HistoryEntry, HistoryPage } from "./history.js";
import type { DataPort } from "./ports.js";

/** What went wrong reading the saved data; the UI shows it as a warning. Either way saving is paused, so
 * nothing here can overwrite what is stored. */
export type LoadProblem =
	/** The data couldn't be loaded (the storage didn't answer, or the workspace isn't there): this starts empty. */
	| { code: "unavailable" }
	/** Saved by a newer version of the app: read as far as understood. */
	| { code: "newerVersion" };

/**
 * What the store and the workspaces need to know of the data they hold: how it is read, saved, compared and
 * imported. The app's own format puts its parts together (see `APP_FORMAT` in features.core.ts).
 */
export interface DataFormat<D> {
	/** The version data is saved in now. */
	version: number;
	/** The data as the app holds it, of what the storage answered — or null when it isn't such data at all.
	 * `problem` says when it may not be saved over; `stand` is what the storage holds, as far as it compares,
	 * and null when nothing may be saved over it. */
	read(raw: unknown): { data: D; problem: LoadProblem | null; stand: D | null } | null;
	/** Whether `raw` has the outline of such data (a file to import, say); the rest is checked on reading. */
	looksLike(raw: unknown): boolean;
	/** Imported data as the app holds it — checked and completed the way a load does — or null when it isn't
	 * such data, or is from a newer version. */
	prepareImport(raw: unknown): D | null;
	/** What a workspace holds that couldn't be read: the data the app starts with. */
	empty(): D;
	/** What a workspace holds before its first save: nothing at all. */
	nothing(): D;
	/** The data as it is saved and exported. */
	toSaved(data: D): unknown;
	/** The units in which two states differ (see `changesOf`). */
	changesBetween(before: D, after: D): Change[];
	/** The state with the change set's units written into it, every other unit as it was (see `withChanges`). */
	withChanges(data: D, changes: readonly Change[]): D;
	/** What undo or redo bring back of `snapshot`, with what they leave as it is in `current` (e.g. pan and zoom). */
	restore(snapshot: D, current: D): D;
}

/** What a look for someone else's saves found (see `takeNewer`): nothing newer, or nothing it could take
 * over now; their units, now taken over here; or a newer stand it can't read, so it stays a hint. */
export type NewerStand = "current" | "taken" | "unreadable";

/** How many changes can be undone. */
const HISTORY_LIMIT = 100;

/**
 * The data of one workspace, kept in memory and saved through `port` as it changes: each change one step in the
 * undo history, written as the units it changed. What the data is, `format` says; the features change it through
 * `change` (see e.g. `addAnalysis`).
 */
export async function createStoreCore<D>(port: DataPort, workspaceId: string, format: DataFormat<D>) {
	// Declared before the load below, which already sets the stand it reads: these belong to the store from
	// its very first moment.
	/** The version the workspace's data was last read or saved at, as the storage named it. */
	let seenVersion: string | null = null;
	/** The saves on their way, one after the other, with the looks for a newer stand among them: a look waits
	 * behind the saves before it, so it can't mistake a stand this store is just about to reach with its own save
	 * for someone else's newer one, and the saves after it wait for what it takes over. */
	let savesSettled: Promise<void> = Promise.resolve();
	/** The look for a newer stand that's on its way; a second ask joins it rather than running alongside. */
	let newerLook: Promise<NewerStand> | null = null;
	let { data, problem: loadProblem, stand: baseline } = await load();
	/** The baseline as the app holds it (read: checked and completed), to tell what was changed here from what
	 * reading it completed. */
	let held = data;
	let saveFailed = false;
	let saveConflict = false;
	const problemListeners: (() => void)[] = [];
	/** Earlier versions of the data for undo (newest last), and undone ones for redo. */
	let undoStack: D[] = [];
	let redoStack: D[] = [];
	const historyListeners: (() => void)[] = [];
	/** The data as last saved, to tell changes that change nothing. */
	let savedJson = JSON.stringify(format.toSaved(data));

	async function load(): Promise<{
		data: D;
		problem: LoadProblem | null;
		/** The units the storage holds, as they were read — what the next change set is built from. Null when
		 * nothing may be saved over them (see `LoadProblem`). */
		stand: D | null;
	}> {
		let loaded: { data: unknown; version: string } | null;
		try {
			loaded = await port.load(workspaceId);
		} catch {
			loaded = null;
		}
		const read = loaded ? format.read(loaded.data) : null;
		if (!loaded || !read) return { data: format.empty(), problem: { code: "unavailable" }, stand: null };
		seenVersion = loaded.version;
		return read;
	}

	function save(): void {
		savedJson = JSON.stringify(format.toSaved(data));
		// Nothing is saved over data that wasn't read whole (`LoadProblem`). And after a save collided with
		// someone else's, keep this stand in memory until the data is read anew (reload).
		if (loadProblem || saveConflict) return;
		// The save waits its turn before it goes off: it builds on the stand the saves before it left in the
		// storage, so no unit changed in between is asked about twice (a save on its way stays unseen by a diff
		// built too early).
		savesSettled = savesSettled.then(() => persist(data));
	}

	/** Writes the units that differ from the stand the storage was last known to hold — a save that changes
	 * nothing writes nothing at all. That stand is only advanced once the storage has confirmed the write,
	 * so the units of a save that fails go out again with the next one.
	 *
	 * A write that fails flips `problems.saveFailed`. A unit someone else changed in between doesn't refuse
	 * the save — the storage answers its id (`collided`), wrote it anyway (last one wins) — and flips
	 * `problems.saveConflict`: saving pauses until the data is read anew (reload), everything changed stays
	 * in memory, and the problem says what happened.
	 */
	async function persist(stand: D): Promise<void> {
		const changes = format.changesBetween(baseline!, stand);
		if (changes.length === 0) return; // the storage already holds this stand — nothing to write, nothing to say
		let failed = false;
		let conflict = false;
		try {
			const answer = await port.saveChanges(workspaceId, changes);
			baseline = stand;
			held = stand;
			seenVersion = answer.version;
			conflict = answer.collided.length > 0;
		} catch {
			failed = true;
		}
		const changed = failed !== saveFailed || conflict !== saveConflict;
		saveFailed = failed;
		saveConflict = conflict;
		if (changed) {
			for (const listener of problemListeners) listener();
		}
	}

	/** Takes over the units someone else saved since `baseline` (see `takeNewer`); never rejects. */
	async function takeOver(canTake: () => boolean): Promise<NewerStand> {
		let loaded: { data: unknown; version: string } | null;
		try {
			if ((await port.version(workspaceId)) === seenVersion) return "current";
			loaded = await port.load(workspaceId);
		} catch {
			return "current"; // the look failed: nothing was changed here, and the next one may be answered
		}
		const read = loaded ? format.read(loaded.data) : null;
		if (!loaded || !read?.stand || read.problem) return "unreadable";
		if (!canTake()) return "current";
		const key = (unit: Change) => unitKey(unit.kind, unit.id);
		const own = new Set(format.changesBetween(held, data).map(key));
		// Theirs: what the storage holds now that this store didn't save, but for the units changed here too —
		// those keep the stand they were read at, so their save tells the collision.
		const theirs = format.changesBetween(baseline!, read.stand).filter((unit) => !own.has(key(unit)));
		// What reading completed and nobody saved yet (a new workspace's first board, say) is read anew too: the
		// newer stand may complete it otherwise, or not need it.
		const completed = format.changesBetween(baseline!, held).filter((unit) => !own.has(key(unit)));
		const changed = new Set([...theirs, ...completed].map(key));
		// Their units as the app holds them (read).
		const taking = format.changesBetween(held, read.data).filter((unit) => changed.has(key(unit)));
		baseline = format.withChanges(baseline!, theirs);
		held = format.withChanges(held, taking);
		seenVersion = loaded.version;
		if (taking.length === 0) return "current";
		// Pan and zoom stay this tab's own (see `restore`).
		data = format.restore(format.withChanges(data, taking), data);
		savedJson = JSON.stringify(format.toSaved(data));
		undoStack = undoStack.map((stand) => format.withChanges(stand, taking));
		redoStack = redoStack.map((stand) => format.withChanges(stand, taking));
		return "taken";
	}

	/** Makes `next` the data and saves it; the data before goes onto the undo history. Changes that change nothing are skipped. */
	function change(next: D): void {
		if (JSON.stringify(format.toSaved(next)) === savedJson) return;
		undoStack = [...undoStack.slice(1 - HISTORY_LIMIT), data];
		redoStack = [];
		data = next;
		save();
		for (const listener of historyListeners) listener();
	}

	/** Undo and redo bring back what `format.restore` says. */
	function restore(snapshot: D): void {
		data = format.restore(snapshot, data);
		save();
		for (const listener of historyListeners) listener();
	}

	return {
		get data(): D {
			return data;
		},

		/** Makes `next` the data and saves it, one step in the undo history — how the features change their part
		 * of it (see e.g. `addAnalysis`). Changes that change nothing are skipped. */
		change,

		/** Makes `next` the data and saves it without a step in the undo history (e.g. pan and zoom). */
		changeQuietly(next: D): void {
			data = next;
			save();
		},

		/** Problems reading the saved data, whether the last save failed (changes are then only in memory),
		 * and whether one collided with someone else's save in between (then saving stops until the data is
		 * read anew). */
		get problems(): { load: LoadProblem | null; saveFailed: boolean; saveConflict: boolean } {
			return { load: loadProblem, saveFailed, saveConflict };
		},

		/** Reads the saved data again, e.g. after another tab saved it, so the next save here doesn't overwrite that.
		 * Hereby this stand is current again too: saving, paused after a conflict, is tried once more. */
		async reload(): Promise<void> {
			await savesSettled; // a save on its way lands first, so the read sees it
			({ data, problem: loadProblem, stand: baseline } = await load());
			held = data;
			savedJson = JSON.stringify(format.toSaved(data));
			saveConflict = false;
			// The history is from before the other tab's changes; undoing it would undo those too.
			undoStack = [];
			redoStack = [];
			for (const listener of historyListeners) listener();
		},

		/** One page of the workspace's history, newest first, once the saves on their way have landed — so this
		 * store's own last write is in it. Rejects when the storage can't answer. */
		async readHistory(page: HistoryPage): Promise<HistoryEntry[]> {
			await savesSettled;
			return port.readHistory(workspaceId, page);
		},

		/** Settles once the saves on their way have landed, well or badly — `problems` says which. */
		saved(): Promise<void> {
			return savesSettled;
		},

		/** Calls `listener` whenever `problems.saveFailed` or `problems.saveConflict` changes. */
		onProblemsChange(listener: () => void): void {
			problemListeners.push(listener);
		},

		/** Takes over what someone else saved since this stand was last read or saved (another tab, a model
		 * through the MCP), unit by unit, without reloading: their units come in, the units changed here and not
		 * saved yet keep this store's own stand, and the next save builds on theirs, so it collides only where both
		 * changed the same unit. The undo history stays; its stands take over the same units, so undo and redo
		 * never bring back what someone else changed. `canTake` is asked last, right before anything changes here:
		 * while it says no, nothing is taken, and the next look tries again. A look the storage can't answer is
		 * no event; a newer stand it can't read (see `LoadProblem`) is left as it is, and only reported. */
		async takeNewer(canTake: () => boolean = () => true): Promise<NewerStand> {
			// Nothing read to be newer than, nothing that may be saved over, or saving paused after a collision:
			// the stand is left to the reload the user is offered.
			if (seenVersion === null || baseline === null || saveConflict) return "current";
			// One look at a time: a second ask joins the one on its way. The look takes its turn among the saves,
			// so it never takes this store's own save for someone else's, and no save goes off while it compares.
			newerLook ??= (async () => {
				const look = savesSettled.then(() => takeOver(canTake));
				savesSettled = look.then(() => undefined);
				try {
					return await look;
				} finally {
					newerLook = null; // free for the next look
				}
			})();
			return newerLook;
		},

		get history(): { canUndo: boolean; canRedo: boolean } {
			return { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
		},

		/** Takes back the last change; false if there's none. */
		undo(): boolean {
			const previous = undoStack.at(-1);
			if (!previous) return false;
			undoStack = undoStack.slice(0, -1);
			redoStack = [...redoStack, data];
			restore(previous);
			return true;
		},

		/** Makes the last undone change again; false if there's none. */
		redo(): boolean {
			const next = redoStack.at(-1);
			if (!next) return false;
			redoStack = redoStack.slice(0, -1);
			undoStack = [...undoStack, data];
			restore(next);
			return true;
		},

		/** Calls `listener` whenever `history` may have changed. */
		onHistoryChange(listener: () => void): void {
			historyListeners.push(listener);
		},
	};
}

/** The store of one workspace: its data, saving, undo and redo (see `createStoreCore`). */
export type StoreCore<D> = Awaited<ReturnType<typeof createStoreCore<D>>>;
