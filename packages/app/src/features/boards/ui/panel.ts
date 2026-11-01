import { el, emptyState, icon, sharedText, tagFilter, typeDot } from "../../../shared/ui/index.js";
import { entityTags, filterEntities } from "../../data/core.js";
import { text as dataText } from "../../data/texts.js";
import type { CardPreview } from "../../data/ui.js";
import type { Board, BoardStore } from "../core.js";
import { text } from "../texts.js";

/** What an entity dragged from the side panel carries: its id. */
export const ENTITY_MIME = "application/x-entity-id";

/** The tag the side panel's entities are filtered by, if any. */
const PANEL_TAG_KEY = "canvas-panel-tag";

/**
 * The editor's side panel: the entities, by type, to drag onto the board (`board`), found by name, type and tag, or
 * only those still missing there. What has no card on the board is marked, and each type says how many of its
 * entities are missing; what is there already is quieter. Hovering or focusing one shows its card beside it
 * (`preview`). Its fold button calls `onHide`. Empty, it says why and offers the next step: a new entity
 * (`onNewEntity`) or first a type, or resetting the filters that left nothing.
 */
export function entityPanel(
	store: BoardStore,
	{
		board,
		readOnly,
		preview,
		onHide,
		onNewEntity,
	}: { board: () => Board; readOnly: boolean; preview: CardPreview; onHide: () => void; onNewEntity: () => void },
) {
	const element = el("aside", { className: "canvas-panel" });
	// Scrolling the list would leave the preview beside an entity no longer there (scrolling to a focused one doesn't).
	element.addEventListener("wheel", preview.hide, { passive: true });

	// Search, type filter and "only missing" for the side panel, kept for this visit only; the tag filter is
	// remembered (see build).
	let query = "";
	let typeId: string | null = null;
	let onlyMissing = false;
	let tag: string | null = null;
	/** The list below the panel's controls; re-rendered on its own, so typing in the search keeps focus. */
	const list = el("div", { className: "panel-list" });

	/** Builds the panel once (header, hint, filters); the list itself is drawn by render. */
	function build(): void {
		const toggle = el(
			"button",
			{
				type: "button",
				className: "panel-toggle",
				title: text.hideEntities,
				ariaLabel: text.hideEntities,
				onclick: onHide,
			},
			icon("panelClose"),
		);
		const search = el("input", {
			type: "search",
			placeholder: text.searchEntities,
			ariaLabel: text.searchEntities,
			oninput: () => {
				query = search.value;
				render();
			},
		});
		const typeFilter = el(
			"select",
			{
				ariaLabel: text.filterByType,
				onchange: () => {
					typeId = typeFilter.value || null;
					render();
				},
			},
			el("option", { value: "" }, text.allTypes),
			...store.data.types.map((t) => el("option", { value: t.id }, t.name)),
		);
		// Only with tags in use: filters by a set of entities that belong together (e.g. one project's).
		const tags = entityTags(store.data.entities);
		const byTag = tagFilter(tags, PANEL_TAG_KEY, (picked) => {
			tag = picked;
			render();
		});
		tag = byTag.tag;
		const missingFilter = el(
			"label",
			{ className: "checkbox-setting panel-missing-filter" },
			el("input", {
				type: "checkbox",
				onchange: (e) => {
					onlyMissing = (e.target as HTMLInputElement).checked;
					render();
				},
			}),
			` ${text.onlyMissing}`,
		);
		const entityFilters = el("div", { className: "panel-filters" }, search, typeFilter, ...(tags.length > 0 ? [byTag.select] : []), missingFilter);
		element.replaceChildren(
			el("div", { className: "panel-header" }, el("h2", {}, dataText.entities), toggle),
			el("p", { className: "muted" }, text.dragOntoCanvas),
			entityFilters,
			list,
		);
	}

	function render(): void {
		if (readOnly) return; // no side panel in the viewer
		preview.hide(); // its entity's item is about to be replaced
		const placed = new Set(board().cards.map((card) => card.entityId));
		const matches = filterEntities(store.data.entities, { query, typeId, tag });
		const groups = store.data.types
			.map((type) => {
				const ofType = matches.filter((e) => e.typeId === type.id);
				const missing = ofType.filter((e) => !placed.has(e.id)).length;
				return { type, all: ofType.length, missing, entities: onlyMissing ? ofType.filter((e) => !placed.has(e.id)) : ofType };
			})
			.filter((g) => g.entities.length > 0);

		/** Every filter back to all (the tag's remembered one too), the controls built anew. */
		const resetFilters = () => {
			query = "";
			typeId = null;
			onlyMissing = false;
			const tagSelect = element.querySelector<HTMLSelectElement>(`select[aria-label="${sharedText.filterByTag}"]`);
			if (tagSelect) {
				tagSelect.value = "";
				tagSelect.dispatchEvent(new Event("change"));
			}
			build();
			render();
		};
		const empty =
			store.data.entities.length > 0
				? emptyState(onlyMissing && matches.length > 0 ? text.nothingMissing : text.noMatches, { label: sharedText.resetFilters, run: resetFilters })
				: store.data.types.length > 0
					? emptyState(text.noEntitiesYet, { label: text.newEntityTitle, run: onNewEntity })
					: emptyState(dataText.createTypeFirst, { label: dataText.createNewType, href: "#types/new" });
		list.replaceChildren(
			...(groups.length === 0 ? [empty] : []),
			...groups.map(({ type, all, missing, entities }) =>
				el(
					"div",
					{ className: "panel-group" },
					el("h3", {}, typeDot(type.color), type.name, ...(missing > 0 ? [el("span", { className: "panel-group-missing" }, text.missingOf(missing, all))] : [])),
					el(
						"ul",
						{},
						...entities.map((entity) => {
							const isPlaced = placed.has(entity.id);
							const item = el(
								"li",
								{ className: isPlaced ? "panel-item placed" : "panel-item", draggable: true },
								el("span", {}, entity.name),
								// At the right, or on its own line below a long name.
								...(isPlaced ? [] : [el("span", { className: "panel-item-note" }, text.missing)]),
							);
							preview.attach(item, entity.id, { beside: true });
							item.addEventListener("dragstart", (e) => {
								preview.hide();
								if (!e.dataTransfer) return;
								e.dataTransfer.setData(ENTITY_MIME, entity.id);
								e.dataTransfer.effectAllowed = "copy";
							});
							return item;
						}),
					),
				),
			),
		);
	}

	return { element, build, render, tag: () => tag };
}
