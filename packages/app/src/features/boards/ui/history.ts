import type { Store } from "../../../features.core.js";
import { isRecord, type UnitDescriber } from "../../../shared/ui/index.js";
import { text } from "../texts.js";

/** A place on a board as the history shows it: whole points. */
const point = (x: unknown, y: unknown) => `${Math.round(Number(x))}, ${Math.round(Number(y))}`;
const size = (width: unknown, height: unknown) => `${Math.round(Number(width))} × ${Math.round(Number(height))}`;

/** The board of `boardId` as the history names it, if it's still there. */
export function boardContext(store: Store, boardId: string | null): string | undefined {
	const board = store.data.boards.find((b) => b.id === boardId);
	return board ? text.historyOnBoard(board.name) : undefined;
}

/** How the history tells of a board: by its name (its pan and zoom aren't kept, its cards are units of their own). */
export const BOARD_HISTORY: UnitDescriber<Store> = {
	kind: "board",
	area: "view",
	noun: text.historyBoards,
	read: (value) => (isRecord(value) && typeof value.name === "string" ? { name: value.name, fields: [] } : null),
};

/** How the history tells of a card: by the entity it shows (in its type's color), on its board, with its place and
 * size — a change of which is only layout, shown faint. */
export const CARD_HISTORY: UnitDescriber<Store> = {
	kind: "card",
	area: "view",
	noun: text.historyCards,
	read(value, store, boardId) {
		if (!isRecord(value) || typeof value.entityId !== "string") return null;
		const context = boardContext(store, boardId);
		const entity = store.data.entities.find((e) => e.id === value.entityId);
		const type = store.data.types.find((t) => t.id === entity?.typeId);
		return {
			name: entity?.name ?? "?",
			...(context ? { context } : {}),
			...(type ? { color: type.color, type: { id: type.id, name: type.name } } : {}),
			fields: [
				{ label: text.historyPosition, text: point(value.x, value.y) },
				{ label: text.historySize, text: size(value.width, value.height) },
			],
		};
	},
	changeVerb: (before, after) =>
		isRecord(before) && isRecord(after) && (before.x !== after.x || before.y !== after.y) ? text.historyMoved : text.historyResized,
	minor: () => true,
};
