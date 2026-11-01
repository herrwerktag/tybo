import { dragHandle, el, emptyState, reorderable, tagFilter, typeDot, sharedText, type EntityLink } from "../../../shared/ui/index.js";
import {
	entityTags,
	entityTypeMap,
	filterEntities,
	inverseReferences,
	inverseRelations,
	optionLabel,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyValue,
	type DataStore,
} from "../core.js";
import { text } from "../texts.js";
import { entityForm } from "./entity-form.js";
import { detailsPanel, type DetailsPanel } from "./details-panel.js";
import type { EntityPlaces } from "./entity-card.js";
import { fieldEditing, type FieldEditing } from "./fields.js";
import type { DataPage } from "./page.js";

const ENTITY_MIME = "application/x-entity-index";
/** The tag the Entities page is filtered by, if any. */
const ENTITIES_TAG_KEY = "entities-tag";

/** The address of an entity's row in the Entities page. */
export const entityRoute = (entityId: string) => `#entities/${encodeURIComponent(entityId)}`;

/**
 * The entities of one type (#entities) in a table, to reorder or delete, each of their fields changed where it is
 * shown (see `fieldEditing`); the form for a new one; and beside the table the details of the entity whose name was
 * clicked — where `entityLinks` and `entityPlaces` lead from an entity to the features' pages. A referenced entity is a link to its own
 * row (`#entities/<id>`), which shows its type with that row marked.
 */
