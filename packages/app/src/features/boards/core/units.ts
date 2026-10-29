import type { Rect, UnitKind, AppData } from "../../../shared/core/index.js";
import type { Board, CanvasCard } from "./model.js";
import type { Viewport } from "./viewport.js";

/** A board itself — `name`, `viewport` and its frame, without its cards and the features' lists. Those are units
 * of their own, so someone panning a board and someone moving a card never address the same one. */
export interface BoardMeta {
	id: string;
	name: string;
	viewport: Viewport;
	viewFrame: Rect;
}

/** A kind of unit of the app's data. */
type AppUnit<T extends { id: string }> = UnitKind<AppData, T>;

/** Boards as units without their cards and lists, so someone panning a board and someone moving a card never
 * address the same one. */
export const BOARD_UNIT: AppUnit<BoardMeta> = {
	kind: "board",
	lists: (data) => [{ items: data.boards.map(({ id, name, viewport, viewFrame }): BoardMeta => ({ id, name, viewport, viewFrame })) }],
	withList: (data, metas) => {
		const held = new Map(data.boards.map((board) => [board.id, board]));
		// What else a board holds (its cards, its lists) stays; a new board gets it from the kinds that own it.
		return { ...data, boards: metas.map((meta) => ({ ...held.get(meta.id), ...meta }) as Board) };
	},
};

/** The state with the list `list` of one board (its cards, or a feature's list) replaced by `items`. */
export function withBoardList(data: AppData, list: string, items: readonly unknown[], boardId: string | undefined): AppData {
	return { ...data, boards: data.boards.map((board) => (board.id === boardId ? { ...board, [list]: items } : board)) };
}

export const CARD_UNIT: AppUnit<CanvasCard> = {
	kind: "card",
	onBoard: true,
	lists: (data) => data.boards.map((board) => ({ items: board.cards ?? [], boardId: board.id })),
	withList: (data, cards, boardId) => withBoardList(data, "cards", cards, boardId),
	// Cards of an entity that went go with it; a new board starts without cards.
	settle: (data) => {
		const entities = new Set(data.entities.map(({ id }) => id));
		return { ...data, boards: data.boards.map((board) => ({ ...board, cards: (board.cards ?? []).filter((card) => entities.has(card.entityId)) })) };
	},
};
