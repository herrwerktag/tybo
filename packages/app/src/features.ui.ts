import { APP_FORMAT, type Store, type Workspaces } from "./features.core.js";
import type { AppData } from "./shared/core/index.js";
import { renderShell } from "./shared/ui/index.js";
import type { CanvasLayer } from "./features/boards/ui.js";
import { COPY_TYPES, DATA_PAGE, WRAP_REFERENCES, deleteQuestion } from "./features/data/ui.js";
import { ANALYSES_PAGE } from "./features/analyses/ui.js";
import { boardsPage } from "./features/boards/ui.js";
import { DRAWING_LAYER } from "./features/drawings/ui.js";
import { TEXT_EXPORT, boardExports } from "./features/exports/ui.js";

export * from "./features/data/ui.js";
export * from "./features/analyses/ui.js";
export * from "./features/boards/ui.js";
export * from "./features/drawings/ui.js";
export * from "./features/exports/ui.js";

/** The features' layers on the boards' canvas (see `CanvasLayer`), the first drawn lowest. */
export const CANVAS_LAYERS: readonly CanvasLayer[] = [DRAWING_LAYER];

/**
 * The app in the browser, put together of the shell and the features' parts: a feature joins with a line here, and
 * leaves without a trace by its line going. With `viewScript` — the built standalone viewer (see apps/demo) — a
 * board can be exported as an HTML file that shows it without the server.
 */
export function render(root: HTMLElement, workspaces: Workspaces, { viewScript }: { viewScript?: string } = {}): Promise<void> {
	return renderShell<AppData, Store>(root, workspaces, {
		format: APP_FORMAT,
		/** The pages, their tabs in this order. */
		pages: [DATA_PAGE, boardsPage({ layers: CANVAS_LAYERS, exports: boardExports(viewScript) }), ANALYSES_PAGE],
		workspaceActions: [TEXT_EXPORT],
		newWorkspaceOptions: [COPY_TYPES],
		settings: [WRAP_REFERENCES],
		deleteQuestion,
	});
}
