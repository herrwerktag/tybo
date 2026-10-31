import { el, tagFilter, typeDot } from "../../../shared/ui/index.js";
import { entityTags, filterEntities } from "../../data/core.js";
import { text as dataText } from "../../data/texts.js";
import type { CardPreview } from "../../data/ui/entity-card.js";
import type { Board, BoardStore } from "../core.js";
import { text } from "../texts.js";

/** What an entity dragged from the side panel carries: its id. */
export const ENTITY_MIME = "application/x-entity-id";

/** The tag the side panel's entities are filtered by, if any. */
const PANEL_TAG_KEY = "canvas-panel-tag";

/**
 * The editor's side panel: the entities, by type, to drag onto the board (`board`, whose cards it counts), found by
 * name, type and tag. Hovering or focusing one shows its card beside it (`preview`). Its fold button calls `onHide`.
 */
export function entityPanel(
	store: BoardStore,
	{ board, readOnly, preview, onHide }: { board: () => Board; readOnly: boolean; preview: CardPreview; onHide: () => void },
) {
	const element = el("aside", { className: "canvas-panel" });
	// Scrolling the list would leave the preview beside an entity no longer there (scrolling to a focused one doesn't).
	element.addEventListener("wheel", preview.hide, { passive: true });

	// Search and type filter for the side panel, kept for this visit only; the tag filter is remembered (see build).
	let query = "";
	let typeId: string | null = null;
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
			"«",
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
		const entityFilters = el("div", { className: "panel-filters" }, search, typeFilter, ...(tags.length > 0 ? [byTag.select] : []));
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
		const cardCounts = new Map<string, number>();
		for (const card of board().cards) cardCounts.set(card.entityId, (cardCounts.get(card.entityId) ?? 0) + 1);
		const matches = filterEntities(store.data.entities, { query, typeId, tag });
		const groups = store.data.types
			.map((type) => ({ type, entities: matches.filter((e) => e.typeId === type.id) }))
			.filter((g) => g.entities.length > 0);

		const empty = store.data.entities.length === 0 ? text.noEntitiesYet : text.noMatches;
		list.replaceChildren(
			...(groups.length === 0 ? [el("p", { className: "muted" }, empty)] : []),
			...groups.map(({ type, entities }) =>
				el(
					"div",
					{ className: "panel-group" },
					el("h3", {}, typeDot(type.color), type.name),
					el(
						"ul",
						{},
						...entities.map((entity) => {
							const count = cardCounts.get(entity.id) ?? 0;
							const item = el(
								"li",
								{ className: count > 0 ? "panel-item placed" : "panel-item", draggable: true },
								el("span", {}, entity.name),
								// Always on its own line below the name.
								...(count > 0 ? [el("span", { className: "panel-item-note muted" }, text.onCanvas(count))] : []),
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
