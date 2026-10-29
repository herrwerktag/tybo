import { isUlid, ulid } from "../../../shared/core/index.js";
import {
	CARD_DISPLAYS,
	LINE_ARROWS,
	PROPERTY_KINDS,
	effectiveCardDisplay,
	entityTypeMap,
	migrateValues,
	nextTypeColor,
	parseTags,
	type Entity,
	type EntityData,
	type EntityType,
	type PropertyDef,
	type PropertyValue,
	type ReferenceDef,
} from "./model.js";

const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads `cardDisplay`, or converts the `showOnCard` checkbox saved by the previous version. */
function cardDisplayFor(prop: PropertyDef, showOnCard: unknown): PropertyDef["cardDisplay"] {
	if (CARD_DISPLAYS.includes(prop.cardDisplay)) return effectiveCardDisplay(prop);
	return showOnCard === false ? "hidden" : "list";
}

/** Fills in a reference's defaults, and reads the single `typeId` saved before it could target several types. */
function normalizeReference({ typeId, ...reference }: ReferenceDef & { typeId?: unknown }): ReferenceDef {
	return {
		...reference,
		typeIds: Array.isArray(reference.typeIds)
			? reference.typeIds.filter((id) => typeof id === "string")
			: typeof typeId === "string"
				? [typeId]
				: [],
		required: reference.required === true,
		arrow: LINE_ARROWS.includes(reference.arrow) ? reference.arrow : "to",
		lineLabel: typeof reference.lineLabel === "string" ? reference.lineLabel : "",
		inverseLabel: typeof reference.inverseLabel === "string" ? reference.inverseLabel : "",
	};
}

/**
 * Drops types and properties without a string id and name, and entities without a type id, one by one, so a
 * single malformed item never costs the rest. Missing property lists and values become empty.
 */
export function keepWellFormed<D extends EntityData>(data: D): D {
	return {
		...data,
		types: data.types.flatMap((type: unknown) => {
			if (!isObject(type) || typeof type.id !== "string" || typeof type.name !== "string") return [];
			const properties = Array.isArray(type.properties)
				? type.properties.filter((p: unknown) => isObject(p) && typeof p.id === "string" && typeof p.name === "string")
				: [];
			return [{ ...(type as unknown as EntityType), properties }];
		}),
		entities: data.entities.flatMap((entity: unknown) => {
			if (!isObject(entity) || typeof entity.typeId !== "string") return [];
			return [{ ...(entity as unknown as Entity), values: isObject(entity.values) ? (entity.values as Entity["values"]) : {} }];
		}),
	};
}

/** Fills in fields of the types and entities that data saved by earlier versions may lack (e.g. number/boolean/date
 * kinds, non-string values, entity names, ULIDs). */
export function normalizeEntityData(data: EntityData): EntityData {
	// Types saved before colors existed get the next free palette colors, in order.
	const usedColors = data.types.map((t) => t.color).filter(isColor);
	const colorFor = (color: unknown) => {
		if (isColor(color)) return color;
		const next = nextTypeColor(usedColors);
		usedColors.push(next);
		return next;
	};
	return {
		types: data.types.map((type) => ({
			...type,
			color: colorFor(type.color),
			contentTemplate: typeof type.contentTemplate === "string" ? type.contentTemplate : "",
			properties: type.properties.map(({ showOnCard, ...prop }: PropertyDef & { showOnCard?: unknown }) => ({
				...prop,
				kind: PROPERTY_KINDS.includes(prop.kind) ? prop.kind : "text",
				options: Array.isArray(prop.options) ? prop.options : [],
				reference: prop.reference ? normalizeReference(prop.reference) : null,
				cardDisplay: cardDisplayFor(prop, showOnCard),
			})),
		})),
		entities: data.entities.map((entity) => {
			const values = Object.fromEntries(
				Object.entries(entity.values).map(([key, value]): [string, PropertyValue] => [
					key,
					value === null || value === undefined ? null : Array.isArray(value) ? value.map(String) : String(value),
				]),
			);
			const propIds = data.types.find((t) => t.id === entity.typeId)?.properties.map((p) => p.id) ?? [];
			const name =
				typeof entity.name === "string"
					? entity.name
					: (propIds.map((id) => values[id]).find((v) => typeof v === "string") ?? "Untitled");
			const content = typeof entity.content === "string" ? entity.content : "";
			const description = typeof entity.description === "string" ? entity.description : "";
			const tags = Array.isArray(entity.tags) ? parseTags(entity.tags.filter((t) => typeof t === "string").join(",")) : [];
			return { ...entity, id: isUlid(entity.id) ? entity.id : ulid(), name, content, description, tags, values };
		}),
	};
}

/** The entities with their values checked anew against their types' current properties, e.g. dropping references to
 * deleted entities. */
export function reconcileValues<D extends EntityData>(data: D): D {
	const entityTypes = entityTypeMap(data);
	const typesById = new Map(data.types.map((t) => [t.id, t]));
	return {
		...data,
		entities: data.entities.map((e) => ({
			...e,
			values: migrateValues(e.values, typesById.get(e.typeId)?.properties ?? [], entityTypes),
		})),
	};
}
