import { freeName, nameTaken, refuseTakenName, ulid, type AppData, type DataPart, type UnitKind } from "../../shared/core/index.js";
import { propertyReader, type Entity, type EntityType, type OptionDef, type PropertyDef, type PropertyKind, type DataStore } from "../data/core.js";

/**
 * Traits: named meanings laid over existing types after the fact. A trait has roles; every type bearing it says
 * which of its own fields plays which role. Their part of the app's data is `traits`, each one unit of its own —
 * the bindings with it, so binding a type writes no type, and changing a type writes no trait.
 */
declare module "../../shared/core/data.js" {
	interface AppData {
		/** The traits, in the order they were made. */
		traits: Trait[];
	}
}

/** A role is a choice of its own values, a reference, or a text — like a property. */
export type RoleKind = PropertyKind;

export interface RoleDef {
	id: string;
	name: string;
	kind: RoleKind;
	/** The role's own values, in order (an options role); empty for the others. */
	options: OptionDef[];
	/** A reference role's condition: it leads only to the targets meeting it. Left out when there is none. */
	condition?: Condition;
}

/**
 * What a target of a reference role has to meet to count: an options role of a trait (this one or another) holding
 * one of `values` there, or a reference role of a trait having targets there (`hasTargets`) or none — those it has
 * after its own condition. A target whose type doesn't bear that trait never meets it.
 */
export type Condition = { traitId: string; roleId: string; values: string[] } | { traitId: string; roleId: string; hasTargets: boolean };

/** The fields every entity has, which a text role can be bound to. */
export type BuiltInField = "name" | "content" | "description";

export const BUILT_IN_FIELDS: readonly BuiltInField[] = ["name", "content", "description"];

/**
 * What plays a role on a type's entities: a built-in field, or a property — its own (`forward`), or for a reference
 * role another type's reference pointing at it (`inverse`, the entities holding it). For an options role, `values`
 * says which of the property's options stands for which of the role's (several may stand for one; one standing for
 * none counts as no value); empty for the others.
 */
export type RoleBinding = { field: BuiltInField } | { propertyId: string; direction: "forward" | "inverse"; values: Record<string, string> };

export interface Trait {
	id: string;
	name: string;
	roles: RoleDef[];
	/** Per type bearing the trait, by role id, what plays the role. A type may leave roles unbound. */
	bindings: Record<string, Record<string, RoleBinding>>;
}

/** A binding as it fits the types now: a built-in field, or the property with the type holding it. */
export type FittingBinding = { field: BuiltInField } | { prop: PropertyDef; ownerTypeId: string; direction: "forward" | "inverse" };

/** The types bearing the trait, in type order. */
export function bearingTypes(types: readonly EntityType[], trait: Trait): EntityType[] {
	return types.filter((t) => Object.hasOwn(trait.bindings, t.id));
}

/**
 * What `binding` reads on entities of `typeId` for `role`, or null when it doesn't fit (any more): a field only plays
 * a text role; a property is one of the type's own of the role's kind, or (inverse, reference roles only) a reference
 * of any type that can point at it.
 */
export function fittingBinding(types: readonly EntityType[], typeId: string, role: RoleDef, binding: RoleBinding | undefined): FittingBinding | null {
	if (!binding) return null;
	if ("field" in binding) return role.kind === "text" && BUILT_IN_FIELDS.includes(binding.field) ? { field: binding.field } : null;
	if (binding.direction === "forward") {
		const prop = types.find((t) => t.id === typeId)?.properties.find((p) => p.id === binding.propertyId);
		return prop && prop.kind === role.kind ? { prop, ownerTypeId: typeId, direction: "forward" } : null;
	}
	if (role.kind !== "reference") return null;
	for (const type of types) {
		const prop = type.properties.find((p) => p.id === binding.propertyId);
		if (prop) return prop.kind === "reference" && prop.reference?.typeIds.includes(typeId) ? { prop, ownerTypeId: type.id, direction: "inverse" } : null;
	}
	return null;
}

/** What can play `role` on entities of `typeId`, in the order the form offers it: the built-in fields (a text role),
 * the type's own properties of the role's kind, then (a reference role) the references of any type pointing at it. */
