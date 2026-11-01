import type { BoardStore } from "../core.js";
import type { PageMaker } from "../../../shared/ui/index.js";
import { text } from "../texts.js";
import { canvas, cardOfRoute, openBoard, type CanvasOptions } from "./canvas.js";

/**
 * The Boards tab: a board's canvas, with the features' `layers`, `exports` and `entityLinks` (see `CanvasOptions`);
 * "#canvas" and "#view" are its former addresses. `#boards/<board>/<entity>` opens that board with the entity's card
 * selected and in view — once per address, so drawing the page anew doesn't jump back there.
 */
export function boardsPage(options: Omit<CanvasOptions, "readOnly">): PageMaker<BoardStore> {
	return () => {
		/** The canvas last drawn, to draw anew in place (see `Page.refresh`). */
		let shown: ReturnType<typeof canvas> | null = null;
		/** The card address already followed, and the entity still to bring into view once the canvas is on screen. */
		let followed: string | null = null;
		let follow: string | null = null;
		return {
			routes: ["boards", "canvas", "view", "viewer"],
			label: () => text.tabBoards,
			render: (store) => {
				const target = cardOfRoute(location.hash);
				const key = target && `${target.boardId}/${target.entityId}`;
				if (key !== followed) {
					followed = key;
					if (target && store.data.boards.some((b) => b.id === target.boardId)) {
						openBoard(target.boardId);
						follow = target.entityId;
					}
				}
				shown = canvas(store, { readOnly: false, ...options });
				return shown.view;
			},
			afterRender: () => {
				if (follow !== null) shown?.follow(follow);
				follow = null;
			},
			refresh: () => shown?.refresh() ?? false,
		};
	};
}
