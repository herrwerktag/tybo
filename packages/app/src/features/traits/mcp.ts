import { sameName, ulid, type AppData } from "../../shared/core/index.js";
import type { DataStore, EntityType, OptionDef } from "../data/core.js";
import { typeName, typeOf } from "../data/mcp.js";
import { ToolError, WORKSPACE, object, record, text, texts, type Tool, type ToolContext } from "../../shared/mcp/index.js";
import {
	NEW_TRAIT,
	addTrait,
	bearingTypes,
	conditionHints,
	resolveCondition,
	bindingChoices,
	deleteTrait,
	fittingBinding,
	updateTrait,
	validateTrait,
	withRoles,
	type Condition,
	type FittingBinding,
	type RoleBinding,
	type RoleDef,
	type RoleKind,
	type Trait,
	type TraitError,
} from "./core.js";

/** The tools on a workspace's traits: make one, change one, delete one. */
export function traitTools({ open, answerSaved }: ToolContext<DataStore>): Tool[] {
	return [
		{
			name: "create_trait",
			description:
				"Creates a trait: a meaning laid over existing types (Progress, say, over the different Status of several types). " +
				"It has `roles`, and every type bearing it says in `bindings` which of its fields plays which role; no type changes. " +
				"An analysis can then take the trait instead of a type (create_analysis with `trait`). " +
				BINDINGS,
			inputSchema: object({ workspace: WORKSPACE, name: { type: "string" }, roles: ROLES, bindings: BINDING_LIST }, ["workspace", "name"]),
			async run(args) {
				const store = await open(args.workspace);
				const name = text(args.name, "name");
				const given = args.roles === undefined ? [] : rolesOf(store.data, args.roles, [], { id: NEW_TRAIT, name });
				check(store.data, name, given, null);
				const bindings = args.bindings === undefined ? {} : bindingsOf(store.data, given, args.bindings);
				const trait = addTrait(store, name);
				// Conditions on the trait's own roles name it by its id now.
				const roles = given.map((r) => (r.condition?.traitId === NEW_TRAIT ? { ...r, condition: { ...r.condition, traitId: trait.id } } : r));
				updateTrait(store, trait.id, { roles, bindings });
				return answerSaved(store, { trait: describeTrait(store.data, traitOf(store.data, trait.id)) });
			},
		},
		{
			name: "update_trait",
			description:
				"Changes a trait: its name, its roles, its bindings. `roles` replaces the whole list: a role given by its id, or by the " +
				"name of one there is, keeps it and what is bound to it (unless its kind changes). `bindings` replaces all bindings; " +
				"without it, they stay as far as their roles do. " +
				BINDINGS,
			inputSchema: object({ workspace: WORKSPACE, trait: TRAIT, name: { type: "string" }, roles: ROLES, bindings: BINDING_LIST }, ["workspace", "trait"]),
			async run(args) {
				const store = await open(args.workspace);
				const trait = traitOf(store.data, args.trait);
				const name = args.name === undefined ? trait.name : text(args.name, "name");
				const roles = args.roles === undefined ? trait.roles : rolesOf(store.data, args.roles, trait.roles, { id: trait.id, name });
				check(store.data, name, roles, trait.id);
				const changed = withRoles(trait, roles);
				const bindings = args.bindings === undefined ? changed.bindings : bindingsOf(store.data, changed.roles, args.bindings);
				updateTrait(store, trait.id, { name, roles: changed.roles, bindings });
				return answerSaved(store, { trait: describeTrait(store.data, traitOf(store.data, trait.id)) });
			},
		},
		{
			name: "delete_trait",
			description: "Deletes a trait; the types and entities stay as they are, analyses of it have no rows until given another. Needs `confirm: true`.",
			inputSchema: object({ workspace: WORKSPACE, trait: TRAIT, confirm: { type: "boolean" } }, ["workspace", "trait", "confirm"]),
			async run(args) {
				const store = await open(args.workspace);
				const trait = traitOf(store.data, args.trait);
				if (args.confirm !== true) throw new ToolError(`Deleting the trait "${trait.name}" needs confirm: true.`);
				deleteTrait(store, trait.id);
				return answerSaved(store, { deleted: { id: trait.id, name: trait.name } });
			},
		},
	];
}

/** The traits in describe_workspace. */
export function describeTraits(data: AppData): object {
	return { traits: data.traits.map((t) => describeTrait(data, t)) };
}