export function bindingChoices(types: readonly EntityType[], typeId: string, role: RoleDef): { binding: RoleBinding; fits: FittingBinding }[] {
	const own = types.find((t) => t.id === typeId)?.properties.filter((p) => p.kind === role.kind) ?? [];
	const fields = role.kind === "text" ? BUILT_IN_FIELDS.map((field) => ({ binding: { field }, fits: { field } })) : [];
	const forward = own.map((prop) => ({
		binding: { propertyId: prop.id, direction: "forward" as const, values: {} },
		fits: { prop, ownerTypeId: typeId, direction: "forward" as const },
	}));
	const inverse =
		role.kind !== "reference"
			? []
			: types.flatMap((type) =>
					type.properties
						.filter((p) => p.kind === "reference" && p.reference?.typeIds.includes(typeId))
						.map((prop) => ({
							binding: { propertyId: prop.id, direction: "inverse" as const, values: {} },
							fits: { prop, ownerTypeId: type.id, direction: "inverse" as const },
						})),
				);
	return [...fields, ...forward, ...inverse];
}

/** Whether two bindings read the same field or property the same way (their values aside). */
export function sameSource(a: RoleBinding, b: RoleBinding): boolean {
	if ("field" in a || "field" in b) return "field" in a && "field" in b && a.field === b.field;
	return a.propertyId === b.propertyId && a.direction === b.direction;
}

/** The role a condition asks about, with the values it names that are still there; null when it is gone, isn't of the
 * kind the condition asks (values of an options role, targets of a reference role), or none of its values is left. */
export function resolveCondition(traits: readonly Trait[], condition: Condition): { trait: Trait; role: RoleDef; values: string[] } | null {
	const trait = traits.find((t) => t.id === condition.traitId);
	const role = trait?.roles.find((r) => r.id === condition.roleId);
	if (!trait || !role) return null;
	if (!("values" in condition)) return role.kind === "reference" ? { trait, role, values: [] } : null;
	const values = condition.values.filter((id) => role.options.some((o) => o.id === id));
	return role.kind === "options" && values.length > 0 ? { trait, role, values } : null;
}

/**
 * The roles a condition chain from `start` comes back to it through, as "Trait.Role" from `start` on; null when it
 * doesn't. Each reference role has at most one condition, so a chain is a single line: it ends, or runs into a circle.
 */
export function conditionCycle(traits: readonly Trait[], start: { traitId: string; roleId: string }): string[] | null {
	const roleOf = (at: { traitId: string; roleId: string }) => {
		const trait = traits.find((t) => t.id === at.traitId);
		const role = trait?.roles.find((r) => r.id === at.roleId);
		return trait && role ? { trait, role } : null;
	};
	const label = (at: { traitId: string; roleId: string }) => {
		const found = roleOf(at);
		return found ? `${found.trait.name}.${found.role.name}` : "?";
	};
	const seen = new Set<string>();
	const path = [label(start)];
	let next = roleOf(start)?.role.condition;
	while (next) {
		if (next.traitId === start.traitId && next.roleId === start.roleId) return [...path, label(start)];
		const key = `${next.traitId}:${next.roleId}`;
		if (seen.has(key)) return null;
		seen.add(key);
		path.push(label(next));
		const found = roleOf(next);
		next = found?.role.kind === "reference" ? found.role.condition : undefined;
	}
	return null;
}

/** Per type bearing the trait and reference role with a condition, the types its targets can have that don't bear the
 * condition's trait: such targets never count. */
export function conditionHints(data: Pick<AppData, "types" | "traits">, trait: Trait): { typeId: string; roleId: string; typeIds: string[] }[] {
	return bearingTypes(data.types, trait).flatMap((type) =>
		trait.roles.flatMap((role) => {
			const asked = role.kind === "reference" && role.condition ? resolveCondition(data.traits, role.condition) : null;
			const fits = asked ? fittingBinding(data.types, type.id, role, trait.bindings[type.id]?.[role.id]) : null;
			if (!asked || !fits || "field" in fits) return [];
			const targets = fits.direction === "forward" ? (fits.prop.reference?.typeIds ?? []) : [fits.ownerTypeId];
			const typeIds = targets.filter((id) => !Object.hasOwn(asked.trait.bindings, id));
			return typeIds.length > 0 ? [{ typeId: type.id, roleId: role.id, typeIds }] : [];
		}),
	);
}

