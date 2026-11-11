import { moveItem } from "../../../shared/core/index.js";
import { dragHandle, el, icon, reorderable, setting } from "../../../shared/ui/index.js";
import {
	CARD_DISPLAYS,
	LINE_ARROWS,
	PROPERTY_KINDS,
	effectiveCardDisplay,
	newReference,
	type CardDisplay,
	type DraftProperty,
	type EntityType,
	type LineArrow,
	type PropertyKind,
	type ReferenceDef,
} from "../core.js";
import { text } from "../texts.js";

const PROPERTY_MIME = "application/x-property-index";
const OPTION_MIME = "application/x-option-index";

/** What a property's card in the type form works with (see `propertyRow`). */
export interface PropertyRows {
	/** The types a reference can point to. */
	types: () => readonly EntityType[];
	/** The properties of the type being edited, in their order. */
	props: () => DraftProperty[];
	setProps: (props: DraftProperty[]) => void;
	/** Draws the form anew, e.g. after a setting that shows or hides others. */
	rerender: () => void;
	/** Whether the property's settings are unfolded below its line. */
	isOpen: (prop: DraftProperty) => boolean;
	setOpen: (prop: DraftProperty, open: boolean) => void;
	/** Focuses a drag handle by its key once the form is drawn anew (see `dragHandle`). */
	focusHandle: (key: string) => void;
}

/** The target types of a reference as tags in their colors (× removes one), and a select adding another. */
function referenceTypesSetting(reference: ReferenceDef, rows: PropertyRows): HTMLElement {
	const chosen = reference.typeIds.flatMap((id) => rows.types().filter((t) => t.id === id));
	const rest = rows.types().filter((t) => !reference.typeIds.includes(t.id));
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
						rows.rerender();
					},
				},
				"×",
			),
		);
		tag.style.background = t.color;
		return tag;
	});
	const add =
		rows.types().length === 0
			? el("span", { className: "muted" }, text.noTypesOption)
			: rest.length > 0
				? el(
						"select",
						{
							ariaLabel: text.addReferenceType,
							onchange: (e) => {
								reference.typeIds = [...reference.typeIds, (e.target as HTMLSelectElement).value];
								rows.rerender();
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

/** What a property is, in short, for its folded line: its kind, a reference's target types as tags in their colors, an
 * options property's number of values. */
function propertySummary(prop: DraftProperty, rows: PropertyRows): HTMLElement {
	const summary = el("span", { className: "property-summary" }, el("span", { className: "muted" }, text.kinds[prop.kind]));
	if (prop.kind === "options") summary.append(el("span", { className: "muted" }, text.optionCount(prop.options.length)));
	if (prop.kind === "reference") {
		for (const t of (prop.reference?.typeIds ?? []).flatMap((id) => rows.types().filter((type) => type.id === id))) {
			const tag = el("span", { className: "ref-tag" }, t.name);
			tag.style.background = t.color;
			summary.append(tag);
		}
	}
	return summary;
}

/** A property of the type form as a line: its name, what it is in short, a button unfolding its settings (its kind,
 * how cards show it, options and references with their own), to drag into another place or remove. */
export function propertyRow(prop: DraftProperty, i: number, rows: PropertyRows): HTMLElement {
	const kindSelect = el(
		"select",
		{
			onchange: () => {
				prop.kind = kindSelect.value as PropertyKind;
				prop.cardDisplay = effectiveCardDisplay(prop);
				if (prop.kind === "reference" && !prop.reference) {
					prop.reference = newReference([]);
				}
				rows.rerender();
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
	nameInput.dataset.focusKey = `property-name:${i}`;
	const open = rows.isOpen(prop);
	const label = prop.name.trim() || String(i + 1);
	const toggle = el(
		"button",
		{
			type: "button",
			className: "property-toggle",
			title: text.showPropertySettings(label),
			ariaLabel: text.showPropertySettings(label),
			ariaExpanded: String(open),
			onclick: () => {
				rows.setOpen(prop, !open);
				rows.focusHandle(`property-toggle:${i}`);
				rows.rerender();
			},
		},
		icon(open ? "chevronUp" : "chevronDown"),
	);
	toggle.dataset.focusKey = `property-toggle:${i}`;
	const removeButton = el(
		"button",
		{
			type: "button",
			className: "property-remove",
			title: text.removeProperty,
			ariaLabel: text.removePropertyNamed(prop.name.trim() || String(i + 1)),
			onclick: () => {
				rows.props().splice(i, 1);
				rows.rerender();
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
				rows.rerender(); // shows or hides the line settings
			},
		},
		...CARD_DISPLAYS.filter((display) => display !== "line" || prop.kind === "reference").map((display) =>
			el("option", { value: display, selected: display === prop.cardDisplay }, text.cardDisplays[display]),
		),
	);
	// One line: handle, name, what it is in short, unfold and remove. Unfolded, its settings below, two per row.
	const row = el(
		"div",
		{ className: open ? "property open" : "property" },
		el("div", { className: "property-head" }, handle, nameInput, propertySummary(prop, rows), toggle, removeButton),
	);
	reorderable(row, handle, {
		index: i,
		count: rows.props().length,
		mime: PROPERTY_MIME,
		move: (from, to) => {
			rows.setProps(moveItem(rows.props(), from, to));
			rows.focusHandle(`property:${to}`);
			rows.rerender();
		},
	});
	if (!open) return row;
	const descriptionInput = el("input", {
		value: prop.description ?? "",
		placeholder: text.propertyDescriptionHint,
		oninput: (e) => {
			prop.description = (e.target as HTMLInputElement).value;
		},
	});
	row.append(
		el("div", { className: "property-settings" }, setting(text.settingType, kindSelect), setting(text.settingOnCard, displaySelect)),
		setting(text.propertyDescription, descriptionInput),
	);
	if (prop.kind === "options") {
		// One row per option: its label, draggable to another place, removable. Each keeps the id it has.
		const items = prop.options.map((option, o) => {
			const label = () => option.label.trim() || String(o + 1);
			const handle = dragHandle(text.moveOption(label()), `option:${i}:${o}`);
			const item = el(
				"div",
				{ className: "option-row" },
				handle,
				el("input", {
					ariaLabel: text.optionName,
					value: option.label,
					oninput: (e) => {
						option.label = (e.target as HTMLInputElement).value;
					},
				}),
				el(
					"button",
					{
						type: "button",
						className: "property-remove",
						title: text.removeOption(label()),
						ariaLabel: text.removeOption(label()),
						onclick: () => {
							prop.options.splice(o, 1);
							rows.rerender();
						},
					},
					"✕",
				),
			);
			reorderable(item, handle, {
				index: o,
				count: prop.options.length,
				mime: OPTION_MIME,
				move: (from, to) => {
					prop.options = moveItem(prop.options, from, to);
					rows.focusHandle(`option:${i}:${to}`);
					rows.rerender();
				},
			});
			return item;
		});
		row.append(
			setting(
				text.options,
				el(
					"div",
					{ className: "option-list" },
					...items,
					el(
						"button",
						{
							type: "button",
							onclick: () => {
								prop.options.push({ label: "" });
								rows.rerender();
							},
						},
						text.addOption,
					),
				),
			),
		);
	}
	if (prop.kind === "reference" && prop.reference) {
		const reference = prop.reference;
		row.append(
			el(
				"div",
				{ className: "property-settings" },
				referenceTypesSetting(reference, rows),
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
