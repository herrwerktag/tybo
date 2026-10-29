import type { Store } from "../../../legacy/core/index.js";
import { moveItem } from "../../../shared/core/index.js";
import {
	CARD_DISPLAYS,
	LINE_ARROWS,
	PROPERTY_KINDS,
	TYPE_COLORS,
	effectiveCardDisplay,
	entityTags,
	entityTypeMap,
	filterEntities,
	inverseReferences,
	inverseRelations,
	migrateValues,
	newReference,
	nextTypeColor,
	validateType,
	type CardDisplay,
	type DraftProperty,
	type LineArrow,
	type Entity,
	type EntityType,
	type PropertyDef,
	type ReferenceDef,
	type PropertyKind,
	type PropertyValue,
	type ValidationError,
} from "../core.js";
import { dragHandle, el, reorderable, tagFilter, typeDot, type PageMaker } from "../../../shared/ui/index.js";
import { entityForm } from "./entity-form.js";
import { text } from "../texts.js";

interface UiState {
	editingTypeId: string | null;
	draftName: string;
	draftContentTemplate: string;
	draftColor: string;
	draftProps: DraftProperty[];
	typeErrors: ValidationError[];
	selectedTypeId: string | null;
	editingEntityId: string | null;
	/** Whether the form for a new type / a new entity is open; they stay hidden until asked for. */
	creatingType: boolean;
	creatingEntity: boolean;
	/** Form to scroll into view and focus after the next render (set when Edit is clicked). */
	focusForm: "type" | "entity" | null;
	/** Drag handle (its `data-focus-key`) to focus after the next render, so keyboard reordering keeps focus on the
	 * moved item. */
	focusHandle: string | null;
}

const PROPERTY_MIME = "application/x-property-index";
const TYPE_MIME = "application/x-type-index";
const ENTITY_MIME = "application/x-entity-index";
/** The tag the Entities page is filtered by, if any. */
const ENTITIES_TAG_KEY = "entities-tag";


/** Counts existing non-empty values of the type's entities that saving these properties would change or clear. */
function countChangedValues(entities: Entity[], props: DraftProperty[], entityTypes: ReadonlyMap<string, string>): number {
	const kept = props.flatMap((p) => (p.id ? [{ ...p, id: p.id }] : []));
	let changed = 0;
	for (const entity of entities) {
		const migrated = migrateValues(entity.values, kept, entityTypes);
		for (const [id, value] of Object.entries(entity.values)) {
			if (value !== null && JSON.stringify(migrated[id] ?? null) !== JSON.stringify(value)) changed++;
		}
	}
	return changed;
}

function describeProperty(p: PropertyDef, types: EntityType[]): string {
	if (p.kind === "options") return `${p.name}: ${p.options.join(" / ")}`;
	if (p.kind === "reference") {
		const target = (p.reference?.typeIds ?? []).map((id) => types.find((t) => t.id === id)?.name ?? "?").join(" / ") || "?";
		// No-break spaces keep "→ Target (multiple)" together; a long line wraps after the property name.
		const multiple = p.reference?.multiple ? `\u00a0${text.multipleSuffix}` : "";
		const suffix = multiple + (p.reference?.required ? `\u00a0${text.requiredSuffix}` : "");
		return `${p.name} →\u00a0${target}${suffix}`;
	}
	return `${p.name}: ${text.kinds.text}`;
}

/** A small label above a control, for the settings inside a property card. */
function setting(label: string, control: HTMLElement): HTMLElement {
	return el("label", { className: "field" }, el("span", { className: "setting-label" }, label), control);
}

function newDraftProperty(): DraftProperty {
	return { name: "", kind: "text", options: [], reference: null, cardDisplay: "list" };
}


/**
 * The Data tab: the entity types with their properties (#types), and the entities of a type in a table (#entities),
 * each with its form. What is being edited stays while the page is drawn anew; another workspace starts afresh.
 */
