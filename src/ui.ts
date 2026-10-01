import {
	PROPERTY_KINDS,
	TYPE_COLORS,
	effectiveCardDisplay,
	entityTypeMap,
	migrateValues,
	moveItem,
	newReference,
	nextTypeColor,
	parseValue,
	validateType,
	type CardDisplay,
	type DraftProperty,
	type LineArrow,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyKind,
	type PropertyValue,
	type ValidationError,
} from "./model.js";
import { canvasView } from "./canvas.js";
import { el, typeDot } from "./dom.js";
import { LANGUAGES, language, setLanguage, text, type Language } from "./i18n.js";
import type { Store } from "./store.js";

interface UiState {
	editingTypeId: string | null;
	draftName: string;
	draftContentTemplate: string;
	draftColor: string;
	draftProps: DraftProperty[];
	typeErrors: ValidationError[];
	selectedTypeId: string | null;
	editingEntityId: string | null;
	/** Form to scroll into view and focus after the next render (set when Edit is clicked). */
	focusForm: "type" | "entity" | null;
	/** Drag handle to focus after the next render, so keyboard reordering keeps focus on the moved property. */
	focusHandle: number | null;
	/** Whether the settings menu is open (kept across the re-render a language change causes). */
	settingsOpen: boolean;
}

const PROPERTY_MIME = "application/x-property-index";

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
		return `${p.name} → ${target}${p.reference?.multiple ? text.multipleSuffix : ""}`;
	}
	return `${p.name}: ${text.kinds.text}`;
}

const LINE_ARROWS: readonly LineArrow[] = ["to", "from", "none"];
const CARD_DISPLAY_ORDER: readonly CardDisplay[] = ["list", "line", "hidden"];

/** A small label above a control, for the settings inside a property card. */
function setting(label: string, control: HTMLElement): HTMLElement {
	return el("label", { className: "field" }, el("span", { className: "setting-label" }, label), control);
}

function newDraftProperty(): DraftProperty {
	return { name: "", kind: "text", options: [], reference: null, cardDisplay: "list" };
}

