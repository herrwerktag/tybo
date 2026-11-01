import { freeName, moveItem, ulid } from "../../shared/core/index.js";
import { el, isRecord, refused, sharedText, type UnitDescriber } from "../../shared/ui/index.js";
import type { DataStore, EntityType } from "../data/core.js";
import { text as dataText } from "../data/texts.js";
import {
	bearingTypes,
	bindingChoices,
	conditionHints,
	deleteTrait,
	fittingBinding,
	resolveCondition,
	sameSource,
	updateTrait,
	validateTrait,
	withBinding,
	withRoles,
	withType,
	type Condition,
	type FittingBinding,
	type RoleDef,
	type RoleKind,
	type Trait,
	type TraitError,
} from "./core.js";
import { text } from "./texts.js";

const KINDS: readonly RoleKind[] = ["text", "options", "reference"];

/** A trait's problem in the form's words. */
function problem(error: TraitError): string {
	switch (error.code) {
		case "traitNameRequired":
			return text.traitNameRequired;
		case "traitNameTaken":
			return text.traitNameTaken(error.label);
		case "roleNameRequired":
			return text.roleNameRequired;
		case "duplicateRole":
			return text.duplicateRole(error.label);
		case "optionsRequired":
			return text.valuesRequired(error.label);
		case "emptyOption":
			return text.emptyValue;
		case "duplicateOptions":
			return text.duplicateValue(error.label);
		case "conditionCycle":
			return text.conditionCycle(error.label);
	}
}

/** How a field playing a role reads in the form: a built-in field, a property, or another type's reference. */
function fieldLabel(types: readonly EntityType[], fits: FittingBinding): string {
	if ("field" in fits) return fits.field === "name" ? sharedText.name : fits.field === "content" ? dataText.content : dataText.description;
	if (fits.direction === "forward") return fits.prop.name;
	return fits.prop.reference?.inverseLabel || text.inverseField(types.find((t) => t.id === fits.ownerTypeId)?.name ?? "?", fits.prop.name);
}

/** A control's key for keeping focus on it when the page is drawn anew. */
function keyed<T extends HTMLElement>(element: T, key: string): T {
	element.dataset.focusKey = key;
	return element;
}

/**
 * A trait's form: its name, its roles (each a name and a kind, an options role with its values, a reference role with
 * its condition) and, per type bearing it, what plays each role there. Every change is saved as it is made, as in an analysis's setup; one the trait
 * couldn't be saved with is refused at its field.
 */
