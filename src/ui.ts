import {
	PROPERTY_KINDS,
	TYPE_COLORS,
	effectiveCardDisplay,
	entityTypeMap,
	inverseReferences,
	inverseRelations,
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
import type { Workspaces } from "./workspaces.js";

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
	/** The open top-bar menu, if any (kept across re-renders, e.g. a language change). */
	openMenu: MenuName | null;
}

type MenuName = "settings" | "workspace";

const PROPERTY_MIME = "application/x-property-index";

/** The page shown, from the URL hash: data editing, board editing (canvas) or read-only boards (viewer). */
type Route = "data" | "canvas" | "viewer";

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
		// No-break spaces keep "→ Target (multiple)" together; a long line wraps after the property name.
		const suffix = p.reference?.multiple ? `\u00a0${text.multipleSuffix}` : "";
		return `${p.name} →\u00a0${target}${suffix}`;
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

export function render(root: HTMLElement, workspaces: Workspaces): void {
	/** The active workspace's data; replaced when switching workspaces. */
	let store: Store = workspaces.openStore(workspaces.active.id);
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
		openMenu: null,
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
		const route: Route = location.hash === "#canvas" ? "canvas" : location.hash === "#viewer" ? "viewer" : "data";
		root.replaceChildren(
			navBar(route),
			route === "data"
				? el("div", { className: "data-view" }, typesSection(), entitiesSection())
				: canvasView(store, { readOnly: route === "viewer" }),
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

	function navBar(route: Route): HTMLElement {
		const tab = (id: Route, label: string) =>
			el("a", { href: `#${id}`, className: route === id ? "tab current" : "tab" }, label);
		const nav = el(
			"nav",
			{ className: "app-nav" },
			tab("data", text.tabData),
			tab("canvas", text.tabCanvas),
			tab("viewer", text.tabViewer),
			el("div", { className: "nav-menus" }, workspaceMenu(), settingsMenu()),
		);
		nav.querySelector(".current")?.setAttribute("aria-current", "page");
		return nav;
	}

	/**
	 * A top-bar button with a panel below it; closes on outside click or Escape. Which menu is open lives in
	 * `state.openMenu`, so only one is open at a time and it survives a re-render (e.g. after a language change).
	 */
	function popover(name: MenuName, button: HTMLButtonElement, panelLabel: string, ...content: Node[]): HTMLElement {
		const panel = el("div", { className: "menu-panel", id: `${name}-menu`, role: "dialog", ariaLabel: panelLabel }, ...content);
		button.type = "button";
		button.classList.add("menu-button");
		button.setAttribute("aria-controls", panel.id);
		button.setAttribute("aria-haspopup", "dialog");
		button.addEventListener("click", () => setOpen(state.openMenu !== name));
		const wrapper = el("div", { className: "menu" }, button, panel);

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
			if (open) state.openMenu = name;
			else if (state.openMenu === name) state.openMenu = null;
			panel.hidden = !open;
			button.ariaExpanded = String(open);
			stopListening();
			if (open) {
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
			}
		}
		setOpen(state.openMenu === name);
		return wrapper;
	}

	/** ⚙ Settings: the UI language. */
	function settingsMenu(): HTMLElement {
		const languageSelect = el(
			"select",
			{
				onchange: () => {
					setLanguage(languageSelect.value as Language);
					rerender(); // the menu stays open, now in the new language
					root.querySelector<HTMLElement>("#settings-menu select")?.focus();
				},
			},
			...LANGUAGES.map(({ code, name }) => el("option", { value: code, lang: code, selected: code === language }, name)),
		);
		return popover(
			"settings",
			el("button", {}, el("span", { ariaHidden: "true" }, "⚙"), text.settings),
			text.settings,
			el("h2", {}, text.settings),
			el("label", { className: "field" }, el("span", {}, text.language), languageSelect),
		);
	}

	/** The current workspace's name; opens the list of workspaces, rename/delete, and the form for a new one. */
	function workspaceMenu(): HTMLElement {
		const current = workspaces.active;
		const isLast = workspaces.list.length <= 1;

		const list = el(
			"ul",
			{ className: "workspace-list" },
			...workspaces.list.map((w) => {
				const option = el(
					"button",
					{ type: "button", className: "workspace-option", onclick: () => switchWorkspace(w.id) },
					w.name,
				);
				if (w.id === current.id) option.setAttribute("aria-current", "true");
				return el("li", {}, option);
			}),
		);

		const nameInput = el("input", {
			ariaLabel: text.name,
			value: text.defaultWorkspaceName(workspaces.list.length + 1),
		});
		const copyTypes = el("input", { type: "checkbox", disabled: store.data.types.length === 0 });
		const newForm = el(
			"form",
			{
				className: "workspace-new",
				onsubmit: (e) => {
					e.preventDefault();
					const added = workspaces.add(nameInput.value, copyTypes.checked ? store.data.types : []);
					switchWorkspace(added.id);
				},
			},
			el("h3", {}, text.newWorkspace),
			nameInput,
			el("label", { className: "checkbox-setting" }, copyTypes, ` ${text.copyTypesFrom(current.name)}`),
			el("button", { type: "submit", className: "primary" }, text.create),
		);

		const button = el(
			"button",
			{ title: text.workspaces, ariaLabel: text.workspaceMenuLabel(current.name) },
			el("span", { ariaHidden: "true" }, "▤"),
			el("span", { className: "workspace-name" }, current.name),
		);
		return popover(
			"workspace",
			button,
			text.workspaces,
			el("h2", {}, text.workspaces),
			list,
			el(
				"div",
				{ className: "row" },
				el(
					"button",
					{
						type: "button",
						title: text.renameWorkspace,
						onclick: () => {
							const name = prompt(text.renameWorkspace, current.name);
							if (name === null) return;
							workspaces.rename(current.id, name);
							rerender();
						},
					},
					text.renameButton,
				),
				el(
					"button",
					{
						type: "button",
						disabled: isLast,
						title: isLast ? text.lastWorkspace : text.deleteWorkspace,
						onclick: () => {
							const { types, entities, boards } = store.data;
							if (!confirm(text.confirmDeleteWorkspace(current.name, types.length, entities.length, boards.length))) return;
							workspaces.remove(current.id);
							switchWorkspace(workspaces.active.id);
						},
					},
					text.delete,
				),
			),
			newForm,
		);
	}

	/** Opens another workspace: its own types, entities and boards, in the same tab. */
	function switchWorkspace(id: string): void {
		workspaces.setActive(id);
		store = workspaces.openStore(workspaces.active.id);
		resetTypeForm();
		state.selectedTypeId = store.data.types[0]?.id ?? null;
		state.editingEntityId = null;
		state.openMenu = null;
		rerender();
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
					// Name and buttons on top; the properties below, one per line, across the full width.
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
			...(editing ? inverseFields(editing) : []),
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

	/** Read-only fields for the reverse side of references (e.g. "responsible for"); edited on the other entities. */
	function inverseFields(entity: Entity): HTMLElement[] {
		const names = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const found = inverseReferences(store.data, entity);
		return inverseRelations(store.data.types, entity.typeId).map((relation) => {
			const ids = found.find((r) => r.prop.id === relation.prop.id)?.entityIds ?? [];
			const sourceType = store.data.types.find((t) => t.id === relation.sourceTypeId)?.name ?? "?";
			return el(
				"div",
				{ className: "field" },
				el("span", {}, relation.label),
				ids.length > 0
					? el("span", {}, ids.map((id) => names.get(id) ?? "?").join(", "))
					: el("span", { className: "muted" }, "—"),
				el("span", { className: "field-hint muted" }, text.setOn(sourceType, relation.prop.name)),
			);
		});
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

		// Read-only columns for the reverse side of references to this type, e.g. "responsible for" on Role.
		const inverseColumns = inverseRelations(store.data.types, type.id);
		const sourceTypeName = (id: string) => store.data.types.find((t) => t.id === id)?.name ?? "?";
		const inverseCell = (entity: Entity, propId: string): string => {
			const ids = inverseReferences(store.data, entity).find((r) => r.prop.id === propId)?.entityIds ?? [];
			return ids.length > 0 ? ids.map((id) => names.get(id) ?? "?").join(", ") : "—";
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
					...inverseColumns.map((c) =>
						el("th", { className: "inverse", title: text.setOn(sourceTypeName(c.sourceTypeId), c.prop.name) }, c.label),
					),
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
						...inverseColumns.map((c) => el("td", { className: "inverse" }, inverseCell(entity, c.prop.id))),
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
