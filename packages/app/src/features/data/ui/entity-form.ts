import type { Store } from "../../../features.core.js";
import {
	entityTypeMap,
	inverseReferences,
	inverseRelations,
	parseTags,
	parseValue,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyValue,
} from "../core.js";
import { el } from "../../../shared/ui/index.js";
import { detailsBar } from "./entity-card.js";
import { text } from "../texts.js";

/**
 * The form for a new entity (tagged like the filter shows, `filterTag`) or for editing one. Save or Cancel calls
 * `onDone`, with whether something was saved.
 */
export function entityForm(
	store: Store,
	type: EntityType,
	editing: Entity | undefined,
	{ filterTag, onDone }: { filterTag: string | null; onDone: (saved: boolean) => void },
): HTMLFormElement {
	const nameInput = el("input", { required: true, pattern: ".*\\S.*", value: editing?.name ?? "" });
	const tagsInput = el("input", {
		value: (editing ? editing.tags : filterTag ? [filterTag] : []).join(", "),
		placeholder: text.tagsHint,
	});
	const contentInput = el("textarea", { rows: 6, value: editing?.content ?? "" });
	const descriptionInput = el("textarea", { rows: 10, value: editing ? editing.description : type.contentTemplate });
	const fields = type.properties.map((prop) => propertyField(store, prop, editing?.values[prop.id] ?? null));

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
				const tags = parseTags(tagsInput.value);
				if (editing) {
					store.updateEntity(editing.id, name, contentInput.value, values, descriptionInput.value, tags);
				} else {
					store.addEntity(type.id, name, contentInput.value, values, descriptionInput.value, tags);
				}
				onDone(true);
			},
		},
		el("h3", {}, editing ? text.editNamed(type.name) : text.newEntity(type.name)),
		...(editing
			? [el("p", { className: "field" }, el("span", {}, text.id), el("span", { className: "mono" }, editing.id))]
			: []),
		el("label", { className: "field" }, el("span", {}, text.name), nameInput),
		...fields.map((f) => f.element),
		...(editing ? inverseFields(store, editing) : []),
		el("label", { className: "field" }, el("span", {}, text.tags), tagsInput),
		el("label", { className: "field wide" }, el("span", {}, text.content), contentInput),
		el("label", { className: "field wide" }, el("span", {}, text.description), descriptionInput),
		el(
			"div",
			{ className: "row" },
			el("button", { type: "submit", className: "primary" }, editing ? text.save : text.create),
			el(
				"button",
				{
					type: "button",
					onclick: () => onDone(false),
				},
				text.cancel,
			),
		),
	);
}

/**
 * Shows the form for editing `entity` in a details panel, below the bar of its type (× calls `onClose`). If the panel
 * shows it already, it's left as it is, so drawing the panel again keeps what was typed.
 */
export function showEntityEditor(
	panel: HTMLElement,
	store: Store,
	entity: Entity,
	type: EntityType,
	{ onClose, onDone }: { onClose: () => void; onDone: (saved: boolean) => void },
): void {
	if (panel.querySelector<HTMLFormElement>("#entity-form")?.dataset.entityId === entity.id) return;
	const form = entityForm(store, type, entity, { filterTag: null, onDone });
	form.dataset.entityId = entity.id;
	panel.replaceChildren(
		el("header", { className: "details-header" }, detailsBar(type, onClose)),
		el("div", { className: "details-body" }, form),
	);
	form.querySelector("input")?.focus();
}

/** Read-only fields for the reverse side of references (e.g. "responsible for"); edited on the other entities. */
function inverseFields(store: Store, entity: Entity): HTMLElement[] {
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
	store: Store,
	prop: PropertyDef,
	current: PropertyValue,
): { prop: PropertyDef; element: HTMLElement; read: () => string | string[] } {
	const label = el(
		"span",
		{},
		prop.name,
		...(prop.reference?.required ? [el("span", { className: "muted" }, ` ${text.requiredSuffix}`)] : []),
	);
	if (prop.kind === "reference") {
		const targetTypes = store.data.types.filter((t) => prop.reference?.typeIds.includes(t.id));
		const targets = store.data.entities.filter((e) => targetTypes.some((t) => t.id === e.typeId));
		// With several target types, each entity says which one it is.
		const targetName = (e: Entity) =>
			targetTypes.length > 1 ? `${e.name} (${targetTypes.find((t) => t.id === e.typeId)!.name})` : e.name;
		const selected = new Set(current === null ? [] : typeof current === "string" ? [current] : current);
		if (targets.length === 0) {
			const note = el("span", { className: "muted" }, text.noEntitiesOfType(targetTypes.map((t) => t.name).join(" / ")));
			return { prop, element: el("div", { className: "field" }, label, note), read: () => [] };
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
				element: el("div", { className: "field" }, label, box),
				read: () => chosen.map((t) => t.id),
			};
		}
		const select = el(
			"select",
			{},
			el("option", { value: "" }, "—"),
			...targets.map((t) => el("option", { value: t.id, selected: selected.has(t.id) }, targetName(t))),
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
