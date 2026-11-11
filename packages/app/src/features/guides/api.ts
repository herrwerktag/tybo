import type { AppData } from "../../shared/core/index.js";
import { plain, type Rows, type UnitStorage } from "../../shared/api/index.js";
import { GUIDE_UNIT, type GuideUnit } from "./core.js";

/** The workspace's guide is kept as one row of its own table; a workspace without a guide has none. */
export const GUIDE_STORAGE: UnitStorage<GuideUnit, Rows, AppData> = {
	unit: GUIDE_UNIT,
	table: "guides",
	readPostgres: (queries, ws) => queries`select text from guides where workspace_id = ${ws} order by id limit 1`,
	readSqlite: (all) => all("select text from guides where workspace_id = ? order by id limit 1"),
	assemble: (data, rows) => ({ ...data, guide: rows[0]?.text ?? "" }),
	async writePostgres(tx, ws, { value: guide }) {
		await tx`insert into guides (workspace_id, id, text, updated_at)
			values (${ws}, ${guide.id}, ${guide.text}, now())
			on conflict (workspace_id, id) do update set text = excluded.text, updated_at = now()`;
	},
	writeSqlite(run, ws, { value: guide }) {
		run(
			`insert into guides (workspace_id, id, text, updated_at)
			values (?, ?, ?, current_timestamp)
			on conflict (workspace_id, id) do update set text = excluded.text, updated_at = current_timestamp`,
			ws, guide.id, plain(guide.text),
		);
	},
};
