import type { Store } from "../../../features.core.js";
import { moveItem } from "../../../shared/core/index.js";
import { dragHandle, el, reorderable, typeDot } from "../../../shared/ui/index.js";
import {
	CARD_DISPLAYS,
	LINE_ARROWS,
	PROPERTY_KINDS,
	TYPE_COLORS,
	effectiveCardDisplay,
	entityTypeMap,
	migrateValues,
	newReference,
	nextTypeColor,
	validateType,
	type CardDisplay,
	type DraftProperty,
	type Entity,
	type EntityType,
	type LineArrow,
	type PropertyDef,
	type PropertyKind,
	type ReferenceDef,
	type ValidationError,
} from "../core.js";
import { text } from "../texts.js";
import type { DataPage } from "./page.js";

const PROPERTY_MIME = "application/x-property-index";
const TYPE_MIME = "application/x-type-index";

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
 * The entity types (#types): their list, to reorder, edit or delete, and the form for a new or changed one with its
 * properties. Once a type is saved, `onSaved` gets its id.
 */
export function typesSection(page: DataPage, { onSaved }: { onSaved: (typeId: string) => void }) {
	const rerender = page.rerender;
	/** The store the section shows; set on each drawing. */
	let store!: Store;
	const state = {
		editingTypeId: null as string | null,
		draftName: "",
		draftContentTemplate: "",
		draftColor: "",
		draftProps: [] as DraftProperty[],
		typeErrors: [] as ValidationError[],
		/** Whether the form for a new type is open; it stays hidden until asked for. */
		creatingType: false,
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
				page.focusHandle(`property:${to}`);
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

	function section(): HTMLElement {
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
					state.typeErrors = validateType(state.draftName, props, store.data.types, editingType?.id ?? null);
					if (state.typeErrors.length > 0) return rerender();

					if (editingType) {
						const entities = store.data.entities.filter((en) => en.typeId === editingType.id);
						const changed = countChangedValues(entities, props, entityTypeMap(store.data));
						if (changed > 0 && !confirm(text.confirmChangedValues(changed))) return;
						store.updateType(editingType.id, state.draftName, props, state.draftContentTemplate, state.draftColor);
						onSaved(editingType.id);
					} else {
						onSaved(store.addType(state.draftName, props, state.draftContentTemplate, state.draftColor).id);
					}
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
									page.focusForm("type");
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
						page.focusHandle(`type:${moved}`);
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
					page.focusForm("type");
					rerender();
				},
			},
			text.createNewType,
		);

		return el(
			"section",
			{},
			el("div", { className: "section-header" }, page.dataSwitch("types"), ...(editingType || state.creatingType ? [] : [createButton])),
			...(editingType || state.creatingType ? [form] : []),
			store.data.types.length > 0 ? list : el("p", { className: "muted" }, text.noTypesYet),
		);
	}

	return {
		/** Another workspace (or the first): nothing of the one before is being edited. */
		reset(current: Store): void {
			store = current;
			resetTypeForm();
		},
		render(current: Store): HTMLElement {
			store = current;
			return section();
		},
	};
}
