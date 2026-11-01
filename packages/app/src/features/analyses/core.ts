import { freeName, refuseTakenName, ulid, type DataPart, type UnitKind, type AppData } from "../../shared/core/index.js";
import { optionLabel, propertyReader, type Entity, type PropertyDef, type DataStore } from "../data/core.js";
import { bearingTypes, roleReader, roleTargetTypeIds, type RoleDef, type Trait } from "../traits/core.js";

/**
 * Analyses: grouped listings of one type's entities (or of a trait's), saved with the workspace. Their part of the app's data is
 * `analyses`, each one unit of its own.
 */
declare module "../../shared/core/data.js" {
	interface AppData {
		/** Saved analyses, in the order they were made. */
		analyses: Analysis[];
	}
}

/** One hop from an entity: one of its own properties (`forward`), or a reference property of another type
 * pointing at it (`inverse`, to the entities holding that reference). */
export interface PropertyStep {
	propertyId: string;
	direction: "forward" | "inverse";
}

/** One hop from an entity in an analysis of a trait: a role of a trait its type bears. */
export interface RoleStep {
	traitId: string;
	roleId: string;
}

export type PathStep = PropertyStep | RoleStep;

export const isRoleStep = (step: PathStep): step is RoleStep => "roleId" in step;

export const sameStep = (a: PathStep, b: PathStep) =>
	isRoleStep(a) || isRoleStep(b)
		? isRoleStep(a) && isRoleStep(b) && a.traitId === b.traitId && a.roleId === b.roleId
		: a.propertyId === b.propertyId && a.direction === b.direction;

/** A level of an analysis's grouping: the path its groups are by, and whether the rows it leads nowhere from are left
 * out of the whole analysis (rather than gathered in a last group without a value). */
export interface GroupLevel {
	path: PathStep[];
	hideEmpty: boolean;
}

/**
 * A grouped listing of one type's entities, or of the entities of every type bearing a trait: each row is an entity,
 * sorted into nested groups by what the `groups` levels' paths lead to from it (outermost first), with a column per
 * path in `columns`. A path is a chain of references (of a trait's roles, from a trait), and may end in a text or
 * options one.
 */
export interface Analysis {
	id: string;
	name: string;
	/** The type of the entities listed as rows; null until one is picked, or when the rows are a trait's. */
	typeId: string | null;
	/** The trait whose bearing types' entities are the rows; null when the rows are a type's. */
	traitId: string | null;
	groups: GroupLevel[];
	columns: PathStep[][];
}

/** Where a path stands: on entities stepping over the properties of these types, or (from a trait) over the roles of
 * these traits. */
export type PathFrom = { typeIds: string[] } | { traitIds: string[] };

/** What paths are read against. */
export type PathData = Pick<AppData, "types" | "traits">;

/** A step over a property, with what it leads to. */
export interface PropertyPathOption {
	step: PropertyStep;
	prop: PropertyDef;
	/** The type holding the property: one of the types stepped from (forward), or the referencing type (inverse). */
	ownerTypeId: string;
	/** The types of the entities reached; empty for a text or options property, which ends the path. */
	typeIds: string[];
}

/** A step over a role, with what it leads to. */
export interface RolePathOption {
	step: RoleStep;
	trait: Trait;
	role: RoleDef;
	/** The types of the entities reached; empty for a text or options role, which ends the path. */
	typeIds: string[];
}

/** A step a path can take from where it stands, with what it leads to. */
export type PathOption = PropertyPathOption | RolePathOption;

export const isRoleOption = (option: PathOption): option is RolePathOption => "role" in option;

/** Where a path stands after `option`: a role leads on to the roles of the traits the entities reached bear. */
function nextFrom(data: PathData, option: PathOption): PathFrom {
	if (!isRoleOption(option)) return { typeIds: option.typeIds };
	return { traitIds: data.traits.filter((t) => option.typeIds.some((id) => Object.hasOwn(t.bindings, id))).map((t) => t.id) };
}

/** Where the paths of an analysis start: its type, or its trait; null while it has neither (or it is gone). */
export function analysisFrom(data: PathData, analysis: Pick<Analysis, "typeId" | "traitId">): PathFrom | null {
	if (analysis.traitId !== null) return data.traits.some((t) => t.id === analysis.traitId) ? { traitIds: [analysis.traitId] } : null;
	if (analysis.typeId !== null) return data.types.some((t) => t.id === analysis.typeId) ? { typeIds: [analysis.typeId] } : null;
	return null;
}

