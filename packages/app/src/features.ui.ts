import { APP_FORMAT, type AppData, type Store, type Workspaces } from "./legacy/core/index.js";
import { boardsPage } from "./legacy/ui/boards-page.js";
import { DATA_PAGE } from "./legacy/ui/data-page.js";
import { COPY_TYPES, TEXT_EXPORT, WRAP_REFERENCES, deleteQuestion } from "./legacy/ui/shell-parts.js";
import { renderShell } from "./shared/ui/index.js";
import { ANALYSES_PAGE } from "./features/analyses/ui.js";

export * from "./features/analyses/ui.js";

/**
 * The app in the browser, put together of the shell and the features' parts: a feature joins with a line here, and
 * leaves without a trace by its line going. With `viewScript` — the built standalone viewer (see apps/demo) — a
 * board can be exported as an HTML file that shows it without the server.
 */
export function render(root: HTMLElement, workspaces: Workspaces, { viewScript }: { viewScript?: string } = {}): Promise<void> {
	return renderShell<AppData, Store>(root, workspaces, {
		format: APP_FORMAT,
		/** The pages, their tabs in this order. */
		pages: [DATA_PAGE, boardsPage(viewScript), ANALYSES_PAGE],
		workspaceActions: [TEXT_EXPORT],
		newWorkspaceOptions: [COPY_TYPES],
		settings: [WRAP_REFERENCES],
		deleteQuestion,
	});
}
