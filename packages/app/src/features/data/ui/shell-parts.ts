import type { AppData } from "../../../shared/core/index.js";
import type { DataStore } from "../core.js";
import { el, type NewWorkspaceOption, type SearchSource, type SettingMaker } from "../../../shared/ui/index.js";
import { text } from "../texts.js";
import { setWrapReferences, wrapReferences } from "./wrap-references.js";
import { entityRoute } from "./entities-section.js";

/** In the search: the entities (by type, in its color) and the entity types; a new entity (once there's a type to
 * make one of) and a new type. */
export const DATA_SEARCH: SearchSource<DataStore> = {
	items: (store) => {
		const types = new Map(store.data.types.map((t) => [t.id, t]));
		return [
			...store.data.entities.map((e) => {
				const type = types.get(e.typeId);
				return { label: e.name, href: entityRoute(e.id), ...(type && { detail: type.name, color: type.color }) };
			}),
			...store.data.types.map((t) => ({ label: t.name, detail: text.entityType, color: t.color, href: `#types/${encodeURIComponent(t.id)}` })),
		];
	},
	actions: (store) => [
		...(store.data.types.length > 0 ? [{ label: text.createNewEntity, href: "#entities/new" }] : []),
		{ label: text.createNewType, href: "#types/new" },
	],
};

/** In the form for a new workspace: start with copies of the current one's entity types (no entities or boards). */
export const COPY_TYPES: NewWorkspaceOption<AppData, DataStore> = {
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
export function deleteQuestion(name: string, store: DataStore): string {
	const { types, entities, boards } = store.data;
	return text.confirmDeleteWorkspace(name, types.length, entities.length, boards.length);
}