const TRAIT = { type: "string", description: "Name or id of the trait." };
const ROLES = {
	type: "array",
	items: {
		type: "object",
		properties: {
			id: { type: "string", description: "The id of a role there is: keeps it, renamed to `name`." },
			name: { type: "string" },
			kind: { type: "string", enum: ["text", "options", "reference"] },
			options: {
				type: "array",
				items: { type: ["string", "object"], properties: { id: { type: "string" }, label: { type: "string" } } },
				description: "For options: the role's own values, in order; each a label or { id, label } (an id keeps — and renames — the value it has).",
			},
			condition: {
				type: ["object", "null"],
				properties: {
					trait: { type: "string", description: "Name or id of the trait asked about; left out, this one." },
					role: { type: "string", description: "Name or id of its options or reference role." },
					values: { type: "array", items: { type: "string" }, description: "For an options role: the values (label or id) a target must hold one of." },
					hasTargets: { type: "boolean", description: "For a reference role: whether a target must have targets there (true) or none (false)." },
				},
				required: ["role"],
				description:
					"For references: the targets only count when they meet it — e.g. { trait: Progress, role: Stand, values: [open] }. A target whose " +
					"type doesn't bear that trait never meets it. Left out, a role keeps the condition it has; null removes it. Conditions may not " +
					"lead round in a circle.",
			},
		},
		required: ["name", "kind"],
	},
	description: "The roles, in order.",
};
const BINDING_LIST = {
	type: "array",
	items: {
		type: "object",
		properties: {
			type: { type: "string", description: "Name or id of a type bearing the trait. Listed without `role`, it bears it with nothing bound yet." },
			role: { type: "string", description: "Name or id of the role." },
			property: {
				type: "string",
				description: "What plays the role: a property of the type (name or id); name, content or description for a text role; for a reference role also another type's reference pointing at it, as Type.Property.",
			},
			values: {
				type: "object",
				additionalProperties: { type: "string" },
				description: "For options: the property's option (label or id) → the role's value it stands for (label or id). An option left out counts as no value.",
			},
		},
		required: ["type"],
	},
	description: "What plays each role, per type.",
};
const BINDINGS =
	"A role is a text, an options (with values of its own) or a reference. It is bound only to what fits: a text role to a text " +
	"property or the built-in name, content or description; an options role to an options property, saying which option stands " +
	"for which of the role's values (several may stand for one); a reference role to a reference of the type, or (as Type.Property) " +
	"another type's reference pointing at it.";

export const traitName = (data: AppData, traitId: string | null) => data.traits.find((t) => t.id === traitId)?.name ?? null;

/** The trait `ref` names by id or name. */
export function traitOf(data: AppData, ref: unknown): Trait {
	const wanted = text(ref, "trait");
	const trait = data.traits.find((t) => t.id === wanted) ?? data.traits.find((t) => sameName(t.name, wanted));
	if (!trait) throw new ToolError(`There is no trait "${wanted}". Traits: ${data.traits.map((t) => t.name).join(", ") || "none"}.`);
	return trait;
}

/** The roles the model listed: one given the id or the name of one of `current` keeps its id (and, through
 * `withRoles`, what is bound to it); options the same way. A role given without `condition` keeps the one it has;
 * a condition may name `self`, the trait the roles are of. */
function rolesOf(data: AppData, raw: unknown, current: readonly RoleDef[], self: { id: string; name: string }): RoleDef[] {
	if (!Array.isArray(raw)) throw new ToolError("`roles` must be a list.");
	const roles = raw.map((item, index): RoleDef => {
		const given = record(item, `roles[${index}]`);
		const was =
			typeof given.id === "string" ? current.find((r) => r.id === given.id) : typeof given.name === "string" ? current.find((r) => sameName(r.name, given.name as string)) : undefined;
		if (typeof given.id === "string" && !was) throw new ToolError(`There is no role with the id ${given.id}.`);
		const kind = (given.kind ?? was?.kind) as RoleKind;
		if (!["text", "options", "reference"].includes(kind)) throw new ToolError(`roles[${index}] needs a kind: text, options, reference.`);
		const name = given.name === undefined ? (was?.name ?? "") : text(given.name, `roles[${index}].name`);
		const options = kind !== "options" ? [] : given.options === undefined ? (was?.options ?? []) : optionsOf(given.options, was, index);
		return { id: was?.id ?? ulid(), name, kind, options, ...(kind === "reference" && was?.condition ? { condition: was.condition } : {}) };
	});
	// Conditions once every role has its id, as they may name one another.
	return roles.map((role, index) => {
		const given = (raw[index] as Record<string, unknown>).condition;
		if (given === undefined) return role;
		const { condition: _, ...without } = role;
		if (given === null) return without;
		if (role.kind !== "reference") throw new ToolError(`roles[${index}]: only a reference role has a condition.`);
		return { ...without, condition: conditionOf(data, record(given, `roles[${index}].condition`), roles, self, index) };
	});
}

