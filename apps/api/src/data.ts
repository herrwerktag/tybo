import { moveItem, type AppData, type WorkspaceInfo } from "@tybo/app/core";
import { recordHistory } from "./history.js";
import type { Queries, Sql } from "./schema.js";
import { UNIT_STORAGES, assembleAppData } from "./units.js";

/** A workspace's data as a read answers it: its rows put together the way the app holds them, marked with
 * the format they are in (`version`, as an exported file is), and the revision the workspace is at. */
export interface StoredWorkspace {
	data: AppData & { version: number };
	revision: string;
}

/** The workspaces, in the order they were made. */
export async function listWorkspaces(sql: Queries): Promise<WorkspaceInfo[]> {
	const rows = await sql`select id, name from workspaces order by position, created_at, id`;
	return rows.map(({ id, name }) => ({ id: id as string, name: name as string }));
}

/** Makes an empty workspace at the end of the list. False when a workspace of that id is there already —
 * then nothing was written. Its making goes into the history, under `source`. */
export async function createWorkspace(sql: Sql, info: WorkspaceInfo, dataVersion: number, source: string | null = null): Promise<boolean> {
	return sql.begin(async (tx) => {
		const [inserted] = await tx`insert into workspaces (id, position, name, data_version)
			values (${info.id}, (select coalesce(max(position) + 1, 0) from workspaces), ${info.name}, ${dataVersion})
			on conflict (id) do nothing
			returning position`;
		if (!inserted) return false;
		await recordHistory(tx, info.id, source, [
			{ operation: "create", revision: "0", before: null, after: { name: info.name, position: inserted.position as number, dataVersion } },
		]);
		return true;
	});
}

/** Renames the workspace; false when there is none of that id. The renaming goes into the history. */
export async function renameWorkspace(sql: Sql, id: string, name: string, source: string | null = null): Promise<boolean> {
	return sql.begin(async (tx) => {
		const [was] = await tx`select name, revision::text as revision from workspaces where id = ${id} for update`;
		if (!was) return false;
		await tx`update workspaces set name = ${name}, updated_at = now() where id = ${id}`;
		await recordHistory(tx, id, source, [
			{ operation: "rename", revision: was.revision as string, before: { name: was.name as string }, after: { name } },
		]);
		return true;
	});
}

/** Moves the workspace to index `to` in the list, renumbering the positions of all; false when there is none of
 * that id. The move — of this one workspace, from its index to its new one — goes into the history. */
export async function moveWorkspace(sql: Sql, id: string, to: number, source: string | null = null): Promise<boolean> {
	return sql.begin(async (tx) => {
		const rows = await tx`select id, revision::text as revision from workspaces order by position, created_at, id for update`;
		const ids = rows.map((row) => row.id as string);
		const from = ids.indexOf(id);
		if (from < 0) return false;
		const moved = moveItem(ids, from, to);
		for (const [position, each] of moved.entries()) {
			await tx`update workspaces set position = ${position} where id = ${each}`;
		}
		await recordHistory(tx, id, source, [
			{ operation: "move", revision: rows[from]!.revision as string, before: { position: from }, after: { position: moved.indexOf(id) } },
		]);
		return true;
	});
}

/** Deletes the workspace, and with it every row of its data (the tables' references cascade). Its history
 * stays, and gains the deletion with everything the workspace held — so what went can still be found. */
export async function deleteWorkspace(sql: Sql, id: string, source: string | null = null): Promise<void> {
	await sql.begin(async (tx) => {
		const was = await snapshot(tx, id);
		if (!was) return;
		await tx`delete from workspaces where id = ${id}`;
		await recordHistory(tx, id, source, [{ operation: "delete", revision: was.revision, before: was, after: null }]);
	});
}

/** Gives every workspace whose history has no start yet — one made before there was a history — its baseline:
 * everything it holds now. Each in a transaction of its own, the workspace locked against saves meanwhile;
 * entries of saves already there stay before it. Answers how many it recorded — none once each has its start. */
export async function recordBaselines(sql: Sql): Promise<number> {
	const rows = await sql`select id from workspaces
		where not exists (select 1 from history where workspace_id = workspaces.id and operation in ('create', 'baseline'))
		order by position, created_at, id`;
	let recorded = 0;
	for (const { id } of rows) {
		const done = await sql.begin(async (tx) => {
			const now = await snapshot(tx, id as string);
			// Gone, or given its start meanwhile (another server starting at once).
			if (!now) return false;
			const [started] = await tx`select 1 from history where workspace_id = ${id} and operation in ('create', 'baseline') limit 1`;
			if (started) return false;
			await recordHistory(tx, id as string, null, [{ operation: "baseline", revision: now.revision, before: null, after: now }]);
			return true;
		});
		if (done) recorded++;
	}
	return recorded;
}

/** Everything the workspace holds — its name, revision and data — read with the workspace locked for the rest of
 * the transaction; null when there is none of that id. The data's format is the entry's own (`data_version`): the
 * workspace's column keeps the one it was made with, which the app has migrated past since. */
async function snapshot(tx: Queries, id: string): Promise<{ name: string; revision: string; data: AppData } | null> {
	const [row] = await tx`select name, revision::text as revision from workspaces where id = ${id} for update`;
	if (!row) return null;
	return { name: row.name as string, revision: row.revision as string, data: await readAppData(tx, id) };
}

/** The revision the workspace is at, or null when there is none of that id. */
export async function workspaceRevision(sql: Queries, id: string): Promise<string | null> {
	const [row] = await sql`select revision::text as revision from workspaces where id = ${id}`;
	return (row?.revision as string | undefined) ?? null;
}

/** Reads the workspace's data and its revision in one snapshot of the database, so a save landing alongside
 * can't tear the picture in half — or null when there is no workspace of that id. */
export async function readWorkspace(sql: Sql, id: string): Promise<StoredWorkspace | null> {
	return sql.begin("isolation level repeatable read", async (tx) => {
		const [workspace] = await tx`select data_version, revision::text as revision from workspaces where id = ${id}`;
		if (!workspace) return null;
		const data = await readAppData(tx, id);
		return { data: { version: workspace.data_version as number, ...data }, revision: workspace.revision as string };
	});
}

/**
 * Puts the workspace's rows together into the app's data, with the queries given — a snapshot of its own,
 * or the transaction of a save that reads within it, so it sees its own writes. The `position` columns hold
 * every list's order; floats come back bit for bit, the way Postgres stores and answers them.
 */
export async function readAppData(queries: Queries, workspaceId: string): Promise<AppData> {
	return assembleAppData(await Promise.all(UNIT_STORAGES.map((storage) => storage.readPostgres(queries, workspaceId))));
}
