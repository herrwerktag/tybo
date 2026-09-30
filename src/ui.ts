import {
	PROPERTY_KINDS,
	entityTypeMap,
	migrateValues,
	parseValue,
	validateType,
	type DraftProperty,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyKind,
	type PropertyValue,
} from "./model.js";
import type { Store } from "./store.js";

interface UiState {
	editingTypeId: string | null;
	draftName: string;
	draftContentTemplate: string;
	draftProps: DraftProperty[];
	typeErrors: string[];
	selectedTypeId: string | null;
	editingEntityId: string | null;
	/** Form to scroll into view and focus after the next render (set when Edit is clicked). */
	focusForm: "type" | "entity" | null;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
}

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
		const target = types.find((t) => t.id === p.reference?.typeId)?.name ?? "?";
		return `${p.name} → ${target}${p.reference?.multiple ? " (multiple)" : ""}`;
	}
	return `${p.name}: text`;
}

function newDraftProperty(): DraftProperty {
	return { name: "", kind: "text", options: [], reference: null };
}

export function render(root: HTMLElement, store: Store): void {
	const state: UiState = {
		editingTypeId: null,
		draftName: "",
		draftContentTemplate: "",
		draftProps: [],
		typeErrors: [],
		selectedTypeId: store.data.types[0]?.id ?? null,
		editingEntityId: null,
		focusForm: null,
	};

	function resetTypeForm(): void {
		state.editingTypeId = null;
		state.draftName = "";
		state.draftContentTemplate = "";
		state.draftProps = [];
		state.typeErrors = [];
	}

	function rerender(): void {
		if (!store.data.types.some((t) => t.id === state.selectedTypeId)) {
			state.selectedTypeId = store.data.types[0]?.id ?? null;
			state.editingEntityId = null;
		}
		root.replaceChildren(typesSection(), entitiesSection());
		if (state.focusForm) {
			const form = root.querySelector<HTMLFormElement>(`#${state.focusForm}-form`);
			state.focusForm = null;
			form?.scrollIntoView({ block: "nearest", behavior: "smooth" });
			form?.querySelector<HTMLElement>("input, select, textarea")?.focus({ preventScroll: true });
		}
	}

	function propertyRow(prop: DraftProperty, i: number): HTMLElement {
		const kindSelect = el(
			"select",
			{
				ariaLabel: "Property type",
				onchange: () => {
					prop.kind = kindSelect.value as PropertyKind;
					if (prop.kind === "reference" && !prop.reference) {
						prop.reference = { typeId: store.data.types[0]?.id ?? "", multiple: false };
					}
					rerender();
				},
			},
			...PROPERTY_KINDS.map((kind) => el("option", { value: kind, selected: kind === prop.kind }, kind)),
		);
		const row = el(
			"div",
			{ className: "property" },
			el(
				"div",
				{ className: "row" },
				el("input", {
					placeholder: "Property name",
					ariaLabel: "Property name",
					value: prop.name,
					oninput: (e) => {
						prop.name = (e.target as HTMLInputElement).value;
					},
				}),
				kindSelect,
				el(
					"button",
					{
						type: "button",
						onclick: () => {
							state.draftProps.splice(i, 1);
							rerender();
						},
					},
					"Remove",
				),
			),
		);
		if (prop.kind === "options") {
			row.append(
				el(
					"label",
					{ className: "field" },
					el("span", { className: "muted" }, "Options (one per line)"),
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
					{ className: "row" },
					el(
						"label",
						{},
						"References ",
						el(
							"select",
							{
								onchange: (e) => {
									reference.typeId = (e.target as HTMLSelectElement).value;
								},
							},
							...(store.data.types.length === 0 ? [el("option", { value: "" }, "(no types yet)")] : []),
							...store.data.types.map((t) => el("option", { value: t.id, selected: t.id === reference.typeId }, t.name)),
						),
					),
					el(
						"label",
						{},
						el("input", {
							type: "checkbox",
							checked: reference.multiple,
							onchange: (e) => {
								reference.multiple = (e.target as HTMLInputElement).checked;
							},
						}),
						" Allow multiple",
					),
				),
			);
		}
		return row;
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
						if (changed > 0 && !confirm(`This changes or clears ${changed} existing values. Continue?`)) return;
						store.updateType(editingType.id, state.draftName, props, state.draftContentTemplate);
						state.selectedTypeId = editingType.id;
					} else {
						state.selectedTypeId = store.addType(state.draftName, props, state.draftContentTemplate).id;
					}
					state.editingEntityId = null;
					resetTypeForm();
					rerender();
				},
			},
			el("h3", {}, editingType ? `Edit ${editingType.name}` : "New type"),
			el(
				"label",
				{ className: "field" },
				el("span", {}, "Type name"),
				el("input", {
					value: state.draftName,
					placeholder: "e.g. Book",
					oninput: (e) => {
						state.draftName = (e.target as HTMLInputElement).value;
					},
				}),
			),
			el("h3", {}, "Properties"),
			el(
				"div",
				{ className: "builtin" },
				el("p", {}, el("strong", {}, "id"), " · ULID, automatic"),
				el("p", {}, el("strong", {}, "name"), " · text, required"),
				el("p", {}, el("strong", {}, "content"), " · multiline"),
				el(
					"label",
					{ className: "field wide" },
					el("span", {}, "Default text (template)"),
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
					"Add property",
				),
				el("button", { type: "submit", className: "primary" }, editingType ? "Save" : "Create type"),
				...(editingType
					? [
							el(
								"button",
								{
									type: "button",
									onclick: () => {
										resetTypeForm();
										rerender();
									},
								},
								"Cancel",
							),
						]
					: []),
			),
			...state.typeErrors.map((msg) => el("p", { className: "error" }, msg)),
		);

		const list = el(
			"ul",
			{ className: "type-list" },
			...store.data.types.map((type) =>
				el(
					"li",
					{ className: type.id === state.editingTypeId ? "type-item current" : "type-item" },
					el(
						"div",
						{},
						el("strong", {}, type.name),
						el(
							"p",
							{ className: "muted" },
							type.properties.map((p) => describeProperty(p, store.data.types)).join(", ") || "no properties",
						),
					),
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
							"Edit",
						),
						el(
							"button",
							{
								type: "button",
								onclick: () => {
									const referrers = store.typeReferrers(type.id);
									if (referrers.length > 0) {
										alert(
											`Can't delete ${type.name}: used by ${referrers.join(", ")}. Remove or change those properties first.`,
										);
										return;
									}
									const count = store.data.entities.filter((e) => e.typeId === type.id).length;
									if (confirm(`Delete type "${type.name}" and its ${count} entities?`)) {
										store.deleteType(type.id);
										if (state.editingTypeId === type.id) resetTypeForm();
										rerender();
									}
								},
							},
							"Delete",
						),
					),
				),
			),
		);

		return el(
			"section",
			{},
			el("h2", {}, "Entity types"),
			store.data.types.length > 0 ? list : el("p", { className: "muted" }, "No types yet."),
			form,
		);
	}

	function entitiesSection(): HTMLElement {
		const header = el("div", { className: "section-header" }, el("h2", {}, "Entities"));
		const section = el("section", {}, header);
		const type = store.data.types.find((t) => t.id === state.selectedTypeId);
		if (!type) {
			section.append(el("p", { className: "muted" }, "Create an entity type first."));
			return section;
		}

		const typeSelect = el(
			"select",
			{
				ariaLabel: "Entity type",
				onchange: () => {
					state.selectedTypeId = typeSelect.value;
					state.editingEntityId = null;
					rerender();
				},
			},
			...store.data.types.map((t) => el("option", { value: t.id, selected: t.id === type.id }, t.name)),
		);

		const entities = store.data.entities.filter((e) => e.typeId === type.id);
		const editing = entities.find((e) => e.id === state.editingEntityId);

		header.append(typeSelect);
		section.append(
			entityForm(type, editing),
			entities.length > 0 ? entityTable(type, entities) : el("p", { className: "muted" }, `No ${type.name} entities yet.`),
		);
		return section;
	}

	function entityForm(type: EntityType, editing: Entity | undefined): HTMLFormElement {
		const nameInput = el("input", { required: true, pattern: ".*\\S.*", value: editing?.name ?? "" });
		const contentInput = el("textarea", { rows: 6, value: editing ? editing.content : type.contentTemplate });
		const fields = type.properties.map((prop) => propertyField(prop, editing?.values[prop.id] ?? null));

		return el(
			"form",
			{
				id: "entity-form",
				className: "card",
				onsubmit: (e) => {
					e.preventDefault();
					const name = nameInput.value;
					const values: Record<string, PropertyValue> = {};
					const entityTypes = entityTypeMap(store.data);
					for (const { prop, read } of fields) {
						values[prop.id] = parseValue(prop, read(), entityTypes);
					}
					if (editing) {
						store.updateEntity(editing.id, name, contentInput.value, values);
					} else {
						store.addEntity(type.id, name, contentInput.value, values);
					}
					state.editingEntityId = null;
					rerender();
				},
			},
			el("h3", {}, editing ? `Edit ${type.name}` : `New ${type.name}`),
			...(editing
				? [el("p", { className: "field" }, el("span", {}, "ID"), el("span", { className: "mono" }, editing.id))]
				: []),
			el("label", { className: "field" }, el("span", {}, "Name"), nameInput),
			...fields.map((f) => f.element),
			el("label", { className: "field wide" }, el("span", {}, "Content"), contentInput),
			el(
				"div",
				{ className: "row" },
				el("button", { type: "submit", className: "primary" }, editing ? "Save" : "Create"),
				...(editing
					? [
							el(
								"button",
								{
									type: "button",
									onclick: () => {
										state.editingEntityId = null;
										rerender();
									},
								},
								"Cancel",
							),
						]
					: []),
			),
		);
	}

	/** An input for one property in the entity form, plus a function reading its raw value. */
	function propertyField(
		prop: PropertyDef,
		current: PropertyValue,
	): { prop: PropertyDef; element: HTMLElement; read: () => string | string[] } {
		const label = el("span", {}, prop.name);
		if (prop.kind === "reference") {
			const targetType = store.data.types.find((t) => t.id === prop.reference?.typeId);
			const targets = store.data.entities.filter((e) => e.typeId === targetType?.id);
			const selected = new Set(current === null ? [] : typeof current === "string" ? [current] : current);
			if (targets.length === 0) {
				const note = el("span", { className: "muted" }, `No ${targetType?.name ?? ""} entities yet`);
				return { prop, element: el("div", { className: "field" }, label, note), read: () => [] };
			}
			if (prop.reference?.multiple) {
				const boxes = targets.map((t) => el("input", { type: "checkbox", value: t.id, checked: selected.has(t.id) }));
				const list = el(
					"div",
					{ className: "checklist" },
					...boxes.map((box, i) => el("label", {}, box, ` ${targets[i]!.name}`)),
				);
				return {
					prop,
					element: el("div", { className: "field" }, label, list),
					read: () => boxes.filter((b) => b.checked).map((b) => b.value),
				};
			}
			const select = el(
				"select",
				{},
				el("option", { value: "" }, "—"),
				...targets.map((t) => el("option", { value: t.id, selected: selected.has(t.id) }, t.name)),
			);
			return { prop, element: el("label", { className: "field" }, label, select), read: () => select.value };
		}
		const text = typeof current === "string" ? current : "";
		const input =
			prop.kind === "options"
				? el(
						"select",
						{},
						el("option", { value: "" }, "—"),
						...prop.options.map((o) => el("option", { value: o, selected: o === text }, o)),
					)
				: el("input", { value: text });
		return { prop, element: el("label", { className: "field" }, label, input), read: () => input.value };
	}

	function entityTable(type: EntityType, entities: Entity[]): HTMLElement {
		const names = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const format = (p: PropertyDef, value: PropertyValue | undefined): string => {
			if (value === null || value === undefined) return "—";
			const parts = typeof value === "string" ? [value] : value;
			return p.kind === "reference" ? parts.map((id) => names.get(id) ?? "?").join(", ") : parts.join(", ");
		};

		const table = el(
			"table",
			{},
			el(
				"thead",
				{},
				el(
					"tr",
					{},
					el("th", {}, "ID"),
					el("th", {}, "Name"),
					...type.properties.map((p) => el("th", {}, p.name)),
					el("th", {}),
				),
			),
			el(
				"tbody",
				{},
				...entities.map((entity) =>
					el(
						"tr",
						{},
						el("td", { className: "mono nowrap", title: entity.id }, `…${entity.id.slice(-8)}`),
						el("td", {}, entity.name),
						...type.properties.map((p) => el("td", {}, format(p, entity.values[p.id]))),
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
									"Edit",
								),
								el(
									"button",
									{
										type: "button",
										onclick: () => {
											const refs = store.referencesTo(entity.id);
											const warning = refs > 0 ? ` It's referenced ${refs} times; those references will be removed.` : "";
											if (confirm(`Delete "${entity.name}"?${warning}`)) {
												store.deleteEntity(entity.id);
												if (state.editingEntityId === entity.id) state.editingEntityId = null;
												rerender();
											}
										},
									},
									"Delete",
								),
							),
						),
					),
				),
			),
		);
		return el("div", { className: "table-wrap" }, table);
	}

	rerender();
}