export function traitForm(store: DataStore, trait: Trait): HTMLElement {
	const types = store.data.types;
	/** Saves the trait with these roles, or refuses them at `input` saying why. */
	const saveRoles = (roles: RoleDef[], input?: HTMLInputElement | HTMLSelectElement) => {
		const errors = validateTrait(trait.name, roles, store.data.traits, trait.id);
		if (errors.length > 0 && (!input || refused(input, problem(errors[0]!)))) return;
		const changed = withRoles(trait, roles);
		updateTrait(store, trait.id, { roles: changed.roles, bindings: changed.bindings });
	};
	const setRole = (index: number, role: RoleDef, input?: HTMLInputElement | HTMLSelectElement) => saveRoles(trait.roles.map((r, i) => (i === index ? role : r)), input);

	const name = keyed(
		el("input", {
			value: trait.name,
			ariaLabel: sharedText.name,
			onchange: () => {
				const error = validateTrait(name.value, [], store.data.traits, trait.id)[0];
				if (!refused(name, error ? problem(error) : null)) updateTrait(store, trait.id, { name: name.value });
			},
		}),
		"trait-name",
	);
	const remove = el(
		"button",
		{
			type: "button",
			onclick: () => {
				if (confirm(text.confirmDeleteTrait(trait.name))) deleteTrait(store, trait.id);
			},
		},
		text.deleteTrait,
	);

	const iconButton = (label: string, symbol: string, key: string, onclick: () => void, disabled = false) =>
		keyed(el("button", { type: "button", className: "icon-button", title: label, ariaLabel: label, disabled, onclick }, symbol), key);

	const roleRow = (role: RoleDef, index: number) => {
		const roleName = keyed(
			el("input", { value: role.name, ariaLabel: sharedText.name, onchange: () => setRole(index, { ...role, name: roleName.value }, roleName) }),
			`role:${role.id}:name`,
		);
		const kind = keyed(
			el(
				"select",
				{
					ariaLabel: text.roleKind,
					onchange: () => {
						const next = kind.value as RoleKind;
						setRole(index, { ...role, kind: next, options: next === "options" ? [{ id: ulid(), label: text.defaultValueName(1) }] : [] });
					},
				},
				...KINDS.map((k) => el("option", { value: k, selected: k === role.kind }, dataText.kinds[k])),
			),
			`role:${role.id}:kind`,
		);
		// An options role's values on a line of their own, below its name and the buttons.
		const valuesLine = () => {
			const line = el(
				"div",
				{ className: "path-editor" },
				el("span", { className: "muted" }, `${text.roleValues}:`),
				...role.options.map((option, i) => {
					const input = keyed(
						el("input", {
							value: option.label,
							ariaLabel: text.roleValues,
							onchange: () =>
								setRole(index, { ...role, options: role.options.map((o, j) => (j === i ? { ...o, label: input.value } : o)) }, input),
						}),
						`role:${role.id}:value:${option.id}`,
					);
					return el(
						"span",
						{},
						input,
						iconButton(
							text.removeValue,
							"✕",
							`role:${role.id}:value:${option.id}:remove`,
							() => setRole(index, { ...role, options: role.options.filter((o) => o.id !== option.id) }),
							role.options.length === 1,
						),
					);
				}),
				keyed(
					el(
						"button",
						{
							type: "button",
							onclick: () =>
								setRole(index, {
									...role,
									options: [...role.options, { id: ulid(), label: freeName(role.options.map((o) => ({ id: o.id, name: o.label })), text.defaultValueName) }],
								}),
						},
						`+ ${text.addValue}`,
					),
					`role:${role.id}:add-value`,
				),
			);
			line.style.flexBasis = "100%";
			return line;
		};
		// A reference role's condition on a line of its own: the role asked about, then the values or whether it has targets.
		const conditionLine = () => {
			const condition = role.condition;
			const asked = condition ? resolveCondition(store.data.traits, condition) : null;
			const missing = condition !== undefined && asked === null;
			const setCondition = (next: Condition | undefined, input?: HTMLInputElement | HTMLSelectElement) => {
				const { condition: _, ...without } = role;
				setRole(index, next ? { ...without, condition: next } : without, input);
			};
			const askable = store.data.traits.flatMap((t) => t.roles.filter((r) => r.kind !== "text").map((r) => ({ trait: t, role: r })));
			const which = keyed(
				el(
					"select",
					{
						ariaLabel: text.condition,
						className: missing ? "invalid" : "",
						onchange: () => {
							const chosen = askable.find(({ trait: t, role: r }) => `${t.id}:${r.id}` === which.value);
							if (!chosen) return setCondition(undefined);
							const base = { traitId: chosen.trait.id, roleId: chosen.role.id };
							setCondition(chosen.role.kind === "options" ? { ...base, values: chosen.role.options.slice(0, 1).map((o) => o.id) } : { ...base, hasTargets: true }, which);
						},
					},
					...(missing ? [el("option", { value: "missing", selected: true }, text.notThere)] : []),
					el("option", { value: "", selected: condition === undefined }, text.noCondition),
					...askable.map(({ trait: t, role: r }) =>
						el("option", { value: `${t.id}:${r.id}`, selected: !missing && condition?.traitId === t.id && condition.roleId === r.id }, `${t.name} › ${r.name}`),
					),
				),
				`role:${role.id}:condition`,
			);
			const details: HTMLElement[] = [];
			if (asked && condition && "values" in condition) {
				details.push(el("span", { className: "muted" }, text.conditionValues(asked.role.name)));
				for (const option of asked.role.options) {
					const held = asked.values.includes(option.id);
					const box = keyed(
						el("input", {
							type: "checkbox",
							checked: held,
							// The last value stays: a condition without values would let nothing through.
							disabled: held && asked.values.length === 1,
							onchange: () => setCondition({ ...condition, values: box.checked ? [...asked.values, option.id] : asked.values.filter((v) => v !== option.id) }),
						}),
						`role:${role.id}:condition:${option.id}`,
					);
					details.push(el("label", {}, box, ` ${option.label}`));
				}
			} else if (asked && condition && "hasTargets" in condition) {
				const targets = keyed(
					el(
						"select",
						{ ariaLabel: text.conditionHasTargets, onchange: () => setCondition({ ...condition, hasTargets: targets.value === "yes" }) },
						el("option", { value: "yes", selected: condition.hasTargets }, text.conditionHasTargets),
						el("option", { value: "no", selected: !condition.hasTargets }, text.conditionNoTargets),
					),
					`role:${role.id}:condition:targets`,
				);
				details.push(targets);
			}
			const line = el("div", { className: "path-editor" }, el("span", { className: "muted" }, `${text.condition}:`), which, ...details);
			line.style.flexBasis = "100%";
			return line;
		};
		return el(
			"li",
			{ className: "path-row" },
			el("div", { className: "path-editor" }, roleName, kind),
			el(
				"div",
				{ className: "path-actions" },
				iconButton(text.moveUp, "↑", `role:${role.id}:up`, () => saveRoles(moveItem(trait.roles, index, index - 1)), index === 0),
				iconButton(text.moveDown, "↓", `role:${role.id}:down`, () => saveRoles(moveItem(trait.roles, index, index + 1)), index === trait.roles.length - 1),
				iconButton(text.removeRole, "✕", `role:${role.id}:remove`, () => saveRoles(trait.roles.filter((r) => r.id !== role.id))),
			),
			...(role.kind === "options" ? [valuesLine()] : []),
			...(role.kind === "reference" ? [conditionLine()] : []),
		);
	};
	const addRole = keyed(
		el(
			"button",
			{
				type: "button",
				onclick: () => saveRoles([...trait.roles, { id: ulid(), name: freeName(trait.roles, text.defaultRoleName), kind: "text", options: [] }]),
			},
			`+ ${text.addRole}`,
		),
		"role:add",
	);

	/** What plays `role` on `type`: a select of what fits, and for an options role which of its values each option
	 * stands for. */
	const bindingRow = (type: EntityType, role: RoleDef) => {
		const binding = trait.bindings[type.id]?.[role.id];
		const fits = fittingBinding(types, type.id, role, binding);
		const choices = bindingChoices(types, type.id, role);
		const current = binding ? choices.findIndex((c) => sameSource(c.binding, binding)) : -1;
		const missing = binding !== undefined && fits === null;
		const select = keyed(
			el(
				"select",
				{
					ariaLabel: role.name,
					className: missing ? "invalid" : "",
					onchange: () => {
						const choice = choices[Number(select.value)];
						updateTrait(store, trait.id, { bindings: withBinding(trait, type.id, role.id, choice?.binding ?? null).bindings });
					},
				},
				...(missing ? [el("option", { value: "missing", selected: true }, text.notThere)] : []),
				el("option", { value: "", selected: !missing && current < 0 }, text.unbound),
				...choices.map((c, i) => el("option", { value: String(i), selected: i === current && !missing }, fieldLabel(types, c.fits))),
			),
			`binding:${type.id}:${role.id}`,
		);
		const values =
			role.kind === "options" && fits && "prop" in fits && binding && "values" in binding
				? fits.prop.options.map((own) => {
						const to = keyed(
							el(
								"select",
								{
									ariaLabel: text.standsFor(own.label),
									onchange: () => {
										const { [own.id]: _, ...others } = binding.values;
										const values = to.value === "" ? others : { ...others, [own.id]: to.value };
										updateTrait(store, trait.id, { bindings: withBinding(trait, type.id, role.id, { ...binding, values }).bindings });
									},
								},
								el("option", { value: "" }, text.unbound),
								...role.options.map((o) => el("option", { value: o.id, selected: binding.values[own.id] === o.id }, o.label)),
							),
							`binding:${type.id}:${role.id}:${own.id}`,
						);
						return el("label", { className: "field" }, el("span", {}, text.standsFor(own.label)), to);
					})
				: [];
		const hint = hints.find((h) => h.typeId === type.id && h.roleId === role.id);
		const asked = hint && role.condition ? resolveCondition(store.data.traits, role.condition) : null;
		const warning = hint && asked ? [el("p", { className: "muted path-hint" }, text.conditionHint(hint.typeIds.map((id) => types.find((t) => t.id === id)?.name ?? "?").join(", "), asked.trait.name))] : [];
		return el(
			"li",
			{ className: "path-row" },
			el("div", { className: "path-editor" }, el("label", { className: "field" }, el("span", {}, role.name), select), ...values, ...warning),
		);
	};

	const typeSection = (type: EntityType) =>
		el(
			"fieldset",
			{ className: "path-list" },
			el("legend", {}, type.name),
			trait.roles.length === 0 ? el("p", { className: "muted" }, text.noRolesYet) : el("ol", {}, ...trait.roles.map((role) => bindingRow(type, role))),
			keyed(
				el("button", { type: "button", onclick: () => updateTrait(store, trait.id, { bindings: withType(trait, type.id, false).bindings }) }, text.removeType),
				`type:${type.id}:remove`,
			),
		);

	const hints = conditionHints(store.data, trait);
	const bearing = bearingTypes(types, trait);
	const others = types.filter((t) => !bearing.includes(t));
	const addType = keyed(
		el(
			"select",
			{
				ariaLabel: text.addType,
				onchange: () => {
					if (addType.value) updateTrait(store, trait.id, { bindings: withType(trait, addType.value, true).bindings });
				},
			},
			el("option", { value: "", selected: true }, text.addType),
			...others.map((t) => el("option", { value: t.id }, t.name)),
		),
		"type:add",
	);

	return el(
		"section",
		{ className: "analysis-setup trait-form" },
		el("div", { className: "analysis-meta" }, el("label", { className: "field" }, el("span", {}, sharedText.name), name), remove),
		el("p", { className: "muted path-hint" }, text.traitHint),
		el("fieldset", { className: "path-list" }, el("legend", {}, text.roles), el("p", { className: "muted path-hint" }, text.rolesHint), el("ol", {}, ...trait.roles.map(roleRow)), addRole),
		...(bearing.length > 0 ? [el("p", { className: "muted path-hint" }, text.bindingsHint)] : []),
		...bearing.map(typeSection),
		...(others.length > 0 ? [addType] : []),
	);
}

