import { ulid, type DataPart, type UnitKind, type AppData } from "../../shared/core/index.js";
import { referencedIds, type Entity, type EntityType, type PropertyDef } from "../data/core.js";
import type { Store } from "../../features.core.js";

/**
 * Analyses: grouped listings of one type's entities, saved with the workspace. Their part of the app's data is
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
export interface PathStep {
	propertyId: string;
	direction: "forward" | "inverse";
}

/**
 * A grouped listing of one type's entities: each row is an entity of `typeId`, sorted into nested groups by
 * what the `groups` paths lead to from it (outermost first), with a column per path in `columns`. A path is a
 * chain of references, and may end in a text or options property.
 */
export interface Analysis {
	id: string;
	name: string;
	/** The type of the entities listed as rows; null until one is picked. */
	typeId: string | null;
	groups: PathStep[][];
	columns: PathStep[][];
}

/** A step a path can take from entities of some types, with what it leads to. */
export interface PathOption {
	step: PathStep;
	prop: PropertyDef;
	/** The type holding the property: one of the types stepped from (forward), or the referencing type (inverse). */
	ownerTypeId: string;
	/** The types of the entities reached; empty for a text or options property, which ends the path. */
	typeIds: string[];
}

const sameStep = (a: PathStep, b: PathStep) => a.propertyId === b.propertyId && a.direction === b.direction;

/**
 * The steps a path can take from entities of `fromTypeIds`, in type and property order: their own properties, then
 * every reference property (of any type) that can point at one of them.
 */
export function pathOptions(types: readonly EntityType[], fromTypeIds: readonly string[]): PathOption[] {
	const forward = types
		.filter((type) => fromTypeIds.includes(type.id))
		.flatMap((type) =>
			type.properties.map(
				(prop): PathOption => ({
					step: { propertyId: prop.id, direction: "forward" },
					prop,
					ownerTypeId: type.id,
					typeIds: prop.kind === "reference" ? [...(prop.reference?.typeIds ?? [])] : [],
				}),
			),
		);
	const inverse = types.flatMap((type) =>
		type.properties.flatMap((prop): PathOption[] =>
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
	/** The index of the first step that doesn't fit (its property is gone, or it follows a text or options
	 * property), or null when the whole path fits. */
	broken: number | null;
}

/** Reads `path` from entities of `typeId`, step by step. */
export function resolvePath(types: readonly EntityType[], typeId: string, path: readonly PathStep[]): ResolvedPath {
	const options: PathOption[] = [];
	let from = [typeId];
	for (const [index, step] of path.entries()) {
		const option = from.length > 0 ? pathOptions(types, from).find((o) => sameStep(o.step, step)) : undefined;
		if (!option) return { options, broken: index };
		options.push(option);
		from = option.typeIds;
	}
	return { options, broken: null };
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

/** Follows `path` from entities of `typeId`. A path that doesn't fit, or an empty one, leads to nothing. */
function pathFollower(data: Pick<AppData, "types" | "entities">, typeId: string, path: readonly PathStep[]): PathFollower {
	const { options, broken } = resolvePath(data.types, typeId, path);
	if (broken !== null || options.length === 0) return { follow: () => [], rank: () => 0 };
	const byId = new Map(data.entities.map((e) => [e.id, e]));
	const order = new Map(data.entities.map((e, i) => [e.id, i]));
	// The other side of the inverse steps' references: per referenced entity and property id, the entities referencing it.
	const referencing = new Map<string, Map<string, string[]>>();
	for (const option of options.filter((o) => o.step.direction === "inverse")) {
		for (const e of data.entities) {
			if (e.typeId !== option.ownerTypeId) continue;
			for (const id of referencedIds(option.prop, e.values[option.prop.id])) {
				const byProp = referencing.get(id) ?? new Map<string, string[]>();
				byProp.set(option.prop.id, [...(byProp.get(option.prop.id) ?? []), e.id]);
				referencing.set(id, byProp);
			}
		}
	}
	const last = options[options.length - 1]!;
	const endsInText = last.typeIds.length === 0;
	const optionOrder = last.prop.kind === "options" ? last.prop.options : [];
	const rank = (value: AnalysisValue) =>
		value.entityId !== null ? (order.get(value.entityId) ?? Number.MAX_SAFE_INTEGER) : unknownLast(optionOrder.indexOf(value.label));
	const follow = (entity: Entity): AnalysisValue[] => {
		let ids = [entity.id];
		for (const option of endsInText ? options.slice(0, -1) : options) {
			const next = ids.flatMap((id) => {
				const e = byId.get(id);
				if (!e) return [];
				if (option.step.direction === "inverse") return referencing.get(id)?.get(option.prop.id) ?? [];
				return e.typeId === option.ownerTypeId ? referencedIds(option.prop, e.values[option.prop.id]) : [];
			});
			ids = [...new Set(next)].filter((id) => byId.has(id) && option.typeIds.includes(byId.get(id)!.typeId));
		}
		if (endsInText) {
			const texts = ids.flatMap((id) => {
				const e = byId.get(id)!;
				const value = e.typeId === last.ownerTypeId ? e.values[last.prop.id] : null;
				return value === null || value === undefined ? [] : typeof value === "string" ? [value] : value;
			});
			const values = [...new Set(texts.filter((t) => t.trim() !== ""))].map((label) => ({ label, entityId: null }));
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
 * The analysis run on the data: every entity of the analysis's type as a row, in entity order, sorted into a
 * group per value each grouping path leads to (so in several groups when it leads to several; in a last group
 * with value null when it leads to none). Groups are in entity order, or in the order of the options; texts in the
 * order they first come up. Grouping paths that don't fit the types are left out.
 */
export function runAnalysis(data: Pick<AppData, "types" | "entities">, analysis: Analysis): AnalysisResult {
	const { typeId } = analysis;
	if (typeId === null || !data.types.some((t) => t.id === typeId)) return { count: 0, groups: [], rows: [] };
	const columns = analysis.columns.map((path) => pathFollower(data, typeId, path));
	const levels = analysis.groups
		.filter((path) => path.length > 0 && resolvePath(data.types, typeId, path).broken === null)
		.map((path) => pathFollower(data, typeId, path));
	const rows = data.entities
		.filter((e) => e.typeId === typeId)
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

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** A path's well-formed steps. */
function normalizePath(raw: unknown): PathStep[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((step: unknown) =>
		isObject(step) && typeof step.propertyId === "string" && (step.direction === "forward" || step.direction === "inverse")
			? [{ propertyId: step.propertyId, direction: step.direction }]
			: [],
	);
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
				groups: paths(item.groups),
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

/** Adds an analysis without a type yet. */
export function addAnalysis(store: Store, name: string): Analysis {
	const { data } = store;
	const item: Analysis = { id: ulid(), name: name.trim() || `Analysis ${data.analyses.length + 1}`, typeId: null, groups: [], columns: [] };
	store.change({ ...data, analyses: [...data.analyses, item] });
	return item;
}

/** Renames the analysis or sets its type, groups or columns; an empty name is ignored. */
export function updateAnalysis(store: Store, analysisId: string, patch: Partial<Omit<Analysis, "id">>): void {
	const { data } = store;
	const name = patch.name?.trim();
	store.change({
		...data,
		analyses: data.analyses.map((item) => (item.id === analysisId ? { ...item, ...patch, name: name || item.name } : item)),
	});
}

export function deleteAnalysis(store: Store, analysisId: string): void {
	const { data } = store;
	store.change({ ...data, analyses: data.analyses.filter((item) => item.id !== analysisId) });
}
