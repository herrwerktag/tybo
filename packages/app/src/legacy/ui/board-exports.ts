import type { Store } from "../core/index.js";
import { downloadFile, language, safeFileName, zipFiles } from "../../shared/ui/index.js";
import type { BoardExport } from "../../features/boards/ui/layer.js";
import { boardDrawioFiles } from "./drawio-export.js";
import { text } from "./i18n.js";
import { standaloneViewHtml } from "./standalone.js";

const boardName = (store: Store, boardId: string) => store.data.boards.find((b) => b.id === boardId)?.name ?? "";

/** The board as an HTML file that shows it without the server, with `script`, the built standalone viewer (see
 * apps/demo). */
function viewExport(script: string): BoardExport {
	return {
		label: () => text.exportViewButton,
		title: () => text.exportView,
		run: (store, boardId) =>
			downloadFile(`${safeFileName(boardName(store, boardId))}.html`, standaloneViewHtml(script, store.data, boardId, language), "text/html"),
	};
}

/** One draw.io file, or with groups on the board a ZIP with one more file per group. */
const DRAWIO_EXPORT: BoardExport = {
	label: () => text.exportDrawioButton,
	title: () => text.exportDrawio,
	run(store, boardId) {
		const files = boardDrawioFiles(store.data, boardId);
		if (files.length === 1) downloadFile(files[0]!.name, files[0]!.contents, "application/xml");
		else downloadFile(`${safeFileName(boardName(store, boardId))}.zip`, zipFiles(files), "application/zip");
	},
};

/** The ways to export a board: as an HTML file when there's a `viewScript` (the built standalone viewer), and for draw.io. */
export function boardExports(viewScript?: string): BoardExport[] {
	return [...(viewScript ? [viewExport(viewScript)] : []), DRAWIO_EXPORT];
}
