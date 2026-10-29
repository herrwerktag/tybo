import { jsonEqual, type UnitStand, type AppData } from "../../shared/core/index.js";
import { groupBy, jsonbParameter, json, parsed, plain, type Rows, type UnitStorage } from "../../shared/api/index.js";
import { BOARD_UNIT, CARD_UNIT, type BoardMeta, type CanvasCard } from "./core.js";

/** How a kind of unit of the app's data is kept. */
type AppStorage<T extends { id: string }, R> = UnitStorage<T, R, AppData>;

/** Whether two stands of a board differ in nothing but its viewport — same place, same name, same frame. */
function onlyViewport(before: UnitStand<BoardMeta> | null, after: UnitStand<BoardMeta> | null): boolean {
	if (before === null || after === null || before.position !== after.position) return false;
	const { viewport: _was, ...was } = before.value;
	const { viewport: _now, ...now } = after.value;
	return jsonEqual(was, now);
}

export const BOARD_STORAGE: AppStorage<BoardMeta, Rows> = {
	unit: BOARD_UNIT,
	table: "boards",
	readPostgres: (queries, ws) => queries`select id, name, viewport, view_frame from boards where workspace_id = ${ws} order by position, id`,
	readSqlite: (all) =>
		all("select id, name, viewport, view_frame from boards where workspace_id = ? order by position, id").map((row) => ({
			...row,
			viewport: parsed(row.viewport),
			view_frame: parsed(row.view_frame),
		})),
	// The frame is null on boards saved before frames (JSON keeps a null, unlike a missing value, so a save's
	// `before` still matches): the app makes it of the board's pan/zoom. Cards and drawings are put in by their own kinds.
	assemble: (data, boards) => ({
		...data,
		boards: boards.map(({ id, name, viewport, view_frame }) => ({ id, name, viewport, viewFrame: view_frame ?? null }) as AppData["boards"][number]),
	}),
	async writePostgres(tx, ws, { value: board, position }) {
		await tx`insert into boards (workspace_id, id, position, name, viewport, view_frame, updated_at)
			values (${ws}, ${board.id}, ${position}, ${board.name}, ${jsonbParameter(tx, board.viewport)},
				${jsonbParameter(tx, board.viewFrame ?? null)}, now())
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name, viewport = excluded.viewport, view_frame = excluded.view_frame,
				updated_at = now()`;
	},
	writeSqlite(run, ws, { value: board, position }) {
		run(
			`insert into boards (workspace_id, id, position, name, viewport, view_frame, updated_at)
			values (?, ?, ?, ?, ?, ?, current_timestamp)
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name, viewport = excluded.viewport, view_frame = excluded.view_frame,
				updated_at = current_timestamp`,
			ws, board.id, position, plain(board.name), json(board.viewport), json(board.viewFrame ?? null),
		);
	},
	// Pan and zoom are saved, but they are no part of the undo history either, and would flood this one.
	quiet: onlyViewport,
};

export const CARD_STORAGE: AppStorage<CanvasCard, Rows> = {
	unit: CARD_UNIT,
	table: "cards",
	readPostgres: (queries, ws) =>
		queries`select id, board_id, entity_id, x, y, width, height from cards where workspace_id = ${ws} order by board_id, position, id`,
	readSqlite: (all) => all("select id, board_id, entity_id, x, y, width, height from cards where workspace_id = ? order by board_id, position, id"),
	assemble(data, cards) {
		const cardsOf = groupBy(cards, "board_id", ({ id, entity_id, x, y, width, height }) => ({ id, entityId: entity_id, x, y, width, height }));
		return { ...data, boards: data.boards.map((board) => ({ ...board, cards: cardsOf.get(board.id) ?? [] })) };
	},
	async writePostgres(tx, ws, { value: card, position }, boardId) {
		await tx`insert into cards (workspace_id, id, board_id, entity_id, position, x, y, width, height)
			values (${ws}, ${card.id}, ${boardId!}, ${card.entityId}, ${position}, ${card.x}, ${card.y}, ${card.width}, ${card.height})
			on conflict (workspace_id, id) do update set
				board_id = excluded.board_id, entity_id = excluded.entity_id, position = excluded.position,
				x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height`;
	},
	writeSqlite(run, ws, { value: card, position }, boardId) {
		run(
			`insert into cards (workspace_id, id, board_id, entity_id, position, x, y, width, height)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict (workspace_id, id) do update set
				board_id = excluded.board_id, entity_id = excluded.entity_id, position = excluded.position,
				x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height`,
			ws, card.id, plain(boardId), card.entityId, position, card.x, card.y, card.width, card.height,
		);
	},
};