export function entitiesSection(page: DataPage, entityLinks: readonly EntityLink[], entityPlaces: readonly EntityPlaces[] = []) {
	const rerender = page.rerender;
	/** The store the section shows; set on each drawing. */
	let store!: DataStore;
	/** The details beside the table, and the fields of the table being edited; made anew for each workspace. */
	let details!: DetailsPanel;
	let editing!: FieldEditing;
	const state = {
		selectedTypeId: null as string | null,
		/** The entity whose details are shown beside the table. */
		detailsId: null as string | null,
		/** Whether the form for a new entity is open; it stays hidden until asked for. */
		creatingEntity: false,
		/** The entity the address names, once its type was shown for it: shown once, so the type can be changed. */
		shownTarget: null as string | null,
		/** The row marked as the address's (see `target`). */
		markedId: null as string | null,
		/** Whether the marked row is still to be scrolled into view (once, when the address named it). */
		scrollToMarked: false,
	};

	function section(): HTMLElement {
		const header = el("div", { className: "section-header" }, page.dataSwitch("entities"));
		const section = el("section", {}, header);
		const type = store.data.types.find((t) => t.id === state.selectedTypeId);
		if (!type) {
			section.append(emptyState(text.createTypeFirst, { label: text.createNewType, href: "#types/new" }));
			return section;
		}

		// The types as chips in their colors, each with how many entities it has: the type is what the table is about.
		const showType = (typeId: string) => {
			state.selectedTypeId = typeId;
			state.creatingEntity = false;
			rerender();
		};
		const typeChips = el(
			"div",
			{ className: "type-chips", role: "group", ariaLabel: text.entityType },
			...store.data.types.map((t) => {
				const chip = el(
					"button",
					{ type: "button", className: "type-chip", ariaPressed: String(t.id === type.id), onclick: () => showType(t.id) },
					typeDot(t.color),
					el("span", {}, t.name),
					el("span", { className: "type-chip-count" }, String(store.data.entities.filter((e) => e.typeId === t.id).length)),
				);
				chip.style.setProperty("--type-color", t.color);
				return chip;
			}),
		);

		// Only with tags in use: shows one set of entities that belong together (e.g. one project's).
		const tags = entityTags(store.data.entities);
		const byTag = tagFilter(tags, ENTITIES_TAG_KEY, () => rerender());
		const ofType = store.data.entities.filter((e) => e.typeId === type.id);
		const entities = filterEntities(ofType, { query: "", typeId: null, tag: byTag.tag });

		const formOpen = state.creatingEntity;
		const createButton = el(
			"button",
			{
				type: "button",
				className: "primary",
				onclick: () => {
					state.creatingEntity = true;
					page.focusForm("entity");
					rerender();
				},
			},
			text.createNewEntity,
		);

		// Without entities of the type, the empty list offers the button.
		header.append(...(formOpen || ofType.length === 0 ? [] : [createButton]));
		section.append(el("div", { className: "section-filters" }, typeChips, ...(tags.length > 0 ? [byTag.select] : [])));
		// Empty for the filter: it can be reset; empty for good (and no form open yet): a first one can be made.
		const filtered = byTag.tag !== null && ofType.length > 0;
		const resetTag = () => {
			byTag.select.value = "";
			byTag.select.dispatchEvent(new Event("change"));
		};
		const empty = filtered
			? emptyState(text.noEntitiesWithTag(type.name, byTag.tag!), { label: sharedText.resetFilters, run: resetTag })
			: emptyState(text.noEntitiesOfType(type.name), formOpen ? undefined : { label: text.createNewEntity, run: () => createButton.click() });
		section.append(
			...(formOpen
				? [
						entityForm(store, type, {
							filterTag: byTag.tag,
							onDone: () => {
								state.creatingEntity = false;
								rerender();
							},
						}),
					]
				: []),
			entities.length > 0 ? entityTable(type, entities, ofType) : empty,
		);
		details.show(state.detailsId);
		state.detailsId = details.shown();
		return el("div", { className: "entities-view" }, section, details.handle, details.element);
	}

	/** The entities shown (maybe filtered by a tag) of all those of the type, `ofType`, in which they're reordered. */
	function entityTable(type: EntityType, entities: Entity[], ofType: Entity[]): HTMLElement {
		const names = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const types = new Map(store.data.types.map((t) => [t.id, t]));
		const entityTypes = entityTypeMap(store.data);
		/** Referenced entities as tags in their type's color, like on the cards. */
		const refTags = (ids: readonly string[]): HTMLElement => {
			const tags = ids.map((id) => {
				const tag = el("a", { className: "ref-tag", href: entityRoute(id) }, names.get(id) ?? "?");
				const color = types.get(entityTypes.get(id) ?? "")?.color;
				if (color) tag.style.background = color;
				return tag;
			});
			return el("div", { className: "prop-chips" }, ...tags);
		};
		const empty = () => el("span", { className: "muted" }, "—");
		const format = (p: PropertyDef, value: PropertyValue | undefined): Node => {
			if (value === null || value === undefined) return empty();
			const parts = typeof value === "string" ? [value] : value;
			if (p.kind === "reference") return refTags(parts);
			if (p.kind === "options") return el("div", { className: "prop-chips" }, ...parts.map((id) => el("span", { className: "chip" }, optionLabel(p, id) ?? "?")));
			return document.createTextNode(parts.join(", "));
		};

		// Read-only columns for the reverse side of references to this type, e.g. "responsible for" on Role.
		const inverseColumns = inverseRelations(store.data.types, type.id);
		const sourceTypeName = (id: string) => store.data.types.find((t) => t.id === id)?.name ?? "?";
		const inverseCell = (entity: Entity, propId: string): Node => {
			const ids = inverseReferences(store.data, entity).find((r) => r.prop.id === propId)?.entityIds ?? [];
			return ids.length > 0 ? refTags(ids) : empty();
		};
		/** Shows the entity's details beside the table. */
		const showDetails = (entity: Entity) => {
			state.detailsId = entity.id;
			rerender();
		};

		const table = el(
			"table",
			{ className: "entity-table" },
			el(
				"thead",
				{},
				el(
					"tr",
					{},
					el("th", {}),
					el("th", {}, sharedText.name),
					...type.properties.map((p) => el("th", {}, p.name)),
					...inverseColumns.map((c) =>
						el("th", { className: "inverse", title: text.setOn(sourceTypeName(c.sourceTypeId), c.prop.name) }, c.label),
					),
					el("th", {}, text.tags),
					el("th", {}),
				),
			),
			el(
				"tbody",
				{},
				...entities.map((entity, i) => {
					const handle = dragHandle(text.moveEntity(entity.name), `entity:${entity.id}`);
					const row = el(
						"tr",
						{ className: entity.id === state.markedId ? (state.scrollToMarked ? "target scroll-to" : "target") : "" },
						el("td", { className: "handle-cell" }, handle),
						el(
							"td",
							{ className: "name-cell" },
							el("button", { type: "button", className: "name-link", title: text.showDetails(entity.name), onclick: () => showDetails(entity) }, entity.name),
						),
						...type.properties.map((p) => el("td", {}, editing.property(entity, p, [format(p, entity.values[p.id])]))),
						...inverseColumns.map((c) => el("td", { className: "inverse" }, inverseCell(entity, c.prop.id))),
						el(
							"td",
							{},
							editing.tags(entity, [
								entity.tags.length > 0 ? el("div", { className: "prop-chips" }, ...entity.tags.map((t) => el("span", { className: "chip" }, t))) : empty(),
							]),
						),
						el(
							"td",
							{ className: "actions-cell" },
							el(
								"div",
								{ className: "actions" },
								el(
									"button",
									{
										type: "button",
										onclick: () => {
											const refs = store.referencesTo(entity.id);
											if (confirm(text.confirmDeleteEntity(entity.name, refs))) {
												store.deleteEntity(entity.id);
												rerender();
											}
										},
									},
									sharedText.delete,
								),
							),
						),
					);
					// Clicking the row beside its fields shows the entity's details.
					row.addEventListener("click", (event) => {
						if (!(event.target as Element).closest("button, a, input, select, textarea, form, .editable")) showDetails(entity);
					});
					reorderable(row, handle, {
						index: i,
						count: entities.length,
						mime: ENTITY_MIME,
						// To the place of the entity it's dropped at, among all of the type (also those filtered out).
						move: (from, to) => {
							const moved = entities[from]!.id;
							store.moveEntity(moved, ofType.findIndex((e) => e.id === entities[to]!.id));
							page.focusHandle(`entity:${moved}`);
							rerender();
						},
					});
					return row;
				}),
			),
		);
		// Narrow screens show each row as a card (see CSS), with its column's name above every value.
		const labels = [...table.querySelectorAll("th")].map((th) => th.textContent ?? "");
		for (const row of table.querySelectorAll("tbody tr")) {
			for (const [i, cell] of [...row.querySelectorAll("td")].entries()) cell.dataset.label = labels[i] ?? "";
		}
		return el("div", { className: "table-wrap" }, table);
	}

	return {
		/** Another workspace (or the first): its first type, nothing being edited. */
		reset(current: DataStore): void {
			store = current;
			state.selectedTypeId = store.data.types[0]?.id ?? null;
			state.detailsId = null;
			state.creatingEntity = false;
			editing = fieldEditing(store, rerender);
			details = detailsPanel(store, {
				onClose: () => {
					state.detailsId = null;
					rerender();
				},
				onSelectEntity: (entityId) => {
					state.detailsId = entityId;
					rerender();
				},
				onSaved: rerender,
				links: entityLinks,
				places: entityPlaces,
			});
		},
		/** Shows the entities of this type (e.g. one just saved). */
		showType(typeId: string): void {
			state.selectedTypeId = typeId;
		},
		/** `target`: the entity the address names — the first time, its type is shown with its row marked — or "new",
		 * the form for a new entity (of `newType`, if the address names one). */
		render(current: DataStore, target: string | null = null, newType: string | null = null): HTMLElement {
			store = current;
			const entity = target === null ? undefined : store.data.entities.find((e) => e.id === target);
			if (target !== state.shownTarget) {
				state.shownTarget = target;
				state.markedId = entity?.id ?? null;
				state.scrollToMarked = entity !== undefined;
				if (entity) {
					state.selectedTypeId = entity.typeId;
					state.creatingEntity = false;
				} else if (target === "new") {
					// The form for a new entity, of the type shown (or named).
					if (newType !== null && store.data.types.some((t) => t.id === newType)) state.selectedTypeId = newType;
					state.creatingEntity = true;
					page.focusForm("entity");
				}
			}
			if (!store.data.types.some((t) => t.id === state.selectedTypeId)) state.selectedTypeId = store.data.types[0]?.id ?? null;
			const drawn = section();
			state.scrollToMarked = false;
			return drawn;
		},
	};
}
