import { freeName, moveItem, ulid } from "../../shared/core/index.js";
import { dragHandle, el, emptyState, isRecord, refused, reorderable, setting, sharedText, typeDot, type SearchSource, type UnitDescriber } from "../../shared/ui/index.js";
import type { DataStore, EntityType } from "../data/core.js";
import type { DataSection, TypeNote } from "../data/ui.js";
import { text as dataText } from "../data/texts.js";
import {
	addTrait,
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
/** Keeps roles, and a role's values, from being dragged into another list. */
const ROLE_MIME = "application/x-trait-role-index";
const VALUE_MIME = "application/x-trait-value-index";

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

/** A role of a trait in short, for its line in the list's entry: the values it offers, or what it is. */
function describeRole(role: RoleDef): string {
	const values = role.kind === "options" ? role.options.map((o) => o.label).join(" / ") : "";
	return `${role.name}: ${values || dataText.kinds[role.kind]}`;
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
 * its condition) and, per type bearing it, what plays each role there. Every change is saved as it is made, as in an
 * analysis's setup; one the trait couldn't be saved with is refused at its field. Roles are cards as a type's properties
 * are, to reorder by their handle; the types bearing the trait follow, each with what plays the roles there.
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

	/** A reference role's condition: the role asked about, then the values or whether it has targets. */
	const conditionSetting = (role: RoleDef, index: number): HTMLElement => {
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
			details.push(el("span", { className: "setting-label" }, text.conditionValues(asked.role.name)));
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
				details.push(el("label", { className: "checkbox-setting" }, box, ` ${option.label}`));
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
		return setting(text.condition, el("div", { className: "trait-condition" }, which, ...details));
	};

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

	const roleRow = (role: RoleDef, index: number): HTMLElement => {
		const label = role.name.trim() || String(index + 1);
		const handle = dragHandle(text.moveRole(label), `role:${role.id}`);
		const roleName = keyed(
			el("input", {
				value: role.name,
				placeholder: sharedText.name,
				ariaLabel: text.roleName,
				onchange: () => setRole(index, { ...role, name: roleName.value }, roleName),
			}),
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
		const removeButton = keyed(
			el(
				"button",
				{
					type: "button",
					className: "property-remove",
					title: text.removeRole,
					ariaLabel: text.removeRoleNamed(label),
					onclick: () => saveRoles(trait.roles.filter((r) => r.id !== role.id)),
				},
				"✕",
			),
			`role:${role.id}:remove`,
		);
		// Below the line, as a property's settings: an options role's values (each to drag into another place), a
		// reference role's condition.
		const settings: HTMLElement[] = [];
		if (role.kind === "options") {
			const values = role.options.map((option, i) => {
				const valueLabel = option.label.trim() || String(i + 1);
				const valueHandle = dragHandle(text.moveValue(valueLabel), `role:${role.id}:value:${option.id}`);
				const input = keyed(
					el("input", {
						value: option.label,
						ariaLabel: text.roleValues,
						onchange: () =>
							setRole(index, { ...role, options: role.options.map((o, j) => (j === i ? { ...o, label: input.value } : o)) }, input),
					}),
					`role:${role.id}:value:${option.id}`,
				);
				const item = el(
					"div",
					{ className: "option-row" },
					valueHandle,
					input,
					keyed(
						el(
							"button",
							{
								type: "button",
								className: "property-remove",
								title: text.removeValue,
								ariaLabel: text.removeValueNamed(valueLabel),
								// The last value stays: a choice without values would let nothing through.
								disabled: role.options.length === 1,
								onclick: () => setRole(index, { ...role, options: role.options.filter((o) => o.id !== option.id) }),
							},
							"✕",
						),
						`role:${role.id}:value:${option.id}:remove`,
					),
				);
				reorderable(item, valueHandle, {
					index: i,
					count: role.options.length,
					mime: VALUE_MIME,
					move: (from, to) => {
						saveRoles(trait.roles.map((r, j) => (j === index ? { ...r, options: moveItem(r.options, from, to) } : r)));
					},
				});
				return item;
			});
			settings.push(
				setting(
					text.roleValues,
					el(
						"div",
						{ className: "option-list" },
						...values,
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
								text.addValue,
							),
							`role:${role.id}:add-value`,
						),
					),
				),
			);
		}
		if (role.kind === "reference") settings.push(conditionSetting(role, index));
		const open = role.kind !== "text";
		const row = el(
			"div",
			{ className: open ? "property open" : "property" },
			el(
				"div",
				{ className: "property-head" },
				handle,
				roleName,
				el(
					"span",
					{ className: "role-kind" },
					kind,
					...(role.kind === "options" ? [el("span", { className: "muted" }, dataText.optionCount(role.options.length))] : []),
				),
				removeButton,
			),
			...(open ? [el("div", { className: "property-settings" }, ...settings)] : []),
		);
		reorderable(row, handle, {
			index,
			count: trait.roles.length,
			mime: ROLE_MIME,
			move: (from, to) => saveRoles(moveItem(trait.roles, from, to)),
		});
		return row;
	};
	const addRole = keyed(
		el(
			"button",
			{
				type: "button",
				className: "add-property",
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
						return setting(text.standsFor(own.label), to);
					})
				: [];
		const hint = hints.find((h) => h.typeId === type.id && h.roleId === role.id);
		const asked = hint && role.condition ? resolveCondition(store.data.traits, role.condition) : null;
		const warning = hint && asked ? [el("p", { className: "muted trait-hint" }, text.conditionHint(hint.typeIds.map((id) => types.find((t) => t.id === id)?.name ?? "?").join(", "), asked.trait.name))] : [];
		return el(
			"li",
			{ className: "property" },
			el("div", { className: "property-settings" }, setting(role.name, select), ...values),
			...warning,
		);
	};

	const typeSection = (type: EntityType) =>
		el(
			"div",
			{ className: "trait-bearer" },
			el(
				"div",
				{ className: "trait-bearer-head" },
				el("h4", {}, typeDot(type.color), type.name),
				keyed(
					el("button", { type: "button", onclick: () => updateTrait(store, trait.id, { bindings: withType(trait, type.id, false).bindings }) }, text.removeType),
					`type:${type.id}:remove`,
				),
			),
			trait.roles.length === 0 ? el("p", { className: "muted trait-hint" }, text.noRolesYet) : el("ul", {}, ...trait.roles.map((role) => bindingRow(type, role))),
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
		"div",
		{ className: "card trait-form" },
		// Its name reads as the details' title. The traits are deleted where they stand, in the list, as the types
		// and the entities are.
		el("h3", {}, trait.name),
		el("label", { className: "field" }, el("span", {}, sharedText.name), name),
		el("h3", {}, text.roles),
		el("div", { className: "trait-roles" }, ...trait.roles.map(roleRow), addRole),
		...(bearing.length > 0 ? [el("h3", {}, text.bindingTypes), ...bearing.map(typeSection)] : []),
		...(others.length > 0 ? [el("div", { className: "trait-add-type" }, addType)] : []),
	);
}

