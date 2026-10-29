import type { UnitKind } from "../../shared/core/index.js";
import type { Rect } from "../../shared/core/index.js";
import type { AppData, Board, CanvasCard, Drawing, Entity, EntityType } from "./model.js";
import type { Viewport } from "./viewport.js";

/** A board itself — `name`, `viewport` and its frame, without its cards and drawings. The
 * two are units of their own, so someone panning a board and someone moving a card never address the same one. */
export interface BoardMeta {
	id: string;
	name: string;
	viewport: Viewport;
	viewFrame: Rect;
}

/** A kind of unit of the app's data. */
type AppUnit<T extends { id: string }> = UnitKind<AppData, T>;

export const TYPE_UNIT: AppUnit<EntityType> = {
	kind: "type",
	lists: (data) => [{ items: data.types }],
	withList: (data, types) => ({ ...data, types }),
};

export const ENTITY_UNIT: AppUnit<Entity> = {
	kind: "entity",
	lists: (data) => [{ items: data.entities }],
	withList: (data, entities) => ({ ...data, entities }),
	// Entities of a type that went go with it.
	settle: (data) => {
		const types = new Set(data.types.map(({ id }) => id));
		return { ...data, entities: data.entities.filter((entity) => types.has(entity.typeId)) };
	},
};

/** Boards as units without their cards and drawings, so someone panning a board and someone moving a card never
 * address the same one. */
export const BOARD_UNIT: AppUnit<BoardMeta> = {
	kind: "board",
	lists: (data) => [{ items: data.boards.map(({ id, name, viewport, viewFrame }): BoardMeta => ({ id, name, viewport, viewFrame })) }],
	withList: (data, metas) => {
		const held = new Map(data.boards.map((board) => [board.id, board]));
		// What else a board holds (its cards, its drawings) stays; a new board gets it from the kinds that own it.
		return { ...data, boards: metas.map((meta) => ({ ...held.get(meta.id), ...meta }) as Board) };
	},
};

/** The state with one board's list replaced by `items`. */
function withBoardList<K extends "cards" | "drawings">(data: AppData, list: K, items: Board[K], boardId: string | undefined): AppData {
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

export const DRAWING_UNIT: AppUnit<Drawing> = {
	kind: "drawing",
	onBoard: true,
	lists: (data) => data.boards.map((board) => ({ items: board.drawings ?? [], boardId: board.id })),
	withList: (data, drawings, boardId) => withBoardList(data, "drawings", drawings, boardId),
	// A new board starts without drawings.
	settle: (data) => ({ ...data, boards: data.boards.map((board) => ({ ...board, drawings: board.drawings ?? [] })) }),
};
