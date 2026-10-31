import type { BoardStore } from "../core.js";
import type { PageMaker } from "../../../shared/ui/index.js";
import { text } from "../texts.js";
import { canvas, type CanvasOptions } from "./canvas.js";

/**
 * The Boards tab: a board's canvas, with the features' `layers` and `exports` (see `CanvasOptions`); "#canvas" and
 * "#view" are its former addresses.
 */
export function boardsPage({ layers, exports }: Omit<CanvasOptions, "readOnly">): PageMaker<BoardStore> {
	return () => {
		/** The canvas last drawn, to draw anew in place (see `Page.refresh`). */
		let shown: ReturnType<typeof canvas> | null = null;
		return {
			routes: ["boards", "canvas", "view", "viewer"],
			label: () => text.tabBoards,
			render: (store) => {
				shown = canvas(store, { readOnly: false, layers, ...(exports ? { exports } : {}) });
				return shown.view;
			},
			refresh: () => shown?.refresh() ?? false,
		};
	};
}