/** The types of an analysis's rows: its type, or the types bearing its trait. */
export function rowTypeIds(data: PathData, analysis: Pick<Analysis, "typeId" | "traitId">): string[] {
	const from = analysisFrom(data, analysis);
	if (!from) return [];
	if ("typeIds" in from) return from.typeIds;
	return bearingTypes(data.types, data.traits.find((t) => t.id === from.traitIds[0])!).map((t) => t.id);
}

/**
 * The steps a path can take from where it stands, in type (trait) and property (role) order: from types, their own
 * properties, then every reference property (of any type) that can point at one of them; from traits, their roles.
 */
export function pathOptions(data: PathData, from: PathFrom): PathOption[] {
	if ("traitIds" in from) {
		return data.traits
			.filter((trait) => from.traitIds.includes(trait.id))
			.flatMap((trait) =>
				trait.roles.map((role): RolePathOption => ({ step: { traitId: trait.id, roleId: role.id }, trait, role, typeIds: roleTargetTypeIds(data.types, trait, role) })),
			);
	}
	const { types } = data;
	const fromTypeIds = from.typeIds;
	const forward = types
		.filter((type) => fromTypeIds.includes(type.id))
		.flatMap((type) =>
			type.properties.map(
				(prop): PropertyPathOption => ({
					step: { propertyId: prop.id, direction: "forward" },
					prop,
					ownerTypeId: type.id,
					typeIds: prop.kind === "reference" ? [...(prop.reference?.typeIds ?? [])] : [],
				}),
			),
		);
	const inverse = types.flatMap((type) =>
		type.properties.flatMap((prop): PropertyPathOption[] =>
			prop.kind === "reference" && prop.reference?.typeIds.some((id) => fromTypeIds.includes(id))
				? [{ step: { propertyId: prop.id, direction: "inverse" }, prop, ownerTypeId: type.id, typeIds: [type.id] }]
				: [],
		),
	);
	return [...forward, ...inverse];
}

/** A path read against the types: the option behind each step that fits, and where it stops fitting. */
export interface ResolvedPath {
	/** The options of the steps up to the first that doesn't fit. */
	options: PathOption[];
	/** The index of the first step that doesn't fit (its property or role is gone, or it follows a text or options
	 * one), or null when the whole path fits. */
	broken: number | null;
}

/** Reads `path` from where it starts, step by step. */
export function resolvePath(data: PathData, start: PathFrom, path: readonly PathStep[]): ResolvedPath {
	const options: PathOption[] = [];
	let from: PathFrom | null = start;
	for (const [index, step] of path.entries()) {
		const option: PathOption | undefined = from ? pathOptions(data, from).find((o) => sameStep(o.step, step)) : undefined;
		if (!option) return { options, broken: index };
		options.push(option);
		from = option.typeIds.length > 0 ? nextFrom(data, option) : null;
	}
	return { options, broken: null };
}

/** The steps a path can take after `path` (which fits), from where it starts; none when it ends in a text or options. */
export function nextOptions(data: PathData, start: PathFrom, path: readonly PathStep[], resolved = resolvePath(data, start, path)): PathOption[] {
	const last = resolved.options[resolved.options.length - 1];
	if (resolved.broken !== null) return [];
	if (!last) return pathOptions(data, start);
	return last.typeIds.length > 0 ? pathOptions(data, nextFrom(data, last)) : [];
}

/** What a path leads to: an entity, or a text or option (`entityId` null). */
export interface AnalysisValue {
	label: string;
	entityId: string | null;
}

export interface AnalysisRow {
	entity: Entity;
	/** Per column, the values its path leads to from the entity. */
	cells: AnalysisValue[][];
}

/** A group of rows, or of further groups: a group is either one level's groups or (the last level) rows. */
export interface AnalysisGroup {
	/** What the rows lead to on this level; null for the rows leading to nothing. */
	value: AnalysisValue | null;
	/** How many rows are in it, counting each once even when it is in several of its groups. */
	count: number;
	groups: AnalysisGroup[];
	rows: AnalysisRow[];
}

/** The rows (or groups, when there are grouping levels) of the analysis, all at one level of nesting. */
export interface AnalysisResult {
	count: number;
	groups: AnalysisGroup[];
	rows: AnalysisRow[];
}

/** A path as a function from an entity to the values it leads to, in entity (or option) order, each once; and the
 * rank of a value in that order (texts that aren't options all rank the same). */
interface PathFollower {
	follow: (entity: Entity) => AnalysisValue[];
	rank: (value: AnalysisValue) => number;
}

type AnalysisData = Pick<AppData, "types" | "entities" | "traits">;

