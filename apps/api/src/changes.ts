import type { Change, SavedChanges } from "@tybo/app/core";
import { inKindOrder, unitStandsOf, untouched } from "@tybo/app/core";
import { readAppData } from "./data.js";
import { changeEntries, recordHistory } from "./history.js";
import type { Queries, Sql } from "./schema.js";
import { STORED_KINDS, storageOf } from "@tybo/app/api";

/**
 * The change-set writer: the one way the app's data is written. A save never carries the whole document —
 * only the units it changed, each by its id, so whoever moves a card and whoever edits an entity write
 * different rows, let alone collide on them.
 *
 * Which units collided decides the writer, one at a time: a unit whose `before` is the stand the tables
 * hold right now — or whose absence its "new" says — was touched by nobody else and writes without a
 * word. A unit whose stand differs (someone else changed it in between, or it went away) is a collision;
 * it is written anyway — the last save wins — and its id is reported back, so the saver can tell its user
 * about it: warn, keep the own changes, reload to see the rest. Units a change set never names are never
 * touched at all.
 *
 * All-or-nothing: the whole save runs in one transaction, which also raises the workspace's revision by
 * one and adds the save's entries to the history, so the rows, the version and the history can't disagree
 * afterwards.
 */

/** Whether `raw` is a change set: an array of units, each with its `kind` (one the storages know, see
 * units.ts), a non-empty `id`, at least one of `before`/`after` (a unit can't be neither — and a new one
 * that is already gone nobody asks for), and for the kinds standing on a board (cards, drawings) the board
 * they stand on. What a stand holds — a type with its properties, a card's numbers — is the writer's
 * business with the database: what doesn't fit makes the save fail as a whole, its transaction refused,
 * nothing written. Null when `raw` isn't such an array at all — the request is refused without touching a
 * thing. */
export function parseChanges(raw: unknown): Change[] | null {
	if (!Array.isArray(raw)) return null;
	const changes: Change[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) return null;
		const { kind, id, boardId, before, after } = entry as Record<string, unknown>;
		if (typeof kind !== "string" || !storageOf(kind)) return null;
		if (typeof id !== "string" || id === "") return null;
		const onBoard = storageOf(kind)!.unit.onBoard === true;
		if (onBoard && (typeof boardId !== "string" || boardId === "")) return null;
		const was = stand(before);
		const now = stand(after);
		if (was === undefined || now === undefined) return null;
		if (was === null && now === null) return null;
		// What a stand holds is the unit's own (a type with its properties, a card's numbers …): the database
		// makes the whole save fail on what doesn't fit — nothing written. Here, only the unit's address is
		// the request's shape to answer for.
		const wireUnit = onBoard
			? { kind, id, boardId: boardId as string, before: was, after: now }
			: { kind, id, before: was, after: now };
		changes.push(wireUnit as Change);
	}
	return changes;
}

/** A stand as it came over the wire: null when the unit wasn't (or isn't) there, or `{ value, position }`
 * with its place in its list. Undefined marks anything that isn't such a stand. */
function stand(raw: unknown): { value: object; position: number } | null | undefined {
	if (raw === null) return null;
	if (typeof raw !== "object" || raw === null) return undefined;
	const { value, position } = raw as Record<string, unknown>;
	if (typeof position !== "number" || !Number.isInteger(position) || position < 0) return undefined;
	if (typeof value !== "object" || value === null) return undefined;
	return { value, position };
}

/** Writes the change set into the workspace: only the rows of the units it names, one transaction around
 * everything — a failure writes nothing half. Answers the new revision and the ids of the units that
 * collided (written anyway — the last save wins). A change set without a unit writes nothing at all, and
 * says where the revision stands. Null when there is no workspace of that id; refused (thrown) when it
 * couldn't be written honestly — then it changed nothing. Every unit written leaves its entry in the history,
 * under `source`. */
export async function applyChanges(sql: Sql, workspaceId: string, changes: readonly Change[], source: string | null = null): Promise<SavedChanges | null> {
	if (changes.length === 0) {
		// Nothing changed: nothing is written, not even the revision.
		const [row] = await sql`select revision::text as version from workspaces where id = ${workspaceId}`;
		return row ? { version: row.version as string, collided: [] } : null;
	}
	return sql.begin(async (tx) => {
		// One save of a workspace at a time: each compares its units with what the one before it left.
		const [locked] = await tx`select id from workspaces where id = ${workspaceId} for update`;
		if (!locked) return null;

		const stands = unitStandsOf(STORED_KINDS, await readAppData(tx, workspaceId));
		const ordered = inKindOrder(STORED_KINDS, changes);
		const collided: string[] = [];
		for (const unit of ordered) {
			// Whatever the tables hold differs from the unit's `before`: someone else was here first.
			if (!untouched(stands, unit)) collided.push(unit.id);
			await writeUnit(tx, workspaceId, unit);
		}

		const [stored] = await tx`update workspaces set revision = revision + 1, updated_at = now()
			where id = ${workspaceId}
			returning revision::text as version`;
		const version = stored!.version as string;
		const entries = changeEntries(stands, ordered, collided).map((entry) => ({ ...entry, revision: version }));
		await recordHistory(tx, workspaceId, source, entries);
		return { version, collided };
	});
}

/** Writes one unit's rows within the transaction — only that unit's own, in its workspace: its delete is a
 * delete of its one row (the tables' references cascade what hung below it), its write an upsert of it. */
async function writeUnit(tx: Queries, ws: string, unit: Change): Promise<void> {
	const storage = storageOf(unit.kind)!;
	if (unit.after === null) {
		// Gone: its one row goes, and the tables' references take care of what belonged below it — values
		// with their property or entity, cards and drawings with their board.
		await tx`delete from ${tx(storage.table)} where workspace_id = ${ws} and id = ${unit.id}`;
		return;
	}
	await storage.writePostgres(tx, ws, unit.after, unit.boardId);
}