/** How the history tells of a trait: its roles (name and kind, an options role's values) and the types bearing it,
 * read with the types as they are now. */
export const TRAIT_HISTORY: UnitDescriber<DataStore> = {
	kind: "trait",
	area: "view",
	noun: text.historyTraits,
	read(value, store) {
		if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.roles) || !isRecord(value.bindings)) return null;
		const roles = value.roles.filter(isRecord).map((r) => {
			const kind = dataText.kinds[r.kind as RoleKind] ?? String(r.kind);
			const options = Array.isArray(r.options) ? r.options.filter(isRecord).map((o) => String(o.label)) : [];
			// A condition by the role it asks about, read with the traits as they are now.
			const condition = isRecord(r.condition) ? r.condition : null;
			const askedTrait = condition ? store.data.traits.find((t) => t.id === condition.traitId) : undefined;
			const askedRole = askedTrait?.roles.find((x) => x.id === condition?.roleId);
			const asks = condition ? `; ${text.condition}: ${askedTrait && askedRole ? `${askedTrait.name} › ${askedRole.name}` : text.notThere}` : "";
			return `${String(r.name)} (${options.length > 0 ? `${kind}: ${options.join(", ")}` : kind}${asks})`;
		});
		const bindings = value.bindings;
		const bearing = store.data.types.filter((t) => Object.hasOwn(bindings, t.id)).map((t) => t.name);
		return {
			name: value.name,
			fields: [
				{ label: text.roles, text: roles.join(", ") },
				{ label: text.historyTypes, text: bearing.join(", ") },
			],
		};
	},
};
