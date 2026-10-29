import type { AppData, Store } from "../../../legacy/core/index.js";
import { el, type NewWorkspaceOption, type SettingMaker } from "../../../shared/ui/index.js";
import { text } from "../texts.js";
import { setWrapReferences, wrapReferences } from "./wrap-references.js";

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
