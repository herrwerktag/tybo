import {
	entityTypeMap,
	parseTags,
	parseValue,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyValue,
	type DataStore,
} from "../core.js";
import { el, sharedText } from "../../../shared/ui/index.js";
import { text } from "../texts.js";
import { propertyHint, typeHelp } from "./type-help.js";

/**
 * The form for a new entity (tagged like the filter shows, `filterTag`); one there is is changed field by field (see
 * `fieldEditing`). Create or Cancel calls `onDone`, with whether something was saved.
 */
export function entityForm(
	store: DataStore,
	type: EntityType,
	{ filterTag, onDone }: { filterTag: string | null; onDone: (saved: boolean) => void },
): HTMLFormElement {
	const nameInput = el("input", { required: true, pattern: ".*\\S.*", value: "" });
	const tagsInput = el("input", { value: filterTag ?? "", placeholder: text.tagsHint });
	const contentInput = el("textarea", { rows: 6, value: "" });
	const descriptionInput = el("textarea", { rows: 10, value: type.contentTemplate });
	const fields = type.properties.map((prop) => propertyField(store, prop, null));

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
				store.addEntity(type.id, name, contentInput.value, values, descriptionInput.value, parseTags(tagsInput.value));
				onDone(true);
			},
		},
		el("h3", {}, text.newEntity(type.name)),
		...typeHelp(type),
		el("label", { className: "field" }, el("span", {}, sharedText.name), nameInput),
		...fields.map((f) => f.element),
		el("label", { className: "field" }, el("span", {}, text.tags), tagsInput),
		el("label", { className: "field wide" }, el("span", {}, text.content), contentInput),
		el("label", { className: "field wide" }, el("span", {}, text.description), descriptionInput),
		el(
			"div",
			{ className: "row form-actions" },
			el("button", { type: "submit", className: "primary" }, sharedText.create),
			el(
				"button",
				{
					type: "button",
					onclick: () => onDone(false),
				},
				sharedText.cancel,
			),
		),
	);
}

/** An input for one property in the entity form, with the property's note below it, plus a function reading its raw value; `onChange` hears of each
 * change of a multiple reference's tags (a select's own change event bubbles). */
export function propertyField(
	store: DataStore,
	prop: PropertyDef,
	current: PropertyValue,
	onChange: () => void = () => {},
): { prop: PropertyDef; element: HTMLElement; read: () => string | string[] } {
	const label = el(
		"span",
		{},
		prop.name,
		...(prop.reference?.required ? [el("span", { className: "muted" }, ` ${text.requiredSuffix}`)] : []),
	);
	const hint = propertyHint(prop);
	if (prop.kind === "reference") {
		const targetTypes = store.data.types.filter((t) => prop.reference?.typeIds.includes(t.id));
		const targets = store.data.entities.filter((e) => targetTypes.some((t) => t.id === e.typeId));
		// With several target types, each entity says which one it is.
		const targetName = (e: Entity) =>
			targetTypes.length > 1 ? `${e.name} (${targetTypes.find((t) => t.id === e.typeId)!.name})` : e.name;
		const selected = new Set(current === null ? [] : typeof current === "string" ? [current] : current);
		if (targets.length === 0) {
			const note = el("span", { className: "muted" }, text.noEntitiesOfType(targetTypes.map((t) => t.name).join(" / ")));
			return { prop, element: el("div", { className: "field" }, label, note, ...hint), read: () => [] };
		}
		if (prop.reference?.multiple) {
			// Like the target types in the type form: tags in their type's color (× removes one), and a select
			// adding another. Only this field is redrawn, so the rest of the form keeps what was typed.
			let chosen = targets.filter((t) => selected.has(t.id));
			const box = el("div", { className: "reference-values" });
			const draw = () => {
				const tags = chosen.map((t) => {
					const tag = el(
						"span",
						{ className: "ref-tag reference-type" },
						targetName(t),
						el(
							"button",
							{
								type: "button",
								className: "reference-type-remove",
								title: text.removeReference(t.name),
								ariaLabel: text.removeReference(t.name),
								onclick: () => {
									chosen = chosen.filter((c) => c !== t);
									draw();
									onChange();
								},
							},
							"×",
						),
					);
					tag.style.background = store.data.types.find((type) => type.id === t.typeId)?.color ?? "";
					return tag;
				});
				const rest = targets.filter((t) => !chosen.includes(t));
				const add =
					rest.length > 0
						? el(
								"select",
								{
									ariaLabel: text.addReference,
									onchange: (e) => {
										const id = (e.target as HTMLSelectElement).value;
										chosen = [...chosen, rest.find((t) => t.id === id)!];
										draw();
										e.stopPropagation(); // told by onChange, not as the select's own change
										onChange();
									},
								},
								el("option", { value: "", selected: true, disabled: true }, text.addReference),
								...rest.map((t) => el("option", { value: t.id }, targetName(t))),
							)
						: null;
				box.replaceChildren(
					...(tags.length > 0 ? [el("div", { className: "prop-chips" }, ...tags)] : []),
					...(add ? [add] : []),
				);
			};
			draw();
			return {
				prop,
				element: el("div", { className: "field" }, label, box, ...hint),
				read: () => chosen.map((t) => t.id),
			};
		}
		const select = el(
			"select",
			{},
			el("option", { value: "" }, "—"),
			...targets.map((t) => el("option", { value: t.id, selected: selected.has(t.id) }, targetName(t))),
		);
		return { prop, element: el("label", { className: "field" }, label, select, ...hint), read: () => select.value };
	}
	const currentText = typeof current === "string" ? current : "";
	const input =
		prop.kind === "options"
			? el(
					"select",
					{},
					el("option", { value: "" }, "—"),
					...prop.options.map((o) => el("option", { value: o.id, selected: o.id === currentText }, o.label)),
				)
			: el("input", { value: currentText });
	return { prop, element: el("label", { className: "field" }, label, input, ...hint), read: () => input.value };
}