/** What a step reads on an entity: the ids of the entities it leads to, or the option ids or texts it ends in. */
function stepReader(data: AnalysisData, option: PathOption): (entity: Entity) => string[] {
	if (isRoleOption(option)) return roleReader(data, option.trait, option.role.id);
	return propertyReader(data.entities, option.prop, option.ownerTypeId, option.step.direction);
}

/** Follows `path` from where it starts. A path that doesn't fit, or an empty one, leads to nothing. */
function pathFollower(data: AnalysisData, start: PathFrom, path: readonly PathStep[]): PathFollower {
	const { options, broken } = resolvePath(data, start, path);
	if (broken !== null || options.length === 0) return { follow: () => [], rank: () => 0 };
	const byId = new Map(data.entities.map((e) => [e.id, e]));
	const order = new Map(data.entities.map((e, i) => [e.id, i]));
	const readers = options.map((option) => stepReader(data, option));
	const last = options[options.length - 1]!;
	const endsInText = last.typeIds.length === 0;
	// An options end: the held ids become labels, ranked by the option's place.
	const ending = isRoleOption(last) ? last.role : last.prop;
	const optionRank = new Map(ending.kind === "options" ? ending.options.map((o, i) => [o.label, i] as const) : []);
	const rank = (value: AnalysisValue) =>
		value.entityId !== null ? (order.get(value.entityId) ?? Number.MAX_SAFE_INTEGER) : unknownLast(optionRank.get(value.label) ?? -1);
	const follow = (entity: Entity): AnalysisValue[] => {
		let ids = [entity.id];
		for (const [index, option] of options.entries()) {
			if (endsInText && index === options.length - 1) break;
			const next = ids.flatMap((id) => readers[index]!(byId.get(id)!));
			ids = [...new Set(next)].filter((id) => byId.has(id) && option.typeIds.includes(byId.get(id)!.typeId));
		}
		if (endsInText) {
			const held = ids.flatMap((id) => readers[options.length - 1]!(byId.get(id)!));
			const labels = ending.kind === "options" ? held.flatMap((id) => optionLabel(ending, id) ?? []) : held;
			const values = [...new Set(labels)].map((label) => ({ label, entityId: null }));
			return values.sort((a, b) => rank(a) - rank(b));
		}
		return ids.sort((a, b) => order.get(a)! - order.get(b)!).map((id) => ({ label: byId.get(id)!.name, entityId: id }));
	};
	return { follow, rank };
}

/** Texts that aren't (or no longer are) one of the property's options after the options. */
const unknownLast = (index: number) => (index < 0 ? Number.MAX_SAFE_INTEGER : index);

const valueKey = (value: AnalysisValue) => (value.entityId !== null ? `entity:${value.entityId}` : `text:${value.label}`);

/**
 * The analysis run on the data: every entity of the analysis's type (or of the types bearing its trait) as a row, in
 * entity order, sorted into a group per value each grouping path leads to (so in several groups when it leads to
 * several; in a last group with value null when it leads to none — or, where the level hides those, left out of the
 * whole analysis). Groups are in entity order, or in the order of the options; texts in the order they first come up.
 * Grouping levels whose paths don't fit are left out.
 */
export function runAnalysis(data: AnalysisData, analysis: Analysis): AnalysisResult {
	const from = analysisFrom(data, analysis);
	if (!from) return { count: 0, groups: [], rows: [] };
	const columns = analysis.columns.map((path) => pathFollower(data, from, path));
	const fitting = groupingLevels(data, from, analysis);
	const levels = fitting.map((level) => pathFollower(data, from, level.path));
	const hiding = levels.filter((_, i) => fitting[i]!.hideEmpty);
	const rowTypes = new Set(rowTypeIds(data, analysis));
	const rows = data.entities
		.filter((e) => rowTypes.has(e.typeId) && hiding.every((level) => level.follow(e).length > 0))
		.map((entity): AnalysisRow => ({ entity, cells: columns.map((column) => column.follow(entity)) }));

	const group = (rows: AnalysisRow[], level: number): AnalysisGroup[] => {
		if (level >= levels.length) return [];
		const groups = new Map<string, { value: AnalysisValue; rows: AnalysisRow[] }>();
		const none: AnalysisRow[] = [];
		for (const row of rows) {
			const values = levels[level]!.follow(row.entity);
			if (values.length === 0) none.push(row);
			for (const value of values) {
				const key = valueKey(value);
				const entry = groups.get(key) ?? { value, rows: [] };
				entry.rows.push(row);
				groups.set(key, entry);
			}
		}
		const sorted = [...groups.values()].sort((a, b) => levels[level]!.rank(a.value) - levels[level]!.rank(b.value));
		return [...sorted, ...(none.length > 0 ? [{ value: null, rows: none }] : [])].map((entry) => {
			const groups = group(entry.rows, level + 1);
			return { value: entry.value, count: entry.rows.length, groups, rows: groups.length > 0 ? [] : entry.rows };
		});
	};

	const groups = group(rows, 0);
	return { count: rows.length, groups, rows: groups.length > 0 ? [] : rows };
}