/** The types of the entities a reference role leads to, over the types bearing the trait, in type order. */
export function roleTargetTypeIds(types: readonly EntityType[], trait: Trait, role: RoleDef): string[] {
	if (role.kind !== "reference") return [];
	const targets = new Set<string>();
	for (const type of bearingTypes(types, trait)) {
		const fits = fittingBinding(types, type.id, role, trait.bindings[type.id]?.[role.id]);
		if (!fits || "field" in fits) continue;
		for (const id of fits.direction === "forward" ? (fits.prop.reference?.typeIds ?? []) : [fits.ownerTypeId]) targets.add(id);
	}
	return types.filter((t) => targets.has(t.id)).map((t) => t.id);
}

/**
 * The one place a role is read on an entity: what plays the role there, as a function of the entity — the ids of
 * the entities a reference role leads to (those meeting its condition), the ids of the role's own values an options
 * role stands for, the texts of a text role. An entity of a type not bearing the trait, or not binding the role in a
 * way that fits, has none.
 */
export function roleReader(data: Pick<AppData, "types" | "entities" | "traits">, trait: Trait, roleId: string): (entity: Entity) => string[] {
	return readerOf(data, trait, roleId, new Map(), new Set());
}

type Reader = (entity: Entity) => string[];

/** `roleReader`, sharing the readers of the roles conditions ask about (`built`, each reading an entity once); a role
 * met again while it is being built (a circle of conditions saved without the check) reads as none. */
function readerOf(data: Pick<AppData, "types" | "entities" | "traits">, trait: Trait, roleId: string, built: Map<string, Reader>, building: Set<string>): Reader {
	const key = `${trait.id}:${roleId}`;
	const done = built.get(key);
	if (done) return done;
	const role = trait.roles.find((r) => r.id === roleId);
	if (!role || building.has(key)) return () => [];
	building.add(key);
	const readers = new Map<string, Reader>();
	for (const type of bearingTypes(data.types, trait)) {
		const binding = trait.bindings[type.id]?.[role.id];
		const fits = fittingBinding(data.types, type.id, role, binding);
		if (!fits || !binding) continue;
		if ("field" in fits) {
			readers.set(type.id, (e) => (e[fits.field].trim() === "" ? [] : [e[fits.field]]));
			continue;
		}
		const read = propertyReader(data.entities, fits.prop, fits.ownerTypeId, fits.direction);
		if (role.kind === "options" && "values" in binding) {
			const known = new Set(role.options.map((o) => o.id));
			readers.set(type.id, (e) => read(e).flatMap((id) => (known.has(binding.values[id] ?? "") ? [binding.values[id]!] : [])));
		} else readers.set(type.id, read);
	}
	const bound: Reader = (entity) => readers.get(entity.typeId)?.(entity) ?? [];
	const meets = role.kind === "reference" && role.condition ? conditionCheck(data, role.condition, built, building) : null;
	const memo = new Map<string, string[]>();
	const reader: Reader = (entity) => {
		const known = memo.get(entity.id);
		if (known) return known;
		const read = meets ? bound(entity).filter(meets) : bound(entity);
		memo.set(entity.id, read);
		return read;
	};
	building.delete(key);
	built.set(key, reader);
	return reader;
}

/** Whether the entity of an id meets `condition` (see `Condition`); nothing does when it is gone (see `resolveCondition`). */
function conditionCheck(data: Pick<AppData, "types" | "entities" | "traits">, condition: Condition, built: Map<string, Reader>, building: Set<string>): (id: string) => boolean {
	const asked = resolveCondition(data.traits, condition);
	if (!asked) return () => false;
	const read = readerOf(data, asked.trait, asked.role.id, built, building);
	const byId = new Map(data.entities.map((e) => [e.id, e]));
	return (id) => {
		const target = byId.get(id);
		if (!target || !Object.hasOwn(asked.trait.bindings, target.typeId)) return false;
		const held = read(target);
		return "values" in condition ? held.some((v) => asked.values.includes(v)) : held.length > 0 === condition.hasTargets;
	};
}

/** A problem with a trait as given; the UI and the MCP each say it in their words. */
export type TraitError =
	| { code: "traitNameRequired" }
	| { code: "traitNameTaken"; label: string }
	| { code: "roleNameRequired" }
	| { code: "duplicateRole"; label: string }
	| { code: "optionsRequired" | "emptyOption" | "duplicateOptions"; label: string }
	| { code: "conditionCycle"; label: string };

/** The problems of a trait's name and roles; an empty list means it can be saved. `traits` are the traits there are, of
 * which the one of `selfId` is the trait itself: another one may not have its name. A new trait (`selfId` null) is
 * named by its conditions as `NEW_TRAIT`. */