export function render(root: HTMLElement, store: Store): void {
	const state: UiState = {
		editingTypeId: null,
		draftName: "",
		draftContentTemplate: "",
		draftColor: nextTypeColor(store.data.types.map((t) => t.color)),
		draftProps: [],
		typeErrors: [],
		selectedTypeId: store.data.types[0]?.id ?? null,
		editingEntityId: null,
		focusForm: null,
		focusHandle: null,
		settingsOpen: false,
	};

	function resetTypeForm(): void {
		state.editingTypeId = null;
		state.draftName = "";
		state.draftContentTemplate = "";
		state.draftColor = nextTypeColor(store.data.types.map((t) => t.color));
		state.draftProps = [];
		state.typeErrors = [];
	}

	function rerender(): void {
		if (!store.data.types.some((t) => t.id === state.selectedTypeId)) {
			state.selectedTypeId = store.data.types[0]?.id ?? null;
			state.editingEntityId = null;
		}
		const view = location.hash === "#canvas" ? "canvas" : "data";
		root.replaceChildren(
			navBar(view),
			view === "canvas"
				? canvasView(store)
				: el("div", { className: "data-view" }, typesSection(), entitiesSection()),
		);
		if (state.focusHandle !== null) {
			root.querySelectorAll<HTMLElement>(".drag-handle")[state.focusHandle]?.focus();
			state.focusHandle = null;
		}
		if (state.focusForm) {
			const form = root.querySelector<HTMLFormElement>(`#${state.focusForm}-form`);
			state.focusForm = null;
			form?.scrollIntoView({ block: "nearest", behavior: "smooth" });
			form?.querySelector<HTMLElement>("input, select, textarea")?.focus({ preventScroll: true });
		}
	}

	function navBar(view: "data" | "canvas"): HTMLElement {
		const tab = (id: typeof view, label: string) =>
			el("a", { href: `#${id}`, className: view === id ? "tab current" : "tab" }, label);
		const nav = el(
			"nav",
			{ className: "app-nav" },
			tab("data", text.tabData),
			tab("canvas", text.tabCanvas),
			settingsMenu(),
		);
		nav.querySelector(".current")?.setAttribute("aria-current", "page");
		return nav;
	}

	/** ⚙ button at the right of the top bar, opening a small menu; closes on outside click or Escape. */
	function settingsMenu(): HTMLElement {
		const languageSelect = el(
			"select",
			{
				onchange: () => {
					setLanguage(languageSelect.value as Language);
					state.settingsOpen = true; // keep the menu open in the new language
					rerender();
					root.querySelector<HTMLElement>(".settings-menu select")?.focus();
				},
			},
			...LANGUAGES.map(({ code, name }) => el("option", { value: code, lang: code, selected: code === language }, name)),
		);
		const menu = el(
			"div",
			{ className: "settings-menu", id: "settings-menu", role: "dialog", ariaLabel: text.settings },
			el("h2", {}, text.settings),
			el("label", { className: "field" }, el("span", {}, text.language), languageSelect),
		);
		const button = el(
			"button",
			{ type: "button", className: "settings-button", onclick: () => setOpen(!state.settingsOpen) },
			el("span", { ariaHidden: "true" }, "⚙"),
			text.settings,
		);
		button.setAttribute("aria-controls", menu.id);
		button.setAttribute("aria-haspopup", "dialog");
		const wrapper = el("div", { className: "settings" }, button, menu);

		const stopListening = () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
		function onPointerDown(e: PointerEvent): void {
			if (!wrapper.isConnected) return stopListening(); // replaced by a re-render
			if (!wrapper.contains(e.target as Node)) setOpen(false);
		}
		function onKeyDown(e: KeyboardEvent): void {
			if (!wrapper.isConnected) return stopListening();
			if (e.key === "Escape") {
				setOpen(false);
				button.focus();
			}
		}
		function setOpen(open: boolean): void {
			state.settingsOpen = open;
			menu.hidden = !open;
			button.ariaExpanded = String(open);
			stopListening();
			if (open) {
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
			}
		}
		setOpen(state.settingsOpen);
		return wrapper;
	}

	function propertyRow(prop: DraftProperty, i: number): HTMLElement {
		const kindSelect = el(
			"select",
			{
				onchange: () => {
					prop.kind = kindSelect.value as PropertyKind;
					prop.cardDisplay = effectiveCardDisplay(prop);
					if (prop.kind === "reference" && !prop.reference) {
						prop.reference = newReference(store.data.types[0]?.id ?? "");
					}
					rerender();
				},
			},
			...PROPERTY_KINDS.map((kind) => el("option", { value: kind, selected: kind === prop.kind }, text.kinds[kind])),
		);
		const moveTo = (to: number) => {
			if (to < 0 || to >= state.draftProps.length || to === i) return;
			state.draftProps = moveItem(state.draftProps, i, to);
			state.focusHandle = to;
			rerender();
		};
		const handle = el(
			"button",
			{
				type: "button",
				className: "drag-handle",
				title: text.dragToReorder,
				ariaLabel: text.moveProperty(prop.name.trim() || String(i + 1)),
				onkeydown: (e) => {
					if (e.key === "ArrowUp" || e.key === "ArrowDown") {
						e.preventDefault();
						moveTo(e.key === "ArrowUp" ? i - 1 : i + 1);
					}
				},
				// Only the handle makes the card draggable, so text in its inputs stays selectable.
				onpointerdown: () => {
					row.draggable = true;
				},
				// A click without a drag: stop the card being draggable again (a real drag ends in dragend).
				onpointerup: () => {
					row.draggable = false;
				},
			},
			"⠿",
		);
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
			...CARD_DISPLAY_ORDER.filter((display) => display !== "line" || prop.kind === "reference").map((display) =>
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
		const clearDropMarker = () => row.classList.remove("drop-before", "drop-after");
		const dropsBefore = (e: DragEvent) => {
			const rect = row.getBoundingClientRect();
			return e.clientY < rect.top + rect.height / 2;
		};
		row.addEventListener("dragstart", (e) => {
			e.dataTransfer?.setData(PROPERTY_MIME, String(i));
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
			row.classList.add("dragging");
		});
		row.addEventListener("dragend", () => {
			row.draggable = false;
			row.classList.remove("dragging");
		});
		row.addEventListener("dragover", (e) => {
			if (!e.dataTransfer?.types.includes(PROPERTY_MIME)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			const before = dropsBefore(e);
			row.classList.toggle("drop-before", before);
			row.classList.toggle("drop-after", !before);
		});
		row.addEventListener("dragleave", clearDropMarker);
		row.addEventListener("drop", (e) => {
			const from = Number(e.dataTransfer?.getData(PROPERTY_MIME));
			clearDropMarker();
			if (!Number.isInteger(from)) return;
			e.preventDefault();
			// Index among the other properties, once the dragged one is taken out.
			const target = dropsBefore(e) ? i : i + 1;
			state.draftProps = moveItem(state.draftProps, from, from < target ? target - 1 : target);
			rerender();
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
					setting(
						text.references,
						el(
							"select",
							{
								onchange: (e) => {
									reference.typeId = (e.target as HTMLSelectElement).value;
								},
							},
							...(store.data.types.length === 0 ? [el("option", { value: "" }, text.noTypesOption)] : []),
							...store.data.types.map((t) => el("option", { value: t.id, selected: t.id === reference.typeId }, t.name)),
						),
					),
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
								text.cancel,
							),
						]
					: []),
			),
			...state.typeErrors.map((error) => el("p", { className: "error" }, text.validation(error))),
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
						el("strong", {}, typeDot(type.color), type.name),
						el(
							"p",
							{ className: "muted" },
							type.properties.map((p) => describeProperty(p, store.data.types)).join(", ") || text.noProperties,
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
				),
			),
		);

		return el(
			"section",
			{},
			el("h2", {}, text.entityTypes),
			store.data.types.length > 0 ? list : el("p", { className: "muted" }, text.noTypesYet),
			form,
		);
	}

	function entitiesSection(): HTMLElement {
		const header = el("div", { className: "section-header" }, el("h2", {}, text.entities));
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
			entities.length > 0 ? entityTable(type, entities) : el("p", { className: "muted" }, text.noEntitiesOfType(type.name)),
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
			el("h3", {}, editing ? text.editNamed(type.name) : text.newEntity(type.name)),
			...(editing
				? [el("p", { className: "field" }, el("span", {}, text.id), el("span", { className: "mono" }, editing.id))]
				: []),
			el("label", { className: "field" }, el("span", {}, text.name), nameInput),
			...fields.map((f) => f.element),
			el("label", { className: "field wide" }, el("span", {}, text.content), contentInput),
			el(
				"div",
				{ className: "row" },
				el("button", { type: "submit", className: "primary" }, editing ? text.save : text.create),
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
								text.cancel,
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
				const note = el("span", { className: "muted" }, text.noEntitiesOfType(targetType?.name ?? ""));
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
		const currentText = typeof current === "string" ? current : "";
		const input =
			prop.kind === "options"
				? el(
						"select",
						{},
						el("option", { value: "" }, "—"),
						...prop.options.map((o) => el("option", { value: o, selected: o === currentText }, o)),
					)
				: el("input", { value: currentText });
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
					el("th", {}, text.id),
					el("th", {}, text.name),
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
					),
				),
			),
		);
		return el("div", { className: "table-wrap" }, table);
	}

	window.addEventListener("hashchange", rerender);
	rerender();
}
