import { el, resizeHandle } from "../../../shared/ui/index.js";
import type { Store } from "../../../features.core.js";
import type { Entity } from "../core.js";
import { text } from "../texts.js";
import { DETAILS_WIDTH_KEY, entityDetails } from "./entity-card.js";
import { showEntityEditor } from "./entity-form.js";

export interface DetailsPanel {
	/** The panel beside the view, hidden while it shows nothing. */
	element: HTMLElement;
	/** The drag handle for the panel's width, to go just before it (hidden along with it, see CSS). */
	handle: HTMLElement;
	/** Shows the entity's details, keeping its form if it's being edited (e.g. after the view was drawn anew);
	 * none, or one that's gone: hides the panel. Returns whether it shows an entity. */
	show(entityId: string | null): boolean;
	/** Shows the entity's details afresh: an open form is closed, what was typed into it dropped. */
	open(entityId: string | null): boolean;
	/** The entity shown, or null. */
	shown(): string | null;
}

/**
 * The details of one entity beside a view: easy to read, and — with Edit, unless `readOnly` — its form in their
 * place. `actions` adds buttons after Edit. Once the form is done, the details show again; when it saved and
 * there is `onSaved`, that draws the view anew instead (and shows them from there).
 */
export function detailsPanel(
	store: Store,
	options: {
		readOnly?: boolean;
		actions?: (entity: Entity) => HTMLElement[];
		onClose: () => void;
		onSelectEntity: (entityId: string) => void;
		onSaved?: () => void;
	},
): DetailsPanel {
	const { readOnly = false, actions = () => [], onClose, onSelectEntity, onSaved } = options;
	const element = el("aside", { className: "details-panel", ariaLabel: text.details });
	element.hidden = true;
	const handle = resizeHandle(element, { key: DETAILS_WIDTH_KEY, side: "right", min: 16, max: 40 });
	handle.classList.add("details-resize");
	let shownId: string | null = null;
	/** Whether the panel shows the entity's form instead of its details. */
	let editing = false;

	function show(entityId: string | null): boolean {
		const entity = entityId === null ? undefined : store.data.entities.find((e) => e.id === entityId);
		if (entity?.id !== shownId) editing = false;
		shownId = entity?.id ?? null;
		element.hidden = !entity;
		if (!entity) {
			element.replaceChildren();
			return false;
		}
		const type = store.data.types.find((t) => t.id === entity.typeId);
		if (editing && type) {
			// Drawing the view anew keeps the open form and what was typed.
			showEntityEditor(element, store, entity, type, {
				onClose,
				onDone: (saved) => {
					editing = false;
					if (saved && onSaved) onSaved();
					else show(shownId);
				},
			});
			return true;
		}
		const edit = () => {
			editing = true;
			show(shownId);
		};
		const buttons = readOnly ? [] : [el("button", { type: "button", onclick: edit }, text.edit), ...actions(entity)];
		element.replaceChildren(...entityDetails(store, entity, { actions: buttons, onClose, onSelectEntity }));
		return true;
	}

	return {
		element,
		handle,
		show,
		open(entityId) {
			editing = false;
			return show(entityId);
		},
		shown: () => shownId,
	};
}
