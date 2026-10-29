import type { Store } from "../core/index.js";
import { downloadFile, language, safeFileName, zipFiles, type PageMaker } from "../../shared/ui/index.js";
import { canvasView } from "./canvas.js";
import { boardDrawioFiles } from "./drawio-export.js";
import { text } from "./i18n.js";
import { standaloneViewHtml } from "./standalone.js";

/**
 * The Boards tab: a board's canvas. With `viewScript` — the built standalone viewer (see apps/demo) — a board can be
 * exported as an HTML file that shows it without the server; "#canvas" and "#view" are its former addresses.
 */
export function boardsPage(viewScript?: string): PageMaker<Store> {
	return () => {
		function exportView(store: Store, script: string, boardId: string): void {
			const name = store.data.boards.find((b) => b.id === boardId)?.name ?? "";
			downloadFile(`${safeFileName(name)}.html`, standaloneViewHtml(script, store.data, boardId, language), "text/html");
		}

		/** One draw.io file, or with groups on the board a ZIP with one more file per group. */
		function exportDrawio(store: Store, boardId: string): void {
			const name = store.data.boards.find((b) => b.id === boardId)?.name ?? "";
			const files = boardDrawioFiles(store.data, boardId);
			if (files.length === 1) downloadFile(files[0]!.name, files[0]!.contents, "application/xml");
			else downloadFile(`${safeFileName(name)}.zip`, zipFiles(files), "application/zip");
		}

		return {
			routes: ["boards", "canvas", "view", "viewer"],
			label: () => text.tabBoards,
			render: (store) =>
				canvasView(store, {
					readOnly: false,
					...(viewScript ? { onExportView: (boardId: string) => exportView(store, viewScript, boardId) } : {}),
					onExportDrawio: (boardId) => exportDrawio(store, boardId),
				}),
		};
	};
}
