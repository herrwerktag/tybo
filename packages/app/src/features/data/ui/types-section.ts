import { dragHandle, el, reorderable, typeDot, sharedText } from "../../../shared/ui/index.js";
import {
	TYPE_COLORS,
	entityTypeMap,
	migrateValues,
	nextTypeColor,
	validateType,
	type DraftProperty,
	type Entity,
	type EntityType,
	type PropertyDef,
	type ValidationError,
	type DataStore,
} from "../core.js";
import { text } from "../texts.js";
import type { DataPage } from "./page.js";
import { propertyRow, type PropertyRows } from "./property-row.js";

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
	let store!: DataStore;
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

	/** What the properties' cards in the form work with (see `propertyRow`). */
	const propertyRows: PropertyRows = {
		types: () => store.data.types,
		props: () => state.draftProps,
		setProps: (props) => {
			state.draftProps = props;
		},
		rerender,
		focusHandle: (key) => page.focusHandle(key),
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
			...state.draftProps.map((prop, i) => propertyRow(prop, i, propertyRows)),
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
				el("button", { type: "submit", className: "primary" }, editingType ? sharedText.save : text.createType),
				el(
					"button",
					{
						type: "button",
						onclick: () => {
							resetTypeForm();
							rerender();
						},
					},
					sharedText.cancel,
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
							sharedText.delete,
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
		reset(current: DataStore): void {
			store = current;
			resetTypeForm();
		},
		render(current: DataStore): HTMLElement {
			store = current;
			return section();
		},
	};
}