/** The condition the model gave a role: on a role of `self` (the trait the roles are of, read with `roles`) or of
 * another trait, by name or id; values by label or id. */
function conditionOf(data: AppData, given: Record<string, unknown>, roles: readonly RoleDef[], self: { id: string; name: string }, index: number): Condition {
	const where = `roles[${index}].condition`;
	const traitRef = given.trait === undefined ? null : text(given.trait, `${where}.trait`);
	const isSelf = traitRef === null || traitRef === self.id || sameName(traitRef, self.name);
	const trait = isSelf ? { id: self.id, name: self.name, roles } : traitOf(data, traitRef);
	const wanted = text(given.role, `${where}.role`);
	const role = trait.roles.find((r) => r.id === wanted) ?? trait.roles.find((r) => sameName(r.name, wanted));
	const askable = trait.roles.filter((r) => r.kind !== "text").map((r) => r.name).join(", ") || "none";
	if (!role || role.kind === "text") throw new ToolError(`${where}: ${trait.name} has no options or reference role "${wanted}". Roles: ${askable}.`);
	if (role.kind === "reference") {
		if (typeof given.hasTargets !== "boolean") throw new ToolError(`${where}: ${role.name} is a reference role; say \`hasTargets\`: true or false.`);
		return { traitId: trait.id, roleId: role.id, hasTargets: given.hasTargets };
	}
	const values = texts(given.values, `${where}.values`).map((v) => {
		const value = role.options.find((o) => o.id === v) ?? role.options.find((o) => sameName(o.label, v));
		if (!value) throw new ToolError(`${where}: "${v}" isn't a value of ${role.name}. Values: ${role.options.map((o) => o.label).join(", ")}.`);
		return value.id;
	});
	if (values.length === 0) throw new ToolError(`${where}: name at least one value of ${role.name}.`);
	return { traitId: trait.id, roleId: role.id, values };
}

/** The role's values the model listed: a label keeps the id of the value of `was` with that label; `{ id, label }`
 * renames one of `was`. */
function optionsOf(raw: unknown, was: RoleDef | undefined, index: number): OptionDef[] {
	if (!Array.isArray(raw)) throw new ToolError(`roles[${index}].options must be a list.`);
	return raw.map((item, i) => {
		const given = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
		const label = typeof item === "string" ? item : given ? text(given.label, `roles[${index}].options[${i}].label`) : "";
		if (given?.id !== undefined) {
			const existing = was?.options.find((o) => o.id === given.id);
			if (!existing) throw new ToolError(`There is no value with the id ${String(given.id)} in ${was?.name ?? `roles[${index}]`}.`);
			return { id: existing.id, label };
		}
		return { id: was?.options.find((o) => sameName(o.label, label))?.id ?? ulid(), label };
	});
}

/** Refuses a trait the trait form would refuse, saying why. */
function check(data: AppData, name: string, roles: readonly RoleDef[], selfId: string | null): void {
	const errors = validateTrait(name, roles, data.traits, selfId);
	if (errors.length > 0) throw new ToolError(`The trait can't be saved: ${errors.map(problem).join(" ")}`);
}

function problem(error: TraitError): string {
	switch (error.code) {
		case "traitNameRequired":
			return "It needs a name.";
		case "traitNameTaken":
			return `There is a trait "${error.label}" already.`;
		case "roleNameRequired":
			return "Every role needs a name.";
		case "duplicateRole":
			return `The role "${error.label}" is there twice.`;
		case "optionsRequired":
			return `${error.label} needs values.`;
		case "emptyOption":
			return `${error.label} has an empty value.`;
		case "duplicateOptions":
			return `${error.label} has a value twice.`;
		case "conditionCycle":
			return `The conditions lead round in a circle: ${error.label}.`;
	}
}

/** The bindings the model listed, per type and role, each checked to fit (see `fittingBinding`). */
function bindingsOf(data: AppData, roles: readonly RoleDef[], raw: unknown): Trait["bindings"] {
	if (!Array.isArray(raw)) throw new ToolError("`bindings` must be a list.");
	let trait: Trait = { id: "", name: "", roles: [...roles], bindings: {} };
	for (const [index, item] of raw.entries()) {
		const given = record(item, `bindings[${index}]`);
		const type = typeOf(data, given.type);
		trait = { ...trait, bindings: { ...trait.bindings, [type.id]: trait.bindings[type.id] ?? {} } };
		if (given.role === undefined) continue;
		const wanted = text(given.role, `bindings[${index}].role`);
		const role = roles.find((r) => r.id === wanted) ?? roles.find((r) => sameName(r.name, wanted));
		if (!role) throw new ToolError(`bindings[${index}]: there is no role "${wanted}". Roles: ${roles.map((r) => r.name).join(", ") || "none"}.`);
		const binding = bindingOf(data, type, role, text(given.property, `bindings[${index}].property`), given.values, index);
		trait = { ...trait, bindings: { ...trait.bindings, [type.id]: { ...trait.bindings[type.id], [role.id]: binding } } };
	}
	return trait.bindings;
}

