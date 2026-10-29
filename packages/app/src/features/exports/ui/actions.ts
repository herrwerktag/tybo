import type { Store } from "../../../features.core.js";
import { downloadFile, language, safeFileName, zipFiles, type WorkspaceAction } from "../../../shared/ui/index.js";
import type { BoardExport } from "../../boards/ui.js";
import { boardDrawioFiles } from "./drawio-export.js";
import { text } from "../texts.js";
import { standaloneViewHtml } from "./standalone.js";
import { workspaceText } from "./text-export.js";

const boardName = (store: Store, boardId: string) => store.data.boards.find((b) => b.id === boardId)?.name ?? "";

/** The board as an HTML file that shows it without the server, with `script`, the built standalone viewer (see
 * apps/web). */
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

/** In the workspace menu: the workspace as a text file, its types and entities written out. */
export const TEXT_EXPORT: WorkspaceAction<Store> = {
	label: () => text.exportTextButton,
	title: () => text.exportText,
	run(store, name) {
		const date = new Date().toISOString().slice(0, 10);
		downloadFile(`${safeFileName(name)} ${date}.txt`, workspaceText(name, store.data, date), "text/plain;charset=utf-8");
	},
};
