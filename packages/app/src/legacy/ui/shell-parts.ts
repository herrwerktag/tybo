import type { AppData, Store } from "../core/index.js";
import { downloadFile, el, safeFileName, type NewWorkspaceOption, type SettingMaker, type WorkspaceAction } from "../../shared/ui/index.js";
import { text } from "./i18n.js";
import { workspaceText } from "./text-export.js";
import { setWrapReferences, wrapReferences } from "./wrap-references.js";

/** In the workspace menu: the workspace as a text file, its types and entities written out. */
export const TEXT_EXPORT: WorkspaceAction<Store> = {
	label: () => text.exportTextButton,
	title: () => text.exportText,
	run(store, name) {
		const date = new Date().toISOString().slice(0, 10);
		downloadFile(`${safeFileName(name)} ${date}.txt`, workspaceText(name, store.data, date), "text/plain;charset=utf-8");
	},
};

/** In the form for a new workspace: start with copies of the current one's entity types (no entities or boards). */
export const COPY_TYPES: NewWorkspaceOption<AppData, Store> = {
	label: (currentName) => text.copyTypesFrom(currentName),
	available: (store) => store.data.types.length > 0,
	start: (store) => (nothing) => ({ ...nothing, types: [...store.data.types] }),
};

/** In the settings: whether references on cards wrap into more lines. */
export const WRAP_REFERENCES: SettingMaker = (shell) => {
	const checkbox = el("input", {
		type: "checkbox",
		checked: wrapReferences,
		onchange: () => {
			setWrapReferences(checkbox.checked);
			shell.rerender(); // the cards are measured anew; the menu stays open
			document.querySelector<HTMLElement>("#settings-menu input[type=checkbox]")?.focus();
		},
	});
	return el("label", { className: "checkbox-setting" }, checkbox, ` ${text.wrapReferences}`);
};

/** The question before deleting a workspace, saying how much it holds. */
export function deleteQuestion(name: string, store: Store): string {
	const { types, entities, boards } = store.data;
	return text.confirmDeleteWorkspace(name, types.length, entities.length, boards.length);
}
