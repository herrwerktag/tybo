import type { AppData } from "../../legacy/core/model.js";
import { jsonbParameter, json, parsed, plain, type Rows, type UnitStorage } from "../../shared/api/index.js";
import { ANALYSIS_UNIT, type Analysis } from "./core.js";

/** Analyses are kept one row each, their paths as JSON. */
export const ANALYSIS_STORAGE: UnitStorage<Analysis, Rows, AppData> = {
	unit: ANALYSIS_UNIT,
	table: "analyses",
	readPostgres: (queries, ws) =>
		queries`select id, name, type_id, group_paths, column_paths from analyses where workspace_id = ${ws} order by position, id`,
	readSqlite: (all) =>
		all("select id, name, type_id, group_paths, column_paths from analyses where workspace_id = ? order by position, id").map((row) => ({
			...row,
			group_paths: parsed(row.group_paths),
			column_paths: parsed(row.column_paths),
		})),
	assemble: (data, analyses) => ({
		...data,
		analyses: analyses.map(({ id, name, type_id, group_paths, column_paths }) => ({
			id,
			name,
			typeId: type_id,
			groups: group_paths ?? [],
			columns: column_paths ?? [],
		})),
	}),
	async writePostgres(tx, ws, { value: item, position }) {
		await tx`insert into analyses (workspace_id, id, position, name, type_id, group_paths, column_paths, updated_at)
			values (${ws}, ${item.id}, ${position}, ${item.name}, ${item.typeId}, ${jsonbParameter(tx, item.groups)},
				${jsonbParameter(tx, item.columns)}, now())
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name, type_id = excluded.type_id, group_paths = excluded.group_paths,
				column_paths = excluded.column_paths, updated_at = now()`;
	},
	writeSqlite(run, ws, { value: item, position }) {
		run(
			`insert into analyses (workspace_id, id, position, name, type_id, group_paths, column_paths, updated_at)
			values (?, ?, ?, ?, ?, ?, ?, current_timestamp)
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name, type_id = excluded.type_id, group_paths = excluded.group_paths,
				column_paths = excluded.column_paths, updated_at = current_timestamp`,
			ws, item.id, position, plain(item.name), plain(item.typeId), json(item.groups), json(item.columns),
		);
	},
};
