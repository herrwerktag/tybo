import type { Store } from "../../../features.core.js";
import { toSaved, type AppData, type DataPort } from "../../../shared/core/index.js";
import { canvasView, type CanvasLayer } from "../../boards/ui.js";
import { LANGUAGES, setLanguage, type Language } from "../../../shared/ui/index.js";

/** The id of the script element in an exported view that holds its board, language and data. */
const VIEW_DATA_ID = "tybo-view";

/** The workspace id the exported view's store reads its data under. */
const VIEW_WORKSPACE = "view";

/**
 * A page that shows one board like the View tab, on its own: `script` (the viewer, built with its styles; see
 * apps/web) and the data are inside, so it opens from disk, with no server. Only the board `boardId` goes in, with
 * all entity types and entities, so the details of every referenced entity can still be shown.
 */
export function standaloneViewHtml(script: string, data: AppData, boardId: string, language: Language): string {
	const board = data.boards.find((b) => b.id === boardId);
	if (!board) throw new Error(`there is no board "${boardId}"`);
	const view = { language, data: toSaved({ ...data, boards: [board] }) };
	// "<" escaped, so no text in the data can end the script element early.
	const json = JSON.stringify(view).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="${language}">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>${escapeHtml(board.name)}</title>
	</head>
	<body>
		<main id="app" class="standalone"></main>
		<script type="application/json" id="${VIEW_DATA_ID}">${json}</script>
		<script>${script.replace(/<\/script/gi, "<\\/script")}</script>
	</body>
</html>
`;
}

/** Shows the board of an exported view (see standaloneViewHtml) in `root`, read-only and without the top bar, with
 * the features' `layers` (see `CanvasLayer`), in the app's store (`createStore`) over the data inside. */
export async function renderStandaloneView(
	root: HTMLElement,
	{ layers, createStore }: { layers: readonly CanvasLayer[]; createStore: (port: DataPort, workspaceId: string) => Promise<Store> },
): Promise<void> {
	const view = JSON.parse(document.getElementById(VIEW_DATA_ID)?.textContent ?? "{}") as { language?: string; data?: unknown };
	const exported = LANGUAGES.find(({ code }) => code === view.language);
	if (exported) setLanguage(exported.code);
	const store = await createStore(readOnlyPort(view.data), VIEW_WORKSPACE);
	root.replaceChildren(canvasView(store, { readOnly: true, layers }));
}

/** The data port of an exported view: it reads the embedded data; there's nothing to save to. */
function readOnlyPort(data: unknown): DataPort {
	const refuse = async (): Promise<never> => {
		throw new Error("an exported view can't be changed");
	};
	return {
		listWorkspaces: async () => [{ id: VIEW_WORKSPACE, name: "" }],
		createWorkspace: refuse,
		renameWorkspace: refuse,
		moveWorkspace: refuse,
		deleteWorkspace: refuse,
		load: async (id) => (id === VIEW_WORKSPACE ? { data, version: "1" } : null),
		version: async (id) => (id === VIEW_WORKSPACE ? "1" : null),
		saveChanges: refuse,
	};
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
