import {
	entityTypeMap,
	migrateValues,
	parseValue,
	referencedIds,
	type Entity,
	type EntityData,
	type PropertyDef,
	type PropertyValue,
} from "./model.js";

/** Where one source property goes on conversion. An options value also names its target option. */
export interface ConversionAssignment {
	propertyId: string;
	optionId?: string;
}

/** Source property id → its destination; unlisted properties are not carried over. */
export type ConversionMapping = Readonly<Record<string, ConversionAssignment>>;

export interface ConversionValueLoss {
	property: PropertyDef;
	value: PropertyValue;
}

/** A reference held by another entity that no longer fits after the conversion. */
export interface ConversionReferenceLoss {
	entity: Entity;
	property: PropertyDef;
}

export interface ConversionPreview {
	/** Values keyed by the target type's property ids. */
	values: Record<string, PropertyValue>;
	lostValues: ConversionValueLoss[];
	lostReferences: ConversionReferenceLoss[];
}

const typesById = (data: EntityData) => new Map(data.types.map((type) => [type.id, type]));

/** The entity id → type id map after `entityId` has become `targetTypeId`, including for self-references. */
function convertedEntityTypes(data: EntityData, entityId: string, targetTypeId: string): Map<string, string> {
	const entityTypes = entityTypeMap(data);
	entityTypes.set(entityId, targetTypeId);
	return entityTypes;
}

/** Empty strings and arrays are no value, just as `parseValue` treats them. */
function hasValue(value: PropertyValue | undefined): value is string | string[] {
	return value !== null && value !== undefined && (typeof value === "string" ? value.trim() !== "" : value.length > 0);
}

/** Whether `value` fits the reference definition as a whole, rather than silently dropping or truncating part. */
function referenceFits(
	value: PropertyValue | undefined,
	target: PropertyDef,
	entityTypes: ReadonlyMap<string, string>,
	source: PropertyDef,
): boolean {
	if (target.kind !== "reference" || !target.reference) return false;
	const ids = referencedIds(source, value);
	if (!target.reference.multiple && ids.length > 1) return false;
	return ids.every((id) => target.reference!.typeIds.includes(entityTypes.get(id) ?? ""));
}

/** The target properties that can carry this source property's current value without changing its kind or dropping a reference. */
export function conversionTargets(
	data: EntityData,
	entityId: string,
	targetTypeId: string,
	source: PropertyDef,
): PropertyDef[] {
	const entity = data.entities.find((e) => e.id === entityId);
	const targetType = typesById(data).get(targetTypeId);
	if (!entity || !targetType || entity.typeId === targetTypeId) return [];
	const entityTypes = convertedEntityTypes(data, entityId, targetTypeId);
	const value = entity.values[source.id];
	return targetType.properties.filter((target) => {
		if (target.kind !== source.kind) return false;
		if (source.kind === "options") return target.options.length > 0;
		if (source.kind === "reference") return referenceFits(value, target, entityTypes, source);
		return true;
	});
}

/** The mapped value, or undefined when the assignment isn't valid for this source and target. Unset values stay unset. */
function convertedValue(
	source: PropertyDef,
	value: PropertyValue | undefined,
	target: PropertyDef,
	assignment: ConversionAssignment,
	entityTypes: ReadonlyMap<string, string>,
): PropertyValue | undefined {
	if (!hasValue(value) || source.kind !== target.kind || assignment.propertyId !== target.id) return undefined;
	if (source.kind === "reference") {
		if (!referenceFits(value, target, entityTypes, source)) return undefined;
		return parseValue(target, value, entityTypes) ?? undefined;
	}
	if (typeof value !== "string") return undefined;
	if (source.kind === "options") {
		if (!assignment.optionId || !target.options.some((option) => option.id === assignment.optionId)) return undefined;
		return assignment.optionId;
	}
	return parseValue(target, value) ?? undefined;
}

/**
 * Reads an entity against another type: compatible assigned values carry over, everything else is listed as lost.
 * Incoming references to it are kept by its stable id where their property allows the new type; the others are listed.
 * Null when the entity or another, distinct target type doesn't exist.
 */
export function conversionPreview(
	data: EntityData,
	entityId: string,
	targetTypeId: string,
	mapping: ConversionMapping,
): ConversionPreview | null {
	const entity = data.entities.find((e) => e.id === entityId);
	const types = typesById(data);
	const sourceType = entity ? types.get(entity.typeId) : undefined;
	const targetType = types.get(targetTypeId);
	if (!entity || !sourceType || !targetType || entity.typeId === targetTypeId) return null;
	const entityTypes = convertedEntityTypes(data, entityId, targetTypeId);
	const values: Record<string, PropertyValue> = {};
	const lostValues: ConversionValueLoss[] = [];
	const usedTargets = new Set<string>();

	for (const property of sourceType.properties) {
		const value = entity.values[property.id];
		if (!hasValue(value)) continue;
		const assignment = mapping[property.id];
		const target = assignment ? targetType.properties.find((p) => p.id === assignment.propertyId) : undefined;
		const converted =
			target && !usedTargets.has(target.id) ? convertedValue(property, value, target, assignment!, entityTypes) : undefined;
		if (target && converted !== undefined) {
			usedTargets.add(target.id);
			values[target.id] = converted;
		} else {
			lostValues.push({ property, value });
		}
	}

	const lostReferences: ConversionReferenceLoss[] = [];
	for (const other of data.entities) {
		if (other.id === entityId) continue; // its self-references are already covered by lostValues
		const otherType = types.get(other.typeId);
		for (const property of otherType?.properties ?? []) {
			if (
				property.kind === "reference" &&
				!property.reference?.typeIds.includes(targetTypeId) &&
				referencedIds(property, other.values[property.id]).includes(entityId)
			) {
				lostReferences.push({ entity: other, property });
			}
		}
	}

	return {
		values: migrateValues(values, targetType.properties, entityTypes),
		lostValues,
		lostReferences,
	};
}
