import type { Store } from "../core/index.js";
import { downloadFile, safeFileName, type WorkspaceAction } from "../../shared/ui/index.js";
import { text } from "./i18n.js";
import { workspaceText } from "./text-export.js";

/** In the workspace menu: the workspace as a text file, its types and entities written out. */
export const TEXT_EXPORT: WorkspaceAction<Store> = {
	label: () => text.exportTextButton,
	title: () => text.exportText,
	run(store, name) {
		const date = new Date().toISOString().slice(0, 10);
		downloadFile(`${safeFileName(name)} ${date}.txt`, workspaceText(name, store.data, date), "text/plain;charset=utf-8");
	},
};
