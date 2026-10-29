import { ulid, type StoreCore } from "../../../shared/core/index.js";
import type { AppData } from "../../../legacy/core/model.js";
import type { Board } from "../../boards/core.js";
import type { Drawing, NewDrawing } from "./model.js";

/** Applies `fn` to the board holding the drawing, as one change. */
function updateDrawingBoard(store: StoreCore<AppData>, drawingId: string, fn: (board: Board) => Board): void {
	const { data } = store;
	const board = data.boards.find((b) => b.drawings.some((d) => d.id === drawingId));
	if (board) store.change({ ...data, boards: data.boards.map((b) => (b.id === board.id ? fn(b) : b)) });
}

/** Adds a drawing on top of the board's others. */
export function addDrawing(store: StoreCore<AppData>, boardId: string, drawing: NewDrawing): Drawing {
	const { data } = store;
	const added = { ...drawing, id: ulid() } as Drawing;
	store.change({ ...data, boards: data.boards.map((b) => (b.id === boardId ? { ...b, drawings: [...b.drawings, added] } : b)) });
	return added;
}

/** Replaces the drawing with the same id (on whichever board it is). */
export function replaceDrawing(store: StoreCore<AppData>, drawing: Drawing): void {
	updateDrawingBoard(store, drawing.id, (b) => ({ ...b, drawings: b.drawings.map((d) => (d.id === drawing.id ? drawing : d)) }));
}

export function removeDrawing(store: StoreCore<AppData>, drawingId: string): void {
	updateDrawingBoard(store, drawingId, (b) => ({ ...b, drawings: b.drawings.filter((d) => d.id !== drawingId) }));
}
