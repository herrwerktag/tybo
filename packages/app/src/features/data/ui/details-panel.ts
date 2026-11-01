import { el, resizeHandle, type EntityLink } from "../../../shared/ui/index.js";
import type { Entity, DataStore } from "../core.js";
import { text } from "../texts.js";
import { DETAILS_WIDTH_KEY, entityDetails, type EntityPlaces } from "./entity-card.js";
import { fieldEditing } from "./fields.js";

export interface DetailsPanel {
	/** The panel beside the view, hidden while it shows nothing. */
	element: HTMLElement;
	/** The drag handle for the panel's width, to go just before it (hidden along with it, see CSS). */
	handle: HTMLElement;
	/** Shows the entity's details, keeping a field open that is being edited (e.g. after the view was drawn anew);
	 * none, or one that's gone: hides the panel. Returns whether it shows an entity. */
	show(entityId: string | null): boolean;
	/** The same as `show` (a field of another entity is never open). */
	open(entityId: string | null): boolean;
	/** The entity shown, or null. */
	shown(): string | null;
}

/**
 * The details of one entity beside a view, easy to read; unless `readOnly`, each of its fields is changed where it
 * is shown (see `fieldEditing`) — after a save, `onSaved` draws the view anew (or, without it, the panel). `actions`
 * adds buttons below its name; the features' `places` and `links` lead from the entity to their pages.
 */
export function detailsPanel(
	store: DataStore,
	options: {
		readOnly?: boolean;
		actions?: (entity: Entity) => HTMLElement[];
		onClose: () => void;
		onSelectEntity: (entityId: string) => void;
		onSaved?: () => void;
		places?: readonly EntityPlaces[];
		links?: readonly EntityLink[];
	},
): DetailsPanel {
	const { readOnly = false, actions = () => [], onClose, onSelectEntity, onSaved, places = [], links = [] } = options;
	const element = el("aside", { className: "details-panel", ariaLabel: text.details });
	element.hidden = true;
	const handle = resizeHandle(element, { key: DETAILS_WIDTH_KEY, side: "right", min: 16, max: 40 });
	handle.classList.add("details-resize");
	let shownId: string | null = null;
	const editing = readOnly ? undefined : fieldEditing(store, () => show(shownId), () => (onSaved ? onSaved() : show(shownId)));

	function show(entityId: string | null): boolean {
		const entity = entityId === null ? undefined : store.data.entities.find((e) => e.id === entityId);
		shownId = entity?.id ?? null;
		element.hidden = !entity;
		if (!entity) {
			element.replaceChildren();
			return false;
		}
		element.replaceChildren(...entityDetails(store, entity, { actions: readOnly ? [] : actions(entity), onClose, onSelectEntity, places, links, ...(editing && { editing }) }));
		return true;
	}

	return {
		element,
		handle,
		show,
		open: show,
		shown: () => shownId,
	};
}