export const DATA_PAGE: PageMaker<Store> = (shell) => {
	const rerender = shell.rerender;
	/** The store the page shows; set on each drawing. */
	let store!: Store;
	/** The store the page last started afresh for. */
	let shownStore: Store | null = null;
	const state: UiState = {
		editingTypeId: null,
		draftName: "",
		draftContentTemplate: "",
		draftColor: "",
		draftProps: [],
		typeErrors: [],
		selectedTypeId: null,
		editingEntityId: null,
		creatingType: false,
		creatingEntity: false,
		focusForm: null,
		focusHandle: null,
	};

	function resetTypeForm(): void {
		state.editingTypeId = null;
		state.draftName = "";
		state.draftContentTemplate = "";
		state.draftColor = nextTypeColor(store.data.types.map((t) => t.color));
		state.draftProps = [];
		state.typeErrors = [];
		state.creatingType = false;
	}


	/** In place of the data pages' heading: switches between them, the entity types and the entities. */
	function dataSwitch(route: "types" | "entities"): HTMLElement {
		const tab = (id: "types" | "entities", label: string) =>
			el("a", { href: `#${id}`, className: route === id ? "current" : "" }, label);
		const nav = el("nav", { className: "data-switch", ariaLabel: text.tabEntities }, tab("types", text.entityTypes), tab("entities", text.entities));
		nav.querySelector(".current")?.setAttribute("aria-current", "page");
		return nav;
	}


	/** The target types of a reference as tags in their colors (× removes one), and a select adding another. */
	function referenceTypesSetting(reference: ReferenceDef): HTMLElement {
		const chosen = reference.typeIds.flatMap((id) => store.data.types.filter((t) => t.id === id));
		const rest = store.data.types.filter((t) => !reference.typeIds.includes(t.id));
		const tags = chosen.map((t) => {
			const tag = el(
				"span",
				{ className: "ref-tag reference-type" },
				t.name,
				el(
					"button",
					{
						type: "button",
						className: "reference-type-remove",
						title: text.removeReferenceType(t.name),
						ariaLabel: text.removeReferenceType(t.name),
						onclick: () => {
							reference.typeIds = reference.typeIds.filter((id) => id !== t.id);
							rerender();
						},
					},
					"×",
				),
			);
			tag.style.background = t.color;
			return tag;
		});
		const add =
			store.data.types.length === 0
				? el("span", { className: "muted" }, text.noTypesOption)
				: rest.length > 0
					? el(
							"select",
							{
								ariaLabel: text.addReferenceType,
								onchange: (e) => {
									reference.typeIds = [...reference.typeIds, (e.target as HTMLSelectElement).value];
									rerender();
								},
							},
							el("option", { value: "", selected: true, disabled: true }, text.addReferenceType),
							...rest.map((t) => el("option", { value: t.id }, t.name)),
						)
					: null;
		return el(
			"div",
			{ className: "field" },
			el("span", { className: "setting-label" }, text.references),
			...(tags.length > 0 ? [el("div", { className: "prop-chips" }, ...tags)] : []),
			...(add ? [add] : []),
		);
	}

	function propertyRow(prop: DraftProperty, i: number): HTMLElement {
		const kindSelect = el(
			"select",
			{
				onchange: () => {
					prop.kind = kindSelect.value as PropertyKind;
					prop.cardDisplay = effectiveCardDisplay(prop);
					if (prop.kind === "reference" && !prop.reference) {
						prop.reference = newReference([]);
					}
					rerender();
				},
			},
			...PROPERTY_KINDS.map((kind) => el("option", { value: kind, selected: kind === prop.kind }, text.kinds[kind])),
		);
		const handle = dragHandle(text.moveProperty(prop.name.trim() || String(i + 1)), `property:${i}`);
		const nameInput = el("input", {
			placeholder: text.propertyName,
			ariaLabel: text.propertyName,
			value: prop.name,
			oninput: (e) => {
				prop.name = (e.target as HTMLInputElement).value;
			},
		});
		const removeButton = el(
			"button",
			{
				type: "button",
				className: "property-remove",
				title: text.removeProperty,
				ariaLabel: text.removePropertyNamed(prop.name.trim() || String(i + 1)),
				onclick: () => {
					state.draftProps.splice(i, 1);
					rerender();
				},
			},
			"✕",
		);
		const displaySelect = el(
			"select",
			{
				title: text.onCardHint,
				onchange: (e) => {
					prop.cardDisplay = (e.target as HTMLSelectElement).value as CardDisplay;
					rerender(); // shows or hides the line settings
				},
			},
			...CARD_DISPLAYS.filter((display) => display !== "line" || prop.kind === "reference").map((display) =>
				el("option", { value: display, selected: display === prop.cardDisplay }, text.cardDisplays[display]),
			),
		);
		// Handle, name and remove on top; then labeled settings, two per row.
		const row = el(
			"div",
			{ className: "property" },
			el("div", { className: "property-head" }, handle, nameInput, removeButton),
			el("div", { className: "property-settings" }, setting(text.settingType, kindSelect), setting(text.settingOnCard, displaySelect)),
		);
		reorderable(row, handle, {
			index: i,
			count: state.draftProps.length,
			mime: PROPERTY_MIME,
			move: (from, to) => {
				state.draftProps = moveItem(state.draftProps, from, to);
				state.focusHandle = `property:${to}`;
				rerender();
			},
		});
		if (prop.kind === "options") {
			row.append(
				setting(
					text.optionsOnePerLine,
					el("textarea", {
						rows: Math.max(3, prop.options.length + 1),
						value: prop.options.join("\n"),
						oninput: (e) => {
							prop.options = (e.target as HTMLTextAreaElement).value.split("\n");
						},
					}),
				),
			);
		}
		if (prop.kind === "reference" && prop.reference) {
			const reference = prop.reference;
			row.append(
				el(
					"div",
					{ className: "property-settings" },
					referenceTypesSetting(reference),
					el(
						"label",
						{ className: "checkbox-setting" },
						el("input", {
							type: "checkbox",
							checked: reference.multiple,
							onchange: (e) => {
								reference.multiple = (e.target as HTMLInputElement).checked;
							},
						}),
						` ${text.allowMultiple}`,
					),
					el(
						"label",
						{ className: "checkbox-setting", title: text.requiredReferenceHint },
						el("input", {
							type: "checkbox",
							checked: reference.required,
							onchange: (e) => {
								reference.required = (e.target as HTMLInputElement).checked;
							},
						}),
						` ${text.requiredReference}`,
					),
				),
			);
			row.append(
				setting(
					text.shownOnTargetAs,
					el("input", {
						value: reference.inverseLabel,
						placeholder: text.shownOnTargetAsPlaceholder,
						title: text.shownOnTargetAsHint,
						oninput: (e) => {
							reference.inverseLabel = (e.target as HTMLInputElement).value;
						},
					}),
				),
			);
			if (effectiveCardDisplay(prop) === "line") {
				row.append(
					el(
						"div",
						{ className: "property-settings" },
						setting(
							text.arrow,
							el(
								"select",
								{
									onchange: (e) => {
										reference.arrow = (e.target as HTMLSelectElement).value as LineArrow;
									},
								},
								...LINE_ARROWS.map((arrow) =>
									el("option", { value: arrow, selected: arrow === reference.arrow }, text.arrows[arrow]),
								),
							),
						),
						setting(
							text.lineLabel,
							el("input", {
								value: reference.lineLabel,
								placeholder: prop.name.trim() || text.lineLabelPlaceholder,
								oninput: (e) => {
									reference.lineLabel = (e.target as HTMLInputElement).value;
								},
							}),
						),
					),
				);
			}
		}
		return row;
	}

	/** Palette swatches for the type form; the current color is pressed. */
	function colorPicker(): HTMLElement {
		return el(
			"div",
			{ className: "field" },
			el("span", {}, text.color),
			el(
				"div",
				{ className: "swatches" },
				...TYPE_COLORS.map(({ name, value }) => {
					const swatch = el("button", {
						type: "button",
						className: "swatch",
						title: text.colorNames[name] ?? name,
						ariaLabel: text.colorNames[name] ?? name,
						ariaPressed: String(value === state.draftColor),
						onclick: () => {
							state.draftColor = value;
							rerender();
						},
					});
					swatch.style.background = value;
					return swatch;
				}),
			),
		);
	}

	function typesSection(): HTMLElement {
		const editingType = store.data.types.find((t) => t.id === state.editingTypeId);

		const form = el(
			"form",
			{
				id: "type-form",
				className: "card",
				onsubmit: (e) => {
					e.preventDefault();
					const props = state.draftProps.map((p) => ({
						...p,
						options: p.kind === "options" ? p.options.map((o) => o.trim()).filter((o) => o !== "") : [],
					}));
					state.typeErrors = validateType(state.draftName, props, new Set(store.data.types.map((t) => t.id)));
					if (state.typeErrors.length > 0) return rerender();

					if (editingType) {
						const entities = store.data.entities.filter((en) => en.typeId === editingType.id);
						const changed = countChangedValues(entities, props, entityTypeMap(store.data));
						if (changed > 0 && !confirm(text.confirmChangedValues(changed))) return;
						store.updateType(editingType.id, state.draftName, props, state.draftContentTemplate, state.draftColor);
						state.selectedTypeId = editingType.id;
					} else {
						state.selectedTypeId = store.addType(state.draftName, props, state.draftContentTemplate, state.draftColor).id;
					}
					state.editingEntityId = null;
					resetTypeForm();
					rerender();
				},
			},
			el("h3", {}, editingType ? text.editNamed(editingType.name) : text.newType),
			el(
				"label",
				{ className: "field" },
				el("span", {}, text.typeName),
				el("input", {
					value: state.draftName,
					placeholder: text.typeNamePlaceholder,
					oninput: (e) => {
						state.draftName = (e.target as HTMLInputElement).value;
					},
				}),
			),
			colorPicker(),
			el("h3", {}, text.properties),
			el(
				"div",
				{ className: "builtin" },
				el("p", {}, el("strong", {}, "id"), text.builtinId),
				el("p", {}, el("strong", {}, "name"), text.builtinName),
				el("p", {}, el("strong", {}, "description"), text.builtinDescription),
				// The template below belongs to content, so content comes last.
				el("p", {}, el("strong", {}, "content"), text.builtinContent),
				el(
					"label",
					{ className: "field wide" },
					el("span", {}, text.contentTemplate),
					el("textarea", {
						rows: 4,
						value: state.draftContentTemplate,
						oninput: (e) => {
							state.draftContentTemplate = (e.target as HTMLTextAreaElement).value;
						},
					}),
				),
			),
			...state.draftProps.map(propertyRow),
			el(
				"div",
				{ className: "row" },
				el(
					"button",
					{
						type: "button",
						onclick: () => {
							state.draftProps.push(newDraftProperty());
							rerender();
						},
					},
					text.addProperty,
				),
				el("button", { type: "submit", className: "primary" }, editingType ? text.save : text.createType),
				el(
					"button",
					{
						type: "button",
						onclick: () => {
							resetTypeForm();
							rerender();
						},
					},
					text.cancel,
				),
			),
			...state.typeErrors.map((error) => el("p", { className: "error" }, text.validation(error))),
		);

		const list = el(
			"ul",
			{ className: "type-list" },
			...store.data.types.map((type, i) => {
				const handle = dragHandle(text.moveType(type.name), `type:${type.id}`);
				const item = el(
					"li",
					{ className: type.id === state.editingTypeId ? "type-item current" : "type-item" },
					// Name and buttons on top; the properties below, one per line, across the full width.
					handle,
					el("strong", { className: "type-name" }, typeDot(type.color), type.name),
					type.properties.length > 0
						? el(
								"ul",
								{ className: "type-summary muted" },
								...type.properties.map((p) => el("li", {}, describeProperty(p, store.data.types))),
							)
						: el("p", { className: "type-summary muted" }, text.noProperties),
					el(
						"div",
						{ className: "actions" },
						el(
							"button",
							{
								type: "button",
								onclick: () => {
									state.editingTypeId = type.id;
									state.draftName = type.name;
									state.draftContentTemplate = type.contentTemplate;
								state.draftColor = type.color;
									state.draftProps = type.properties.map((p) => ({
										...p,
										options: [...p.options],
										reference: p.reference && { ...p.reference },
									}));
									state.typeErrors = [];
									state.focusForm = "type";
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
									const referrers = store.typeReferrers(type.id);
									if (referrers.length > 0) {
										alert(text.cannotDeleteType(type.name, referrers.join(", ")));
										return;
									}
									const count = store.data.entities.filter((e) => e.typeId === type.id).length;
									if (confirm(text.confirmDeleteType(type.name, count))) {
										store.deleteType(type.id);
										if (state.editingTypeId === type.id) resetTypeForm();
										rerender();
									}
								},
							},
							text.delete,
						),
					),
				);
				reorderable(item, handle, {
					index: i,
					count: store.data.types.length,
					mime: TYPE_MIME,
					move: (from, to) => {
						const moved = store.data.types[from]!.id;
						store.moveType(moved, to);
						state.focusHandle = `type:${moved}`;
						rerender();
					},
				});
				return item;
			}),
		);

		const createButton = el(
			"button",
			{
				type: "button",
				className: "primary",
				onclick: () => {
					resetTypeForm();
					state.creatingType = true;
					state.focusForm = "type";
					rerender();
				},
			},
			text.createNewType,
		);

		return el(
			"section",
			{},
			el("div", { className: "section-header" }, dataSwitch("types"), ...(editingType || state.creatingType ? [] : [createButton])),
			...(editingType || state.creatingType ? [form] : []),
			store.data.types.length > 0 ? list : el("p", { className: "muted" }, text.noTypesYet),
		);
	}

	function entitiesSection(): HTMLElement {
		const header = el("div", { className: "section-header" }, dataSwitch("entities"));
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
					state.focusForm = "entity";
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
											state.focusForm = "entity";
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
							state.focusHandle = `entity:${moved}`;
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
		routes: ["entities", "types"],
		label: () => text.tabEntities,
		render(current: Store): HTMLElement {
			store = current;
			if (current !== shownStore) {
				// Another workspace (or the first): nothing of the one before is being edited here.
				shownStore = current;
				resetTypeForm();
				state.selectedTypeId = store.data.types[0]?.id ?? null;
				state.editingEntityId = null;
				state.creatingEntity = false;
			}
			if (!store.data.types.some((t) => t.id === state.selectedTypeId)) {
				state.selectedTypeId = store.data.types[0]?.id ?? null;
				state.editingEntityId = null;
			}
			const route = location.hash.slice(1).split("/")[0] === "types" ? "types" : "entities";
			return el("div", { className: "data-view" }, route === "types" ? typesSection() : entitiesSection());
		},
		afterRender(root: HTMLElement): void {
			if (state.focusHandle !== null) {
				root.querySelector<HTMLElement>(`.drag-handle[data-focus-key="${state.focusHandle}"]`)?.focus();
				state.focusHandle = null;
			}
			if (state.focusForm) {
				const form = root.querySelector<HTMLFormElement>(`#${state.focusForm}-form`);
				state.focusForm = null;
				form?.scrollIntoView({ block: "nearest", behavior: "smooth" });
				form?.querySelector<HTMLElement>("input, select, textarea")?.focus({ preventScroll: true });
			}
		},
	};
};
