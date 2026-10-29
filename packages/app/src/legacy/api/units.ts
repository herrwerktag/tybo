import { DRAWING_UNIT, type AppData, type Drawing } from "../core/index.js";
import { groupBy, jsonbParameter, parsed, plain, type Rows, type UnitStorage } from "../../shared/api/index.js";

export const DRAWING_STORAGE: UnitStorage<Drawing, Rows, AppData> = {
	unit: DRAWING_UNIT,
	table: "drawings",
	readPostgres: (queries, ws) => queries`select board_id, body from drawings where workspace_id = ${ws} order by board_id, position, id`,
	readSqlite: (all) =>
		all("select board_id, body from drawings where workspace_id = ? order by board_id, position, id").map((row) => ({ ...row, body: parsed(row.body) })),
	assemble(data, drawings) {
		const drawingsOf = groupBy(drawings, "board_id", ({ body }) => body as Drawing);
		return { ...data, boards: data.boards.map((board) => ({ ...board, drawings: drawingsOf.get(board.id) ?? [] })) };
	},
	async writePostgres(tx, ws, { value: drawing, position }, boardId) {
		await tx`insert into drawings (workspace_id, id, board_id, position, kind, body)
			values (${ws}, ${drawing.id}, ${boardId!}, ${position}, ${drawing.kind}, ${jsonbParameter(tx, drawing)})
			on conflict (workspace_id, id) do update set
				board_id = excluded.board_id, position = excluded.position, kind = excluded.kind, body = excluded.body`;
	},
	writeSqlite(run, ws, { value: drawing, position }, boardId) {
		run(
			`insert into drawings (workspace_id, id, board_id, position, kind, body)
			values (?, ?, ?, ?, ?, ?)
			on conflict (workspace_id, id) do update set
				board_id = excluded.board_id, position = excluded.position, kind = excluded.kind, body = excluded.body`,
			ws, drawing.id, plain(boardId), position, drawing.kind, JSON.stringify(drawing),
		);
	},
};
