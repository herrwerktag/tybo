import { referencedIds, type Analysis, type AppData, type Entity, type EntityType, type PathStep, type PropertyDef } from "./model.js";

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
