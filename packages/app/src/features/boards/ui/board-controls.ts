import { freeName, type Rect } from "../../../shared/core/index.js";
import { el, readPreference, writePreference } from "../../../shared/ui/index.js";
import type { Board, BoardStore } from "../core.js";
import { text } from "../texts.js";
import type { BoardExport } from "./layer.js";
import { pickerDropdown, pickerLabel, renderPicker } from "./pickers.js";

/** Whether the editor is editing the frames: only then are they shown, with their controls. */
const EDIT_FRAMES_KEY = "canvas-edit-frames";

/**
 * The canvas's controls for its boards: the board picker to switch to another (and in the editor, create, rename,
 * move or delete one), and in the editor also editing the frames, a new entity and the board's exports. The viewer
 * only switches boards.
 */
export function boardControls(
	store: BoardStore,
	{
		readOnly,
		exports,
		board,
		switchBoard,
		beforeDelete,
		onNoBoards,
		newEntity,
		seenFrame,
		frame,
	}: {
		readOnly: boolean;
		/** The ways to export a board (see `BoardExport`). */
		exports: readonly BoardExport[];
		/** The board shown. */
		board: () => Board;
		switchBoard: (id: string) => void;
		/** Before a board is deleted, e.g. to save the pan/zoom of the one shown. */
		beforeDelete: () => void;
		/** After the last board was deleted: the canvas makes way for the button creating the first. */
		onNoBoards: () => void;
		/** Opens the dialog for a new entity. */
		newEntity: () => void;
		/** The frame of what is seen now. */
		seenFrame: () => Rect;
		/** The board's frame on the canvas (see `frameEditor`). */
		frame: { save(frame: Rect): void; render(editing: boolean): void };
	},
): { element: HTMLElement; boardDialog: HTMLDialogElement; exportDialog: HTMLDialogElement; render(): void; editingFrames(): boolean } {
	const element = el("div", { className: "board-controls" });

	/** The boards: switch to another (and in the editor, create, rename or delete). */
	const { dialog: boardDialog, button: boardButton } = pickerDropdown("board-dialog", text.tabBoards, "board-switch", text.changeBoard, () =>
		renderBoardDialog(),
	);

	function renderBoardDialog(renamingId: string | null = null): void {
		const boards = store.data.boards;
		renderPicker({
			dialog: boardDialog,
			title: text.tabBoards,
			items: boards,
			currentId: board().id,
			renamingId,
			pick: switchBoard,
			rerender: renderBoardDialog,
			...(!readOnly && {
				editing: {
					renameTitle: text.renameBoard,
					deleteTitle: text.deleteBoard,
					rename: (id, name) => {
						store.renameBoard(id, name);
						render();
					},
					remove: deleteBoard,
					newTitle: text.newBoard,
					newName: freeName(boards, text.defaultBoardName),
					nameTaken: text.boardNameTaken,
					add: (name) => switchBoard(store.addBoard(name).id),
					move: (id, to) => store.moveBoard(id, to),
					moveTitle: text.moveBoard,
				},
			}),
		});
	}

	/** Editor: sets the board's frame to what is seen now. */
	const frameFromViewButton = el(
		"button",
		{ type: "button", className: "frame-from-view", title: text.frameFromViewHint, onclick: () => frame.save(seenFrame()) },
		text.frameFromView,
	);

	/** Editor: the frame is only shown and changed while editing it, so it doesn't clutter the board. */
	let editingFrames = readPreference(EDIT_FRAMES_KEY) === "true";
	const editFramesButton = el("button", {
		type: "button",
		className: "frames-toggle",
		title: text.editFramesHint,
		onclick: () => {
			editingFrames = !editingFrames;
			writePreference(EDIT_FRAMES_KEY, String(editingFrames));
			render();
			frame.render(editingFrames);
		},
	});

	/** Editor: the current board's exports (see `BoardExport`), in a dropdown like the boards'. */
	const { dialog: exportDialog, button: exportButton } = pickerDropdown("export-dialog", text.exportButton, "export-switch", text.exportBoard, () => {
		const option = (label: string, title: string, run: (id: string) => void) =>
			el(
				"li",
				{},
				el("button", { type: "button", className: "picker-option", title, onclick: () => (exportDialog.close(), run(board().id)) }, label),
			);
		exportDialog.replaceChildren(
			el("h2", {}, text.exportButton),
			el("ul", { className: "picker-list" }, ...exports.map((way) => option(way.label(), way.title(), (id) => way.run(store, id)))),
		);
	});
	exportButton.replaceChildren(text.exportButton, el("span", { ariaHidden: "true" }, "▾"));

	function render(): void {
		boardButton.replaceChildren(...pickerLabel(board().name));
		// The viewer only switches boards.
		if (readOnly) return element.replaceChildren(boardButton);
		editFramesButton.ariaPressed = String(editingFrames);
		editFramesButton.replaceChildren(el("span", { ariaHidden: "true" }, "▭"), editingFrames ? text.doneEditingFrames : text.editFrames);
		element.replaceChildren(
			boardButton,
			editFramesButton,
			...(editingFrames ? [frameFromViewButton] : []),
			el("button", { type: "button", title: text.newEntityHint, onclick: newEntity }, text.newEntityButton),
			...(exports.length > 0 ? [exportButton] : []),
		);
	}

	/** Deletes a board (after asking); without any left, the canvas makes way for the button creating the first. */
	function deleteBoard(id: string): void {
		const deleted = store.data.boards.find((b) => b.id === id);
		if (!deleted || !confirm(text.confirmDeleteBoard(deleted.name, deleted.cards.length))) return;
		beforeDelete();
		const shown = board().id;
		store.deleteBoard(id);
		if (store.data.boards.length === 0) {
			boardDialog.close();
			onNoBoards();
			return;
		}
		if (id === shown) switchBoard(store.data.boards[0]!.id);
		renderBoardDialog();
	}

	return { element, boardDialog, exportDialog, render, editingFrames: () => editingFrames };
}
