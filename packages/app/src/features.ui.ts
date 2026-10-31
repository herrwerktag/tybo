import { APP_FORMAT, createStore, type Store, type Workspaces } from "./features.core.js";
import type { AppData } from "./shared/core/index.js";
import { renderShell, type UnitDescriber } from "./shared/ui/index.js";
import type { CanvasLayer } from "./features/boards/ui.js";
import { COPY_TYPES, ENTITY_HISTORY, TYPE_HISTORY, WRAP_REFERENCES, dataPage, deleteQuestion } from "./features/data/ui.js";
import { ANALYSES_PAGE, ANALYSIS_HISTORY } from "./features/analyses/ui.js";
import { BOARD_HISTORY, CARD_HISTORY, boardsPage } from "./features/boards/ui.js";
import { DRAWING_HISTORY, DRAWING_LAYER } from "./features/drawings/ui.js";
import { TEXT_EXPORT, boardExports, renderStandaloneView } from "./features/exports/ui.js";
import { HISTORY_LINK, historyPage } from "./features/history/ui.js";

export * from "./features/data/ui.js";
export * from "./features/analyses/ui.js";
export * from "./features/boards/ui.js";
export * from "./features/drawings/ui.js";
export * from "./features/exports/ui.js";
export * from "./features/history/ui.js";

/** The features' layers on the boards' canvas (see `CanvasLayer`), the first drawn lowest. */
export const CANVAS_LAYERS: readonly CanvasLayer[] = [DRAWING_LAYER];

/** How the features' units are told of in the history (see `UnitDescriber`). */
export const HISTORY_DESCRIBERS: readonly UnitDescriber<Store>[] = [TYPE_HISTORY, ENTITY_HISTORY, ANALYSIS_HISTORY, BOARD_HISTORY, CARD_HISTORY, DRAWING_HISTORY];

/**
 * The app in the browser, put together of the shell and the features' parts: a feature joins with a line here, and
 * leaves without a trace by its line going. With `viewScript` — the built standalone viewer (see apps/web) — a
 * board can be exported as an HTML file that shows it without the server.
 */
export function render(root: HTMLElement, workspaces: Workspaces, { viewScript }: { viewScript?: string } = {}): Promise<void> {
	return renderShell<AppData, Store>(root, workspaces, {
		format: APP_FORMAT,
		/** The pages, their tabs in this order. */
		pages: [
			dataPage({ entityLinks: [HISTORY_LINK] }),
			boardsPage({ layers: CANVAS_LAYERS, exports: boardExports(viewScript) }),
			ANALYSES_PAGE,
			historyPage({ describers: HISTORY_DESCRIBERS }),
		],
		workspaceActions: [TEXT_EXPORT],
		newWorkspaceOptions: [COPY_TYPES],
		settings: [WRAP_REFERENCES],
		deleteQuestion,
	});
}

/** An exported board's page (see standaloneViewHtml): its board in `root`, read-only, with the features' layers. */
export function renderExportedView(root: HTMLElement): Promise<void> {
	return renderStandaloneView(root, { layers: CANVAS_LAYERS, createStore });
}
