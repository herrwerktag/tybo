import type { Change, UnitStands } from "@tybo/core";
import type { Queries } from "./schema.js";

/**
 * The history: every write, kept. A save leaves one entry per unit it wrote — with the stand the tables held
 * before (not the one the saver believed in, so a collision shows what was really written over) and the one
 * it wrote — and every write of a workspace itself (made, renamed, moved, deleted) one entry too. Entries are
 * only ever added, in the same transaction as the write they tell of: no write without its entry, no entry
 * of a write that was rolled back.
 *
 * The history has no reference to its workspace, so it outlives it: a deleted workspace's entries stay, the
 * last one with everything the workspace held when it went.
 */

/** What was written: a unit of the data (`change`), or the workspace itself. */
export type HistoryOperation = "change" | "create" | "rename" | "move" | "delete";

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
	/** For `change`: which unit — its kind, its id, and the board a card or drawing stands on. */
	kind: Change["kind"] | null;
	unitId: string | null;
	boardId: string | null;
	before: unknown;
	after: unknown;
	/** For `change`: someone else had changed the unit since the saver read it (written anyway). */
	collided: boolean;
}

/** One entry to add — what the writer knows; id and time the storage gives it. */
export type NewEntry = Pick<HistoryEntry, "operation" | "before" | "after"> &
	Partial<Pick<HistoryEntry, "revision" | "kind" | "unitId" | "boardId" | "collided">>;

/** How a read pages: entries older than `before` (an entry's id), at most `limit` of them. */
export interface HistoryPage {
	before?: string;
	limit: number;
}

/** The entries of a save: each unit with the stand the tables held before (`stands`, read in the save's own
 * transaction) and the one written, and whether it collided. */
export function changeEntries(stands: UnitStands, changes: readonly Change[], collided: readonly string[]): NewEntry[] {
	return changes.map((unit) => ({
		operation: "change",
		kind: unit.kind,
		unitId: unit.id,
		boardId: "boardId" in unit ? unit.boardId : null,
		before: stands.get(`${unit.kind}:${unit.id}`)?.stand ?? null,
		after: unit.after,
		collided: collided.includes(unit.id),
	}));
}

/** The jsonb parameter the driver makes (`null` stays SQL null, not jsonb `null`). */
function jsonbParameter(queries: Queries, value: unknown) {
	return value === null || value === undefined ? null : queries.json(value as never);
}

/** Adds the entries for the workspace, within the transaction of the write they tell of. */
export async function recordHistory(tx: Queries, workspaceId: string, source: string | null, entries: readonly NewEntry[]): Promise<void> {
	for (const entry of entries) {
		await tx`insert into history (workspace_id, revision, source, operation, kind, unit_id, board_id, before, after, collided)
			values (${workspaceId}, ${entry.revision ?? null}, ${source}, ${entry.operation}, ${entry.kind ?? null}, ${entry.unitId ?? null},
				${entry.boardId ?? null}, ${jsonbParameter(tx, entry.before)}, ${jsonbParameter(tx, entry.after)}, ${entry.collided ?? false})`;
	}
}

/** The workspace's entries, newest first — also of a workspace that is gone. */
export async function readHistory(queries: Queries, workspaceId: string, page: HistoryPage): Promise<HistoryEntry[]> {
	const rows = await queries`select id::text as id, workspace_id, revision::text as revision, at, source, operation, kind, unit_id, board_id,
			before, after, collided
		from history
		where workspace_id = ${workspaceId} ${page.before === undefined ? queries`` : queries`and id < ${page.before}`}
		order by id desc
		limit ${page.limit}`;
	return rows.map((row) => ({
		id: row.id as string,
		workspaceId: row.workspace_id as string,
		revision: (row.revision as string | null) ?? null,
		at: (row.at as Date).toISOString(),
		source: (row.source as string | null) ?? null,
		operation: row.operation as HistoryOperation,
		kind: (row.kind as Change["kind"] | null) ?? null,
		unitId: (row.unit_id as string | null) ?? null,
		boardId: (row.board_id as string | null) ?? null,
		before: row.before ?? null,
		after: row.after ?? null,
		collided: Boolean(row.collided),
	}));
}
