import type { Store } from "../../../features.core.js";
import { dragHandle, el, reorderable, tagFilter, type EntityLink } from "../../../shared/ui/index.js";
import {
	entityTags,
	filterEntities,
	inverseReferences,
	inverseRelations,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyValue,
} from "../core.js";
import { text } from "../texts.js";
import { entityForm } from "./entity-form.js";
import type { DataPage } from "./page.js";

const ENTITY_MIME = "application/x-entity-index";
/** The tag the Entities page is filtered by, if any. */
const ENTITIES_TAG_KEY = "entities-tag";

/**
 * The entities of one type (#entities) in a table, to reorder, edit or delete, and the form for a new or changed one —
 * where `entityLinks` lead from an entity to the features' pages.
 */
export function entitiesSection(page: DataPage, entityLinks: readonly EntityLink[]) {
	const rerender = page.rerender;
	/** The store the section shows; set on each drawing. */
	let store!: Store;
	const state = {
		selectedTypeId: null as string | null,
		editingEntityId: null as string | null,
		/** Whether the form for a new entity is open; it stays hidden until asked for. */
		creatingEntity: false,
	};

	function section(): HTMLElement {
		const header = el("div", { className: "section-header" }, page.dataSwitch("entities"));
		const section = el("section", {}, header);
		const type = store.data.types.find((t) => t.id === state.selectedTypeId);
		if (!type) {
			section.append(el("p", { className: "muted" }, text.createTypeFirst));
			return section;
		}

		const typeSelect = el(
			"select",
			{
				ariaLabel: text.entityType,
				onchange: () => {
					state.selectedTypeId = typeSelect.value;
					state.editingEntityId = null;
					state.creatingEntity = false;
					rerender();
				},
			},
			...store.data.types.map((t) => el("option", { value: t.id, selected: t.id === type.id }, t.name)),
		);

		// Only with tags in use: shows one set of entities that belong together (e.g. one project's).
		const tags = entityTags(store.data.entities);
		const byTag = tagFilter(tags, ENTITIES_TAG_KEY, () => rerender());
		const ofType = store.data.entities.filter((e) => e.typeId === type.id);
		const entities = filterEntities(ofType, { query: "", typeId: null, tag: byTag.tag });
		const editing = ofType.find((e) => e.id === state.editingEntityId);

		const formOpen = editing !== undefined || state.creatingEntity;
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

		header.append(
			el("div", { className: "section-filters" }, typeSelect, ...(tags.length > 0 ? [byTag.select] : [])),
			...(formOpen ? [] : [createButton]),
		);
		const empty = byTag.tag && ofType.length > 0 ? text.noEntitiesWithTag(type.name, byTag.tag) : text.noEntitiesOfType(type.name);
		section.append(
			...(formOpen
				? [
						entityForm(store, type, editing, {
							filterTag: byTag.tag,
							links: entityLinks,
							onDone: () => {
								state.editingEntityId = null;
								state.creatingEntity = false;
								rerender();
							},
						}),
					]
				: []),
			entities.length > 0 ? entityTable(type, entities, ofType) : el("p", { className: "muted" }, empty),
		);
		return section;
	}

	/** The entities shown (maybe filtered by a tag) of all those of the type, `ofType`, in which they're reordered. */
	function entityTable(type: EntityType, entities: Entity[], ofType: Entity[]): HTMLElement {
		const names = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const format = (p: PropertyDef, value: PropertyValue | undefined): string => {
			if (value === null || value === undefined) return "—";
			const parts = typeof value === "string" ? [value] : value;
			return p.kind === "reference" ? parts.map((id) => names.get(id) ?? "?").join(", ") : parts.join(", ");
		};

		// Read-only columns for the reverse side of references to this type, e.g. "responsible for" on Role.
		const inverseColumns = inverseRelations(store.data.types, type.id);
		const sourceTypeName = (id: string) => store.data.types.find((t) => t.id === id)?.name ?? "?";
		const inverseCell = (entity: Entity, propId: string): string => {
			const ids = inverseReferences(store.data, entity).find((r) => r.prop.id === propId)?.entityIds ?? [];
			return ids.length > 0 ? ids.map((id) => names.get(id) ?? "?").join(", ") : "—";
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
					el("th", {}, text.id),
					el("th", {}, text.name),
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
						{},
						el("td", { className: "handle-cell" }, handle),
						el("td", { className: "mono nowrap", title: entity.id }, `…${entity.id.slice(-8)}`),
						el("td", {}, entity.name),
						...type.properties.map((p) => el("td", {}, format(p, entity.values[p.id]))),
						...inverseColumns.map((c) => el("td", { className: "inverse" }, inverseCell(entity, c.prop.id))),
						el("td", {}, entity.tags.length > 0 ? entity.tags.join(", ") : "—"),
						el(
							"td",
							{},
							el(
								"div",
								{ className: "actions" },
								el(
									"button",
									{
										type: "button",
										onclick: () => {
											state.editingEntityId = entity.id;
											page.focusForm("entity");
											rerender();
										},
									},
									text.edit,
								),
								el(
									"button",
									{
										type: "button",
										onclick: () => {
											const refs = store.referencesTo(entity.id);
											if (confirm(text.confirmDeleteEntity(entity.name, refs))) {
												store.deleteEntity(entity.id);
												if (state.editingEntityId === entity.id) state.editingEntityId = null;
												rerender();
											}
										},
									},
									text.delete,
								),
							),
						),
					);
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
		reset(current: Store): void {
			store = current;
			state.selectedTypeId = store.data.types[0]?.id ?? null;
			state.editingEntityId = null;
			state.creatingEntity = false;
		},
		/** Shows the entities of this type (e.g. one just saved), none being edited. */
		showType(typeId: string): void {
			state.selectedTypeId = typeId;
			state.editingEntityId = null;
		},
		render(current: Store): HTMLElement {
			store = current;
			if (!store.data.types.some((t) => t.id === state.selectedTypeId)) {
				state.selectedTypeId = store.data.types[0]?.id ?? null;
				state.editingEntityId = null;
			}
			return section();
		},
	};
}
