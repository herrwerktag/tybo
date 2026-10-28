import { moveItem, type AppData, type Drawing, type WorkspaceInfo } from "@tybo/core";
import { recordHistory } from "./history.js";
import type { Queries, Sql } from "./schema.js";

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
		const [was] = await tx`select name, data_version, revision::text as revision from workspaces where id = ${id} for update`;
		if (!was) return;
		const data = await readAppData(tx, id);
		await tx`delete from workspaces where id = ${id}`;
		await recordHistory(tx, id, source, [
			{
				operation: "delete",
				revision: was.revision as string,
				before: { name: was.name as string, dataVersion: was.data_version as number, revision: was.revision as string, data },
				after: null,
			},
		]);
	});
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
	const [types, properties, entities, values, boards, cards, drawings, analyses] = await Promise.all([
		queries`select id, name, content_template, color from entity_types where workspace_id = ${workspaceId} order by position, id`,
		queries`select id, type_id, name, kind, options, reference, card_display from properties where workspace_id = ${workspaceId} order by type_id, position, id`,
		queries`select id, type_id, name, content, description, tags from entities where workspace_id = ${workspaceId} order by position, id`,
		queries`select entity_id, property_id, value from entity_values where workspace_id = ${workspaceId} order by entity_id, position, property_id`,
		queries`select id, name, viewport, view_frame from boards where workspace_id = ${workspaceId} order by position, id`,
		queries`select id, board_id, entity_id, x, y, width, height from cards where workspace_id = ${workspaceId} order by board_id, position, id`,
		queries`select board_id, body from drawings where workspace_id = ${workspaceId} order by board_id, position, id`,
		queries`select id, name, type_id, group_paths, column_paths from analyses where workspace_id = ${workspaceId} order by position, id`,
	]);
	return assembleAppData({ types, properties, entities, values, boards, cards, drawings, analyses });
}

/** A workspace's rows, table by table, in the order `readAppData` reads them — the JSON columns already
 * parsed, whichever database answered them. */
export interface WorkspaceRows {
	types: readonly Record<string, any>[];
	properties: readonly Record<string, any>[];
	entities: readonly Record<string, any>[];
	values: readonly Record<string, any>[];
	boards: readonly Record<string, any>[];
	cards: readonly Record<string, any>[];
	drawings: readonly Record<string, any>[];
	analyses: readonly Record<string, any>[];
}

/** Puts a workspace's rows together into the app's data. */
export function assembleAppData({ types, properties, entities, values, boards, cards, drawings, analyses }: WorkspaceRows): AppData {
	const propertiesOf = groupBy(properties, "type_id", (property) => ({
		id: property.id,
		name: property.name,
		kind: property.kind,
		options: property.options ?? [],
		reference: property.reference ?? null,
		cardDisplay: property.card_display,
	}));
	const valuesOf = new Map<string, Record<string, unknown>>();
	for (const { entity_id, property_id, value } of values) {
		const record = valuesOf.get(entity_id) ?? {};
		record[property_id] = value;
		valuesOf.set(entity_id, record);
	}
	const cardsOf = groupBy(cards, "board_id", ({ id, entity_id, x, y, width, height }) => ({ id, entityId: entity_id, x, y, width, height }));
	const drawingsOf = groupBy(drawings, "board_id", ({ body }) => body as Drawing);

	return {
		types: types.map(({ id, name, content_template, color }) => ({
			id,
			name,
			properties: propertiesOf.get(id) ?? [],
			contentTemplate: content_template,
			color,
		})),
		entities: entities.map(({ id, type_id, name, content, description, tags }) => ({
			id,
			typeId: type_id,
			name,
			content,
			description,
			tags: tags ?? [],
			values: valuesOf.get(id) ?? {},
		})),
		// The frame is null on boards saved before frames (JSON keeps a null, unlike a missing value, so a save's
		// `before` still matches): the app makes it of the board's pan/zoom.
		boards: boards.map(({ id, name, viewport, view_frame }) => ({
			id,
			name,
			cards: cardsOf.get(id) ?? [],
			viewport,
			viewFrame: view_frame ?? null,
			drawings: drawingsOf.get(id) ?? [],
		})),
		analyses: analyses.map(({ id, name, type_id, group_paths, column_paths }) => ({
			id,
			name,
			typeId: type_id,
			groups: group_paths ?? [],
			columns: column_paths ?? [],
		})),
	} as AppData;
}

/** The rows by the parent their `column` names, each turned into what the app holds, in the rows' order. */
function groupBy<R extends Record<string, unknown>, T>(rows: readonly R[], column: keyof R, make: (row: R) => T): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const parent = row[column] as string;
		const list = groups.get(parent) ?? [];
		list.push(make(row));
		groups.set(parent, list);
	}
	return groups;
}
