import type { Store } from "../../../features.core.js";
import type { PageMaker } from "../../../shared/ui/index.js";
import { text } from "../texts.js";
import { canvasView, type CanvasOptions } from "./canvas.js";

/**
 * The Boards tab: a board's canvas, with the features' `layers` and `exports` (see `CanvasOptions`); "#canvas" and
 * "#view" are its former addresses.
 */
export function boardsPage({ layers, exports }: Omit<CanvasOptions, "readOnly">): PageMaker<Store> {
	return () => ({
		routes: ["boards", "canvas", "view", "viewer"],
		label: () => text.tabBoards,
		render: (store) => canvasView(store, { readOnly: false, layers, ...(exports ? { exports } : {}) }),
	});
}
