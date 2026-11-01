import type { AppData } from "../../shared/core/index.js";
import { jsonbParameter, json, parsed, plain, type Rows, type UnitStorage } from "../../shared/api/index.js";
import { TRAIT_UNIT, type Trait } from "./core.js";

/** Traits are kept one row each, their roles and bindings as JSON — naming types and properties by id, which they may
 * outlive. */
export const TRAIT_STORAGE: UnitStorage<Trait, Rows, AppData> = {
	unit: TRAIT_UNIT,
	table: "traits",
	readPostgres: (queries, ws) => queries`select id, name, roles, bindings from traits where workspace_id = ${ws} order by position, id`,
	readSqlite: (all) =>
		all("select id, name, roles, bindings from traits where workspace_id = ? order by position, id").map((row) => ({
			...row,
			roles: parsed(row.roles),
			bindings: parsed(row.bindings),
		})),
	assemble: (data, traits) => ({
		...data,
		traits: traits.map(({ id, name, roles, bindings }) => ({ id, name, roles: roles ?? [], bindings: bindings ?? {} })),
	}),
	async writePostgres(tx, ws, { value: item, position }) {
		await tx`insert into traits (workspace_id, id, position, name, roles, bindings, updated_at)
			values (${ws}, ${item.id}, ${position}, ${item.name}, ${jsonbParameter(tx, item.roles)}, ${jsonbParameter(tx, item.bindings)}, now())
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name, roles = excluded.roles, bindings = excluded.bindings, updated_at = now()`;
	},
	writeSqlite(run, ws, { value: item, position }) {
		run(
			`insert into traits (workspace_id, id, position, name, roles, bindings, updated_at)
			values (?, ?, ?, ?, ?, ?, current_timestamp)
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name, roles = excluded.roles, bindings = excluded.bindings,
				updated_at = current_timestamp`,
			ws, item.id, position, plain(item.name), json(item.roles), json(item.bindings),
		);
	},
};
