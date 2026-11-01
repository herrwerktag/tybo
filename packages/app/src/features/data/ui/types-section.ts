import { dragHandle, el, icon, reorderable, sharedText } from "../../../shared/ui/index.js";
import {
	TYPE_COLORS,
	changedValueCount,
	entityTypeMap,
	nextTypeColor,
	propertyDefs,
	validateType,
	type DraftProperty,
	type EntityType,
	type PropertyDef,
	type ValidationError,
	type DataStore,
} from "../core.js";
import { text } from "../texts.js";
import type { DataPage, TypeNote } from "./page.js";
import { propertyRow, type PropertyRows } from "./property-row.js";

const TYPE_MIME = "application/x-type-index";

function describeProperty(p: PropertyDef, types: EntityType[]): string {
	if (p.kind === "options") return `${p.name}: ${p.options.map((o) => o.label).join(" / ")}`;
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

/** Whether a property is one the type's errors name (or, unnamed, one an unnamed property's error is about). */
function isFaulty(prop: DraftProperty, errors: readonly ValidationError[]): boolean {
	const label = prop.name.trim();
	return errors.some((e) => (e.code === "propertyNameRequired" ? label === "" : "label" in e && e.code !== "typeNameTaken" && e.label.toLowerCase() === label.toLowerCase()));
}

/**
 * The entity types (#types): their list, to reorder, edit or delete, and the form for a new or changed one with its
 * properties, each folded to a line until unfolded (a new one, or one with an error, unfolds by itself) — and, for a
 * type there is, what the features note about it (`typeNotes`). While the form is open, the list isn't shown. Once a
 * type is saved, `onSaved` gets its id.
 */
export function typesSection(page: DataPage, { onSaved, typeNotes = [] }: { onSaved: (typeId: string) => void; typeNotes?: readonly TypeNote[] }) {
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
		/** The properties unfolded to show their settings. */
		openProps: new Set<DraftProperty>(),
		/** Whether the fields every entity has are unfolded, with the template of the content. */
		builtinOpen: false,
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
		isOpen: (prop) => state.openProps.has(prop) || isFaulty(prop, state.typeErrors),
		setOpen: (prop, open) => {
			if (open) state.openProps.add(prop);
			else state.openProps.delete(prop);
		},
	};

	function resetTypeForm(): void {
		state.editingTypeId = null;
		state.draftName = "";
		state.draftContentTemplate = "";
		state.draftColor = nextTypeColor(store.data.types.map((t) => t.color));
		state.draftProps = [];
		state.typeErrors = [];
		state.creatingType = false;
		state.openProps.clear();
		state.builtinOpen = false;
	}

	/** Opens the form on `type`, with copies of what it is to change. */
	function startEditing(type: EntityType): void {
		resetTypeForm();
		state.editingTypeId = type.id;
		state.draftName = type.name;
		state.draftContentTemplate = type.contentTemplate;
		state.draftColor = type.color;
		state.draftProps = type.properties.map((p) => ({
			...p,
			options: p.options.map((o) => ({ ...o })),
			reference: p.reference && { ...p.reference },
		}));
		page.focusForm("type");
	}

	/** The type the address names, or "new", already acted on: once per address, so the form can be closed. */
	let shownTarget: string | null = null;

	/** The fields every entity has, folded to a line naming them (and the template's first line, if there is one);
	 * unfolded, what each is and the template of the content to edit. */
	function builtinFields(): HTMLElement {
		const open = state.builtinOpen;
		const toggle = el(
			"button",
			{
				type: "button",
				className: "property-toggle",
				title: text.builtinTitle,
				ariaLabel: text.builtinTitle,
				ariaExpanded: String(open),
				onclick: () => {
					state.builtinOpen = !open;
					page.focusHandle("builtin-toggle");
					rerender();
				},
			},
			icon(open ? "chevronUp" : "chevronDown"),
		);
		toggle.dataset.focusKey = "builtin-toggle";
		const template = state.draftContentTemplate.trim().split("\n")[0] ?? "";
		const fields = [sharedText.name, text.description, text.content, text.id].join(" · ");
		const head = el(
			"div",
			{ className: "builtin-head" },
			el("p", { className: "builtin-title" }, text.builtinTitle),
			el("span", { className: "builtin-summary" }, open ? "" : fields, ...(!open && template ? [el("span", { className: "builtin-template" }, `${text.contentTemplate}: ${template}`)] : [])),
			toggle,
		);
		if (!open) return el("div", { className: "builtin" }, head);
		return el(
			"div",
			{ className: "builtin" },
			head,
			el(
				"dl",
				{ className: "builtin-fields" },
				el("dt", {}, sharedText.name),
				el("dd", {}, text.builtinName),
				el("dt", {}, text.description),
				el("dd", {}, text.builtinDescription),
				// The template below belongs to content, so content comes last but the ID.
				el("dt", {}, text.content),
				el("dd", {}, text.builtinContent),
				el("dt", {}, text.id),
				el("dd", {}, text.builtinId),
			),
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
		);
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
						options: p.kind === "options" ? p.options.map((o) => ({ ...o, label: o.label.trim() })).filter((o) => o.label !== "") : [],
					}));
					state.typeErrors = validateType(state.draftName, props, store.data.types, editingType?.id ?? null);
					if (state.typeErrors.length > 0) return rerender();

					if (editingType) {
						const entities = store.data.entities.filter((en) => en.typeId === editingType.id);
						const changed = changedValueCount(entities, editingType.properties, propertyDefs(props), entityTypeMap(store.data));
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
			...(editingType ? typeNotes.flatMap((note) => note(store, editingType)) : []),
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
			builtinFields(),
			...state.draftProps.map((prop, i) => propertyRow(prop, i, propertyRows)),
			// Below the properties, where the new one appears; the form's own buttons follow apart from it.
			el(
				"button",
				{
					type: "button",
					className: "add-property",
					onclick: () => {
						const prop = newDraftProperty();
						state.draftProps.push(prop);
						state.openProps.add(prop);
						page.focusHandle(`property-name:${state.draftProps.length - 1}`);
						rerender();
					},
				},
				`+ ${text.addProperty}`,
			),
			el(
				"div",
				{ className: "row form-actions" },
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
				const count = store.data.entities.filter((e) => e.typeId === type.id).length;
				const item = el(
					"li",
					{ className: type.id === state.editingTypeId ? "type-item current" : "type-item" },
					// Name and buttons on top; the properties below, one per line, across the full width.
					handle,
					el(
						"div",
						{ className: "type-head" },
						el("strong", { className: "type-name" }, type.name),
						el("span", { className: "type-count muted" }, `${count} ${text.historyEntities(count)}`),
					),
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
									startEditing(type);
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
				// A stripe in the type's color down its left edge, like the bar on its cards.
				item.style.setProperty("--type-color", type.color);
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
			...(editingType || state.creatingType ? [form] : store.data.types.length > 0 ? [list] : [el("p", { className: "muted" }, text.noTypesYet)]),
		);
	}

	return {
		/** Another workspace (or the first): nothing of the one before is being edited. */
		reset(current: DataStore): void {
			store = current;
			resetTypeForm();
		},
		/** `target`: a type the address names (its form opens), or "new" (the form for a new one) — the first time. */
		render(current: DataStore, target: string | null = null): HTMLElement {
			store = current;
			if (target !== shownTarget) {
				shownTarget = target;
				const type = store.data.types.find((t) => t.id === target);
				if (type) startEditing(type);
				else if (target === "new") {
					resetTypeForm();
					state.creatingType = true;
					page.focusForm("type");
				}
			}
			return section();
		},
	};
}