export function validateTrait(name: string, roles: readonly RoleDef[], traits: readonly Trait[], selfId: string | null = null): TraitError[] {
	const errors: TraitError[] = [];
	if (name.trim() === "") errors.push({ code: "traitNameRequired" });
	else if (nameTaken(traits, name, selfId)) errors.push({ code: "traitNameTaken", label: name.trim() });
	const seen = new Set<string>();
	for (const role of roles) {
		const label = role.name.trim();
		const key = label.toLocaleLowerCase();
		if (key === "") errors.push({ code: "roleNameRequired" });
		else if (seen.has(key)) errors.push({ code: "duplicateRole", label });
		seen.add(key);
		if (role.kind !== "options") continue;
		const options = role.options.map((o) => o.label.trim().toLocaleLowerCase());
		if (options.length === 0) errors.push({ code: "optionsRequired", label });
		if (options.some((o) => o === "")) errors.push({ code: "emptyOption", label });
		if (new Set(options).size !== options.length) errors.push({ code: "duplicateOptions", label });
	}
	// Circles of conditions, read with the roles as given; each circle once, from its first role here.
	const id = selfId ?? NEW_TRAIT;
	const self: Trait = { id, name: name.trim(), roles: [...roles], bindings: {} };
	const all = [...traits.filter((t) => t.id !== id), self];
	const circled = new Set<string>();
	for (const role of roles) {
		if (circled.has(role.id)) continue;
		const cycle = conditionCycle(all, { traitId: id, roleId: role.id });
		if (!cycle) continue;
		errors.push({ code: "conditionCycle", label: cycle.join(" › ") });
		for (const r of roles) if (conditionCycle(all, { traitId: id, roleId: r.id })) circled.add(r.id);
	}
	return errors;
}

/** How the conditions of a trait not made yet name it (see `validateTrait`). */
export const NEW_TRAIT = "new-trait";

/**
 * The trait with its roles replaced by `roles` (labels trimmed): the bindings of roles gone, or whose kind changed,
 * go with them; an options binding forgets the values of the role that are gone.
 */
export function withRoles(trait: Trait, roles: readonly RoleDef[]): Trait {
	const byId = new Map(roles.map((r) => [r.id, r]));
	const bindings = Object.fromEntries(
		Object.entries(trait.bindings).map(([typeId, byRole]) => [
			typeId,
			Object.fromEntries(
				Object.entries(byRole).flatMap(([roleId, binding]): [string, RoleBinding][] => {
					const role = byId.get(roleId);
					const was = trait.roles.find((r) => r.id === roleId);
					if (!role || role.kind !== was?.kind) return [];
					if ("field" in binding) return [[roleId, binding]];
					const known = new Set(role.options.map((o) => o.id));
					return [[roleId, { ...binding, values: Object.fromEntries(Object.entries(binding.values).filter(([, to]) => known.has(to))) }]];
				}),
			),
		]),
	);
	const trimmed = roles.map(({ condition, ...r }): RoleDef => ({
		...r,
		name: r.name.trim(),
		options: r.kind === "options" ? r.options.map((o) => ({ ...o, label: o.label.trim() })) : [],
		// Only a reference role has a condition.
		...(r.kind === "reference" && condition ? { condition } : {}),
	}));
	return { ...trait, roles: trimmed, bindings };
}

/** The trait with `role` bound on `typeId` to `binding`, or unbound (null); a type not bearing it yet bears it now. */
export function withBinding(trait: Trait, typeId: string, roleId: string, binding: RoleBinding | null): Trait {
	const { [roleId]: _, ...others } = trait.bindings[typeId] ?? {};
	return { ...trait, bindings: { ...trait.bindings, [typeId]: binding ? { ...others, [roleId]: binding } : others } };
}

/** The trait borne by `typeId` too (nothing bound yet), or no longer (`bears` false). */
export function withType(trait: Trait, typeId: string, bears: boolean): Trait {
	const { [typeId]: was, ...others } = trait.bindings;
	return { ...trait, bindings: bears ? { ...others, [typeId]: was ?? {} } : others };
}

/** Adds a trait without roles. Without a name, it is "Trait n" of the first number free; a name another trait has is
 * refused with a `NameTaken`. */