/** The analysis's grouping levels whose paths fit, the levels its result has. */
export function groupingLevels(data: PathData, from: PathFrom, analysis: Pick<Analysis, "groups">): GroupLevel[] {
	return analysis.groups.filter(({ path }) => path.length > 0 && resolvePath(data, from, path).broken === null);
}

/** The paths of the analysis's grouping levels that fit (see `groupingLevels`). */
export function groupingPaths(data: PathData, from: PathFrom, analysis: Pick<Analysis, "groups">): PathStep[][] {
	return groupingLevels(data, from, analysis).map((level) => level.path);
}

/** A grouping level, well-formed: a path as it was before levels hid rows (version 12) shows all of them. */
export function normalizeLevel(raw: unknown): GroupLevel {
	if (Array.isArray(raw)) return { path: normalizePath(raw), hideEmpty: false };
	return isObject(raw) ? { path: normalizePath(raw.path), hideEmpty: raw.hideEmpty === true } : { path: [], hideEmpty: false };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** A path's well-formed steps. */
function normalizePath(raw: unknown): PathStep[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((step: unknown): PathStep[] => {
		if (!isObject(step)) return [];
		if (typeof step.traitId === "string" && typeof step.roleId === "string") return [{ traitId: step.traitId, roleId: step.roleId }];
		return typeof step.propertyId === "string" && (step.direction === "forward" || step.direction === "inverse")
			? [{ propertyId: step.propertyId, direction: step.direction }]
			: [];
	});
}

/** The well-formed analyses, each with only well-formed paths. Steps whose property is gone stay: the analysis shows
 * them as not fitting, so they can be fixed. Data saved before analyses (version 7) has none. */
function normalizeAnalyses(raw: unknown): Analysis[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item: unknown, i) => {
		if (!isObject(item) || typeof item.id !== "string") return [];
		const paths = (value: unknown) => (Array.isArray(value) ? value.map(normalizePath) : []);
		return [
			{
				id: item.id,
				name: typeof item.name === "string" && item.name.trim() !== "" ? item.name : `Analysis ${i + 1}`,
				typeId: typeof item.typeId === "string" ? item.typeId : null,
				// Analyses of a trait came with version 11; those before are of a type.
				traitId: typeof item.traitId === "string" ? item.traitId : null,
				groups: Array.isArray(item.groups) ? item.groups.map(normalizeLevel) : [],
				columns: paths(item.columns),
			},
		];
	});
}

/** The analyses' part of the app's data. */
export const ANALYSES_PART: DataPart = { key: "analyses", normalize: normalizeAnalyses };

/** Each analysis is a unit of its own, with its paths. */
export const ANALYSIS_UNIT: UnitKind<AppData, Analysis> = {
	kind: "analysis",
	lists: (data) => [{ items: data.analyses }],
	withList: (data, analyses) => ({ ...data, analyses }),
};

/** Adds an analysis without a type yet. Without a name, it is "Analysis n" of the first number free; a name another
 * analysis has is refused with a `NameTaken`. */
export function addAnalysis(store: DataStore, name: string): Analysis {
	const { data } = store;
	refuseTakenName("analysis", data.analyses, name);
	const item: Analysis = { id: ulid(), name: name.trim() || freeName(data.analyses, (n) => `Analysis ${n}`), typeId: null, traitId: null, groups: [], columns: [] };
	store.change({ ...data, analyses: [...data.analyses, item] });
	return item;
}

/** Renames the analysis or sets its type or trait, groups or columns; an empty name is ignored, one another analysis has is
 * refused with a `NameTaken`. */
export function updateAnalysis(store: DataStore, analysisId: string, patch: Partial<Omit<Analysis, "id">>): void {
	const { data } = store;
	const name = patch.name?.trim();
	if (name) refuseTakenName("analysis", data.analyses, name, analysisId);
	store.change({
		...data,
		analyses: data.analyses.map((item) => (item.id === analysisId ? { ...item, ...patch, name: name || item.name } : item)),
	});
}

export function deleteAnalysis(store: DataStore, analysisId: string): void {
	const { data } = store;
	store.change({ ...data, analyses: data.analyses.filter((item) => item.id !== analysisId) });
}