/** What the model named to play `role` on `type`, refused (naming role and field) when it doesn't fit. */
function bindingOf(data: AppData, type: EntityType, role: RoleDef, property: string, rawValues: unknown, index: number): RoleBinding {
	const choices = bindingChoices(data.types, type.id, role);
	const found = choices.find(({ fits }) => fieldName(data, fits) === property || ("prop" in fits && fits.prop.id === property)) ??
		choices.find(({ fits }) => sameName(fieldName(data, fits), property));
	if (!found) {
		const fitting = choices.map(({ fits }) => fieldName(data, fits)).join(", ") || "none";
		throw new ToolError(`bindings[${index}]: "${property}" can't play the ${role.kind} role ${role.name} on ${type.name}. What fits: ${fitting}.`);
	}
	if (role.kind !== "options" || "field" in found.binding || !("prop" in found.fits)) return found.binding;
	const prop = found.fits.prop;
	const values: Record<string, string> = {};
	for (const [own, to] of Object.entries(rawValues === undefined ? {} : record(rawValues, `bindings[${index}].values`))) {
		const option = prop.options.find((o) => o.id === own) ?? prop.options.find((o) => sameName(o.label, own));
		if (!option) throw new ToolError(`bindings[${index}]: "${own}" isn't an option of ${prop.name}. Options: ${prop.options.map((o) => o.label).join(", ")}.`);
		const target = text(to, `bindings[${index}].values.${own}`);
		const value = role.options.find((o) => o.id === target) ?? role.options.find((o) => sameName(o.label, target));
		if (!value) throw new ToolError(`bindings[${index}]: "${target}" isn't a value of ${role.name}. Values: ${role.options.map((o) => o.label).join(", ")}.`);
		values[option.id] = value.id;
	}
	return { ...found.binding, values };
}

/** How a field playing a role reads: a built-in field by its name, a property by its name, another type's reference
 * as Type.Property. */
function fieldName(data: AppData, fits: FittingBinding): string {
	if ("field" in fits) return fits.field;
	return fits.direction === "forward" ? fits.prop.name : `${typeName(data, fits.ownerTypeId)}.${fits.prop.name}`;
}

/** A role's condition as the model reads it: the role asked about by trait and name, values by label. */
function describeCondition(data: AppData, condition: Condition): object {
	const asked = resolveCondition(data.traits, condition);
	if (!asked) return { notThere: "What the condition asks about is gone; no target meets it." };
	return {
		trait: asked.trait.name,
		role: asked.role.name,
		...("values" in condition ? { values: asked.values.map((id) => asked.role.options.find((o) => o.id === id)!.label) } : { hasTargets: condition.hasTargets }),
	};
}

function describeTrait(data: AppData, trait: Trait) {
	const hints = conditionHints(data, trait);
	return {
		id: trait.id,
		name: trait.name,
		roles: trait.roles.map((r) => ({
			id: r.id,
			name: r.name,
			kind: r.kind,
			...(r.kind === "options" ? { options: r.options } : {}),
			...(r.condition ? { condition: describeCondition(data, r.condition) } : {}),
		})),
		types: bearingTypes(data.types, trait).map((type) => ({
			type: type.name,
			roles: trait.roles.flatMap((role): object[] => {
				const binding = trait.bindings[type.id]?.[role.id];
				if (!binding) return [];
				const fits = fittingBinding(data.types, type.id, role, binding);
				if (!fits) return [{ role: role.name, notThere: "What was bound here is gone or no longer fits; it counts as no value." }];
				const values =
					"prop" in fits && "values" in binding && role.kind === "options"
						? Object.fromEntries(
								fits.prop.options.flatMap((o) => {
									const to = role.options.find((r) => r.id === binding.values[o.id]);
									return to ? [[o.label, to.label]] : [];
								}),
							)
						: undefined;
				const without = hints.find((h) => h.typeId === type.id && h.roleId === role.id)?.typeIds.map((id) => typeName(data, id));
				return [{ role: role.name, property: fieldName(data, fits), ...(values ? { values } : {}), ...(without ? { targetsNeverMeetingCondition: without } : {}) }];
			}),
		})),
	};
}