export function addTrait(store: DataStore, name: string): Trait {
	const { data } = store;
	refuseTakenName("trait", data.traits, name);
	const item: Trait = { id: ulid(), name: name.trim() || freeName(data.traits, (n) => `Trait ${n}`), roles: [], bindings: {} };
	store.change({ ...data, traits: [...data.traits, item] });
	return item;
}

/** Renames the trait or sets its roles or bindings; an empty name is ignored, one another trait has is refused with a
 * `NameTaken`. Roles are taken as given (see `validateTrait`, `withRoles`). */
export function updateTrait(store: DataStore, traitId: string, patch: Partial<Omit<Trait, "id">>): void {
	const { data } = store;
	const name = patch.name?.trim();
	if (name) refuseTakenName("trait", data.traits, name, traitId);
	store.change({ ...data, traits: data.traits.map((item) => (item.id === traitId ? { ...item, ...patch, name: name || item.name } : item)) });
}

/** Deletes the trait; analyses of it stay, without rows, until they're given a type or another trait. */
export function deleteTrait(store: DataStore, traitId: string): void {
	const { data } = store;
	store.change({ ...data, traits: data.traits.filter((item) => item.id !== traitId) });
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const KINDS: readonly RoleKind[] = ["text", "options", "reference"];

function normalizeRole(raw: unknown): RoleDef[] {
	if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.name !== "string" || !KINDS.includes(raw.kind as RoleKind)) return [];
	const options = raw.kind === "options" && Array.isArray(raw.options) ? raw.options.filter((o): o is OptionDef => isObject(o) && typeof o.id === "string" && typeof o.label === "string") : [];
	const condition = raw.kind === "reference" ? normalizeCondition(raw.condition) : null;
	return [{ id: raw.id, name: raw.name, kind: raw.kind as RoleKind, options: options.map(({ id, label }) => ({ id, label })), ...(condition ? { condition } : {}) }];
}

/** A well-formed condition (version 12 on), or null. */
function normalizeCondition(raw: unknown): Condition | null {
	if (!isObject(raw) || typeof raw.traitId !== "string" || typeof raw.roleId !== "string") return null;
	if (typeof raw.hasTargets === "boolean") return { traitId: raw.traitId, roleId: raw.roleId, hasTargets: raw.hasTargets };
	if (!Array.isArray(raw.values)) return null;
	return { traitId: raw.traitId, roleId: raw.roleId, values: raw.values.filter((v): v is string => typeof v === "string") };
}

function normalizeBinding(raw: unknown): RoleBinding | null {
	if (!isObject(raw)) return null;
	if (BUILT_IN_FIELDS.includes(raw.field as BuiltInField)) return { field: raw.field as BuiltInField };
	if (typeof raw.propertyId !== "string" || (raw.direction !== "forward" && raw.direction !== "inverse")) return null;
	const values = isObject(raw.values) ? Object.fromEntries(Object.entries(raw.values).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
	return { propertyId: raw.propertyId, direction: raw.direction, values };
}

/** The well-formed traits. Bindings to types or properties gone since stay: they are read as none (see
 * `fittingBinding`), and the form shows them as not there any more. Data saved before traits (version 11) has none. */
function normalizeTraits(raw: unknown): Trait[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item: unknown, i) => {
		if (!isObject(item) || typeof item.id !== "string") return [];
		const byRoleOf = (byRole: Record<string, unknown>) =>
			Object.fromEntries(Object.entries(byRole).flatMap(([roleId, raw]) => {
				const binding = normalizeBinding(raw);
				return binding ? [[roleId, binding]] : [];
			}));
		const bindings = isObject(item.bindings)
			? Object.fromEntries(Object.entries(item.bindings).flatMap(([typeId, byRole]) => (isObject(byRole) ? [[typeId, byRoleOf(byRole)]] : [])))
			: {};
		return [
			{
				id: item.id,
				name: typeof item.name === "string" && item.name.trim() !== "" ? item.name : `Trait ${i + 1}`,
				roles: Array.isArray(item.roles) ? item.roles.flatMap(normalizeRole) : [],
				bindings,
			},
		];
	});
}

/** The traits' part of the app's data. */
export const TRAITS_PART: DataPart = { key: "traits", normalize: normalizeTraits };

/** Each trait is a unit of its own, with its roles and bindings. */
export const TRAIT_UNIT: UnitKind<AppData, Trait> = {
	kind: "trait",
	lists: (data) => [{ items: data.traits }],
	withList: (data, traits) => ({ ...data, traits }),
};
