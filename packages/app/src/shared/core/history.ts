import type { Change } from "./changes.js";

/**
 * The history as it is read: every write of a workspace, kept by the storage (see shared/api, history.ts, for how
 * it is written). The UI reads it through the port, page by page, newest first.
 */

/** What was written: a unit of the data (`change`), or the workspace itself. `baseline` is no write: it is where
 * the history of a workspace made before there was one starts — everything it held then. */
export type HistoryOperation = "change" | "create" | "rename" | "move" | "delete" | "baseline";

/** One entry as the history answers it. `id` orders the entries (newest is highest) and pages through them;
 * `revision` is the workspace's after the write — the same for every unit of one save. */
export interface HistoryEntry {
	id: string;
	workspaceId: string;
	revision: string | null;
	at: string;
	/** Who wrote, as the request named itself (`X-Tybo-Source`); null when it didn't. */
	source: string | null;
	operation: HistoryOperation;
	/** The format `before` and `after` are in — the app's DATA_VERSION when the entry was written. */
	dataVersion: number;
	/** For `change`: which unit — its kind, its id, and the board a card or drawing stands on. */
	kind: Change["kind"] | null;
	unitId: string | null;
	boardId: string | null;
	/** For `change`: the unit's stand (see `UnitStand`) before and after; for the workspace's own writes, what
	 * they changed of it (its name, its position). */
	before: unknown;
	after: unknown;
	/** For `change`: someone else had changed the unit since the saver read it (written anyway). */
	collided: boolean;
}

/** How a read pages: entries older than `before` (an entry's id), at most `limit` of them. */
export interface HistoryPage {
	before?: string;
	limit: number;
}