/** The address of a trait in the Data tab. */
export const traitRoute = (traitId: string) => `#traits/${encodeURIComponent(traitId)}`;

/** The trait the address names (`#traits/<id>`), if it does. */
function traitOfRoute(hash: string): string | null {
	const [route, id] = hash.slice(1).split("/");
	return route === "traits" && id ? decodeURIComponent(id) : null;
}

/**
 * The traits in the Data tab (#traits), beside the entity types they lay a meaning over: their list, and the form of
 * the one the address names (`#traits/<id>`; none named: the first). Every change draws the section anew in place,
 * keeping focus on the control it came from.
 */
export const TRAITS_SECTION: DataSection = {
	route: "traits",
	label: () => text.traits,
	render(store, page) {
		const view = el("section", { className: "traits-section" });
		const draw = () => {
			const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey;
			const id = traitOfRoute(location.hash);
			const current = store.data.traits.find((t) => t.id === id) ?? store.data.traits[0];
			const make = () => {
				const item = addTrait(store, freeName(store.data.traits, text.defaultTraitName));
				// Its address without drawing the page anew (as a hash change would), so its name stays selected.
				history.pushState(null, "", traitRoute(item.id));
				draw();
				view.querySelector<HTMLInputElement>(".trait-form input")?.select();
			};
			const add = el("button", { type: "button", className: "primary", onclick: make }, text.newTrait);
			// Each trait as a type is listed: a card with its name and how many types bear it, its roles in short
			// below — and, under the pointer or with the focus, the button deleting it.
			const list = el(
				"ul",
				{ className: "trait-list" },
				...store.data.traits.map((trait) => {
					const bearers = bearingTypes(store.data.types, trait).length;
					return el(
						"li",
						{ className: trait.id === current?.id ? "trait-item current" : "trait-item" },
						el(
							"div",
							{ className: "trait-item-head" },
							el("a", { href: traitRoute(trait.id), className: "trait-entry", ariaCurrent: trait.id === current?.id ? "page" : "false", title: text.openTrait(trait.name) }, trait.name),
							el("span", { className: "trait-item-count muted" }, `${bearers} ${dataText.historyTypes(bearers)}`),
						),
						el(
							"div",
							{ className: "actions" },
							el(
								"button",
								{
									type: "button",
									className: "property-remove",
									title: text.deleteTrait,
									ariaLabel: text.deleteTrait,
									onclick: () => {
										if (confirm(text.confirmDeleteTrait(trait.name))) deleteTrait(store, trait.id);
									},
								},
								"✕",
							),
						),
						trait.roles.length > 0
							? el("ul", { className: "trait-item-summary muted" }, ...trait.roles.map((role) => el("li", {}, describeRole(role))))
							: el("p", { className: "trait-item-summary muted" }, text.noRoles),
					);
				}),
			);
			// None yet: what a trait is, and the button making the first.
			const shown = current ? el("div", { className: "traits-layout" }, list, traitForm(store, current)) : emptyState(text.noTraitsYet, { label: text.newTrait, run: make });
			view.replaceChildren(el("div", { className: "section-header" }, page.dataSwitch("traits"), ...(current ? [add] : [])), shown);
			if (focusKey) view.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus();
		};
		// Every change (here, or undone and redone) draws anew; the first after the section is gone stops listening.
		const stopWatching = store.onHistoryChange(() => (view.isConnected ? draw() : stopWatching()));
		draw();
		return view;
	},
};

/** In the search: the traits, and a new one, opened with its name to type. */
export const TRAIT_SEARCH: SearchSource<DataStore> = {
	items: (store) => store.data.traits.map((t) => ({ label: t.name, detail: text.trait, href: traitRoute(t.id) })),
	actions: (store) => [
		{
			label: text.newTrait,
			run: () => {
				location.hash = traitRoute(addTrait(store, freeName(store.data.traits, text.defaultTraitName)).id);
			},
		},
	],
};

/** At the head of a type's form: the traits it bears, each a link to it; none, nothing. Which of the type's fields
 * plays each role is said at the trait, not here. */
export const TRAIT_CHIPS: TypeNote = (store, type) => {
	const borne = store.data.traits.filter((trait) => Object.hasOwn(trait.bindings, type.id));
	if (borne.length === 0) return [];
	return [
		el(
			"p",
			{ className: "type-traits" },
			el("span", { className: "setting-label" }, dataText.typeTraits),
			...borne.map((trait) => el("a", { href: traitRoute(trait.id), className: "chip", title: text.openTrait(trait.name) }, trait.name)),
		),
	];
};

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
