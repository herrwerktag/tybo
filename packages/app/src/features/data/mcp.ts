import { sameName, ulid, type AppData } from "../../shared/core/index.js";
import {
	CARD_DISPLAYS,
	LINE_ARROWS,
	PROPERTY_KINDS,
	TYPE_COLORS,
	entityTags,
	filterEntities,
	missingRequired,
	newReference,
	parseValue,
	placeholderProperty,
	referencedIds,
	validateType,
	type CardDisplay,
	type DraftProperty,
	type Entity,
	type EntityType,
	type LineArrow,
	type PropertyDef,
	type PropertyKind,
	type PropertyValue,
	type NewEntity,
	type ValidationError,
} from "./core.js";
import type { Store } from "../../features.core.js";
import { ToolError, WORKSPACE, json, object, record, text, texts, type Tool, type ToolContext } from "../../shared/mcp/index.js";

/** The tools on a workspace's types and entities: find and read them, make and change them. */
export function dataTools({ open, answerSaved }: ToolContext<Store>): Tool[] {
	return [
		{
			name: "find_entities",
			description:
				"Finds entities by type, by a part of their name (ignoring case and accents), by tag, and by property values " +
				"(`values`: property name → text it contains, option, or name/id of an entity it references; needs `type`), " +
				"and with `missing: true` to those lacking a required reference. " +
				"Answers id, type, name and tags of each (and the required references it lacks); get_entity tells the rest.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					type: { type: "string", description: "Name or id of the entity type." },
					query: { type: "string", description: "Part of the name." },
					tag: { type: "string" },
					values: { type: "object", additionalProperties: { type: "string" } },
					missing: { type: "boolean", description: "Only the entities lacking a required reference." },
					limit: { type: "integer", minimum: 1, description: "At most this many (default 50)." },
				},
				["workspace"],
			),
			async run(args) {
				const { data } = await open(args.workspace);
				const type = args.type === undefined ? null : typeOf(data, args.type);
				let found = filterEntities(data.entities, {
					query: args.query === undefined ? "" : text(args.query, "query"),
					typeId: type?.id ?? null,
					tag: args.tag === undefined ? null : text(args.tag, "tag"),
				});
				if (args.values !== undefined) {
					if (!type) throw new ToolError("Filtering by `values` needs a `type`.");
					for (const [name, wanted] of Object.entries(record(args.values, "values"))) {
						const prop = propertyOf(type, name);
						found = found.filter((e) => valueMatches(data, prop, e.values[prop.id], text(wanted, name)));
					}
				}
				const missing = (e: Entity) => missingRequired(data.types.find((t) => t.id === e.typeId), e).map((p) => p.name);
				if (args.missing === true) found = found.filter((e) => missing(e).length > 0);
				const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 50;
				return json({
					total: found.length,
					entities: found.slice(0, limit).map((e) => {
						const lacking = missing(e);
						return { id: e.id, type: typeName(data, e.typeId), name: e.name, tags: e.tags, ...(lacking.length > 0 ? { missing: lacking } : {}) };
					}),
				});
			},
		},
		{
			name: "get_entity",
			description:
				"One entity with everything about it: content, description, tags, its property values (references with the names " +
				"and ids of the entities they point to) and the entities that reference it.",
			inputSchema: object({ workspace: WORKSPACE, entity: ENTITY, type: TYPE_HINT }, ["workspace", "entity"]),
			async run(args) {
				const { data } = await open(args.workspace);
				const entity = entityOf(data, args.entity, args.type);
				return json({ ...describeEntity(data, entity), referencedBy: referencesTo(data, entity) });
			},
		},
		{
			name: "create_type",
			description:
				"Creates an entity type. Properties are text, options (with their `options`) or references (with `targets`: names of " +
				"the types they point to, `multiple` for several, `required` for at least one, `inverseLabel` for how the referenced entities show the reference). " +
				"A reference to the type itself is added afterwards with update_type. Without a `color`, the type gets the first one no other type has.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					name: { type: "string" },
					properties: { type: "array", items: PROPERTY },
					contentTemplate: { type: "string", description: "Description new entities of the type start with." },
					color: COLOR,
				},
				["workspace", "name"],
			),
			async run(args) {
				const store = await open(args.workspace);
				const name = text(args.name, "name");
				const properties = drafts(store.data, args.properties ?? [], []);
				check(store.data, name, properties, null);
				const template = args.contentTemplate === undefined ? "" : text(args.contentTemplate, "contentTemplate");
				const type = store.addType(name, properties, template, ...(args.color === undefined ? [] : [colorOf(args.color)]));
				return answerSaved(store, { type: describeType(store.data, type) });
			},
		},
		{
			name: "update_type",
			description:
				"Changes an entity type: its name, its color, its content template, or its properties. `properties` replaces the whole list: a " +
				"property keeps its values when it is listed with its id (or its current name), and what isn't given of it stays as it " +
				"is; a property left out is removed, together with its values on all entities — which needs `confirm: true`.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					type: { type: "string", description: "Name or id of the type." },
					name: { type: "string" },
					properties: { type: "array", items: { ...PROPERTY, properties: { id: { type: "string" }, ...PROPERTY.properties }, required: [] } },
					contentTemplate: { type: "string" },
					color: COLOR,
					confirm: { type: "boolean", description: "Needed when properties are left out, as they are removed with their values." },
				},
				["workspace", "type"],
			),
			async run(args) {
				const store = await open(args.workspace);
				const type = typeOf(store.data, args.type);
				const name = args.name === undefined ? type.name : text(args.name, "name");
				const properties = args.properties === undefined ? type.properties : drafts(store.data, args.properties, type.properties);
				check(store.data, name, properties, type.id);
				const removed = type.properties.filter((p) => !properties.some((d) => d.id === p.id));
				if (removed.length > 0 && args.confirm !== true) {
					const losing = store.data.entities.filter((e) => removed.some((p) => e.values[p.id] !== undefined && e.values[p.id] !== null)).length;
					throw new ToolError(
						`This removes ${removed.map((p) => `"${p.name}"`).join(", ")} from ${type.name}, with the values of ${losing} entities. ` +
							"List the properties to keep, or repeat with confirm: true.",
					);
				}
				const template = args.contentTemplate === undefined ? type.contentTemplate : text(args.contentTemplate, "contentTemplate");
				store.updateType(type.id, name, properties, template, args.color === undefined ? undefined : colorOf(args.color));
				return answerSaved(store, { type: describeType(store.data, typeOf(store.data, type.id)) });
			},
		},
		{
			name: "create_entity",
			description:
				"Creates an entity of a type. `values` maps property names to a text, an option, or the name/id of the entity a " +
				"reference points to (a list for references allowing several). Without a description it starts with the type's template.",
			inputSchema: object({ workspace: WORKSPACE, ...ENTITY_FIELDS }, ["workspace", "type", "name"]),
			async run(args) {
				const store = await open(args.workspace);
				const [entity] = store.addEntities([newEntity(store.data, args, store.data.entities)]);
				return answerSaved(store, { entity: describeEntity(store.data, entity!) });
			},
		},
		{
			name: "create_entities",
			description:
				"Creates several entities at once, each given as to create_entity (`type`, `name`, `content`, `description`, `tags`, `values`). " +
				"A reference may name another entity of the same call. All are checked first: one that doesn't fit, and none is created.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					entities: { type: "array", minItems: 1, items: object(ENTITY_FIELDS, ["type", "name"]) },
				},
				["workspace", "entities"],
			),
			async run(args) {
				const store = await open(args.workspace);
				if (!Array.isArray(args.entities) || args.entities.length === 0) throw new ToolError("`entities` must be a list of entities.");
				/** `run` on the `index`th entity given, its refusal saying which one it is about. */
				const at = <T>(index: number, run: () => T): T => {
					try {
						return run();
					} catch (error) {
						const item = (args.entities as unknown[])[index] as { name?: unknown } | null;
						throw error instanceof ToolError ? new ToolError(`entities[${index}] ("${String(item?.name)}"): ${error.message}`) : error;
					}
				};
				const given = args.entities.map((item, index) =>
					at(index, () => {
						const fields = record(item, `entities[${index}]`);
						return { fields, id: ulid(), typeId: typeOf(store.data, fields.type).id, name: text(fields.name, "name").trim() };
					}),
				);
				// What the references may point to: the entities there are, and the ones of this call.
				const candidates = [...store.data.entities, ...given];
				const items = given.map(({ fields, id }, index) => at(index, () => ({ ...newEntity(store.data, fields, candidates), id })));
				const created = store.addEntities(items);
				return answerSaved(store, {
					created: created.map((e) => {
						const { id, type, name, missing } = describeEntity(store.data, e);
						return { id, type, name, ...(missing ? { missing } : {}) };
					}),
				});
			},
		},
		{
			name: "update_entity",
			description:
				"Changes an entity. Only what is given changes; `values` sets the properties it names (null clears one) and leaves the " +
				"others as they are, `tags` replaces the tags.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					entity: ENTITY,
					type: TYPE_HINT,
					name: { type: "string" },
					content: { type: "string" },
					description: { type: "string" },
					tags: { type: "array", items: { type: "string" } },
					values: VALUES,
				},
				["workspace", "entity"],
			),
			async run(args) {
				const store = await open(args.workspace);
				const entity = entityOf(store.data, args.entity, args.type);
				const type = typeOf(store.data, entity.typeId);
				const name = args.name === undefined ? entity.name : text(args.name, "name");
				if (name.trim() === "") throw new ToolError("An entity needs a name.");
				const values = args.values === undefined ? {} : valuesOf(store.data, type, record(args.values, "values"));
				store.updateEntity(
					entity.id,
					name,
					args.content === undefined ? entity.content : text(args.content, "content"),
					{ ...entity.values, ...values },
					args.description === undefined ? undefined : text(args.description, "description"),
					args.tags === undefined ? undefined : texts(args.tags, "tags"),
				);
				return answerSaved(store, { entity: describeEntity(store.data, entityOf(store.data, entity.id)) });
			},
		},
		{
			name: "delete_entity",
			description: "Deletes an entity, with its cards on all boards and the references to it. Needs `confirm: true`.",
			inputSchema: object({ workspace: WORKSPACE, entity: ENTITY, type: TYPE_HINT, confirm: { type: "boolean" } }, ["workspace", "entity", "confirm"]),
			async run(args) {
				const store = await open(args.workspace);
				const entity = entityOf(store.data, args.entity, args.type);
				if (args.confirm !== true) throw new ToolError(`Deleting "${entity.name}" needs confirm: true.`);
				store.deleteEntity(entity.id);
				return answerSaved(store, { deleted: { id: entity.id, name: entity.name } });
			},
		},
	];
}

/** The types (with how many entities each has) and the tags in use, in describe_workspace. */
export function describeData(data: AppData): object {
	return {
		types: data.types.map((type) => ({ ...describeType(data, type), entities: data.entities.filter((e) => e.typeId === type.id).length })),
		tags: entityTags(data.entities),
	};
}

export const ENTITY = { type: "string", description: "Name or id of the entity." };
export const TYPE_HINT = { type: "string", description: "Name or id of the entity's type, when its name alone is ambiguous." };
const VALUES = {
	type: "object",
	description: "Property name → text, option, or name/id of a referenced entity (a list where several are allowed); null clears.",
	additionalProperties: { type: ["string", "array", "null"], items: { type: "string" } },
};
/** What create_entity and each entity of create_entities are given. */
const ENTITY_FIELDS = {
	type: { type: "string", description: "Name or id of the entity type." },
	name: { type: "string" },
	content: { type: "string", description: "Short text shown on the entity's cards." },
	description: { type: "string", description: "Longer text, Markdown." },
	tags: { type: "array", items: { type: "string" } },
	values: VALUES,
};
const PROPERTY = {
	type: "object",
	properties: {
		name: { type: "string" },
		kind: { type: "string", enum: ["text", "options", "reference"] },
		options: { type: "array", items: { type: "string" }, description: "For options: the allowed values." },
		targets: { type: "array", items: { type: "string" }, description: "For references: names or ids of the types pointed to." },
		multiple: { type: "boolean", description: "For references: whether several entities can be picked." },
		required: {
			type: "boolean",
			description: "For references: whether each entity should reference one. Not enforced; entities without one are listed as `missing`.",
		},
		inverseLabel: { type: "string", description: "For references: the label on the referenced entities; empty hides it there." },
		cardDisplay: { type: "string", enum: CARD_DISPLAYS, description: "How cards show it; line draws references as lines." },
		arrow: {
			type: "string",
			enum: LINE_ARROWS,
			description: "For references drawn as lines: the arrowhead at the referenced card (to, the default), at this one (from), or none.",
		},
		lineLabel: { type: "string", description: "For references drawn as lines: the text on the line; empty shows the property name." },
	},
	required: ["name", "kind"],
};
const COLOR = { type: "string", enum: TYPE_COLORS.map((c) => c.name), description: "The color of the type's cards." };

/** The palette color `raw` names (ignoring case), as the type form offers them. */
function colorOf(raw: unknown): string {
	const wanted = text(raw, "color");
	const color = TYPE_COLORS.find((c) => sameName(c.name, wanted));
	if (!color) throw new ToolError(`"${wanted}" isn't a color. Colors: ${TYPE_COLORS.map((c) => c.name).join(", ")}.`);
	return color.value;
}

export const typeName = (data: AppData, typeId: string | null) => data.types.find((t) => t.id === typeId)?.name ?? null;

/** The type `ref` names by id or name. */
export function typeOf(data: AppData, ref: unknown): EntityType {
	const wanted = text(ref, "type");
	const type = data.types.find((t) => t.id === wanted) ?? data.types.find((t) => sameName(t.name, wanted));
	if (!type) throw new ToolError(`There is no type "${wanted}". Types: ${data.types.map((t) => t.name).join(", ") || "none"}.`);
	return type;
}

/** The entity `ref` names by id, or by name (among the entities of `typeRef` when given). */
export function entityOf(data: AppData, ref: unknown, typeRef?: unknown): Entity {
	const wanted = text(ref, "entity");
	const byId = data.entities.find((e) => e.id === wanted);
	if (byId) return byId;
	const typeId = typeRef === undefined ? null : typeOf(data, typeRef).id;
	const named = data.entities.filter((e) => (typeId === null || e.typeId === typeId) && sameName(e.name, wanted));
	if (named.length === 1) return named[0]!;
	if (named.length === 0) throw new ToolError(`There is no entity "${wanted}"${typeId ? ` of type ${typeName(data, typeId)}` : ""}.`);
	const which = named.map((e) => `${e.id} (${typeName(data, e.typeId)})`).join(", ");
	throw new ToolError(`Several entities are called "${wanted}": ${which}. Name it by id, or give its type.`);
}

/** The property of `type` named `name` (ignoring case) or with that id. */
function propertyOf(type: EntityType, name: string): PropertyDef {
	const prop = type.properties.find((p) => p.id === name) ?? placeholderProperty(type, name);
	if (!prop) throw new ToolError(`${type.name} has no property "${name}". Properties: ${type.properties.map((p) => p.name).join(", ") || "none"}.`);
	return prop;
}

function describeType(data: AppData, type: EntityType) {
	return {
		id: type.id,
		name: type.name,
		// A color from before the palette, or chosen otherwise, as its value.
		color: TYPE_COLORS.find((c) => c.value === type.color.toLowerCase())?.name ?? type.color,
		properties: type.properties.map((p) => ({
			id: p.id,
			name: p.name,
			kind: p.kind,
			...(p.kind === "options" ? { options: p.options } : {}),
			...(p.reference
				? {
						targets: p.reference.typeIds.map((id) => typeName(data, id)),
						multiple: p.reference.multiple,
						required: p.reference.required,
						inverseLabel: p.reference.inverseLabel,
						arrow: p.reference.arrow,
						lineLabel: p.reference.lineLabel,
					}
				: {}),
			cardDisplay: p.cardDisplay,
		})),
		contentTemplate: type.contentTemplate,
	};
}

function describeEntity(data: AppData, entity: Entity) {
	const type = data.types.find((t) => t.id === entity.typeId);
	const values: Record<string, unknown> = {};
	for (const prop of type?.properties ?? []) {
		const value = entity.values[prop.id];
		if (value === undefined || value === null) continue;
		values[prop.name] = prop.kind === "reference" ? referencedIds(prop, value).map((id) => named(data, id)) : value;
	}
	const missing = missingRequired(type, entity).map((p) => p.name);
	return {
		id: entity.id,
		type: type?.name ?? null,
		name: entity.name,
		tags: entity.tags,
		content: entity.content,
		description: entity.description,
		values,
		...(missing.length > 0 ? { missing } : {}),
	};
}

export const named = (data: AppData, id: string) => ({ id, name: data.entities.find((e) => e.id === id)?.name ?? null });

/** Who references `entity`, per reference: its inverse label, or the referencing type and property. */
function referencesTo(data: AppData, entity: Entity) {
	return data.types.flatMap((type) =>
		type.properties.flatMap((prop) => {
			if (prop.kind !== "reference" || !prop.reference?.typeIds.includes(entity.typeId)) return [];
			const from = data.entities.filter((e) => e.typeId === type.id && referencedIds(prop, e.values[prop.id]).includes(entity.id));
			if (from.length === 0) return [];
			return [{ label: prop.reference.inverseLabel || `${type.name}.${prop.name}`, entities: from.map((e) => named(data, e.id)) }];
		}),
	);
}

/** Whether a value matches what `find_entities` was asked: a text containing it, the option, or a referenced entity
 * of that id or name. */
function valueMatches(data: AppData, prop: PropertyDef, value: PropertyValue | undefined, wanted: string): boolean {
	if (value === undefined || value === null) return false;
	if (prop.kind === "reference") {
		return referencedIds(prop, value).some((id) => id === wanted || sameName(data.entities.find((e) => e.id === id)?.name ?? "", wanted));
	}
	const values = typeof value === "string" ? [value] : value;
	return values.some((v) => (prop.kind === "options" ? sameName(v, wanted) : v.toLocaleLowerCase().includes(wanted.trim().toLocaleLowerCase())));
}

/** What a reference can name: an entity there is, or one about to be created. */
type Candidate = Pick<Entity, "id" | "typeId" | "name">;

/** The entity the model described (as create_entity is given it), checked; a reference names one of `entities`.
 * Without a description it starts with its type's template. */
function newEntity(data: AppData, given: Record<string, unknown>, entities: readonly Candidate[]): NewEntity {
	const type = typeOf(data, given.type);
	const name = text(given.name, "name");
	if (name.trim() === "") throw new ToolError("An entity needs a name.");
	return {
		typeId: type.id,
		name,
		content: given.content === undefined ? "" : text(given.content, "content"),
		values: given.values === undefined ? {} : valuesOf(data, type, record(given.values, "values"), entities),
		description: given.description === undefined ? type.contentTemplate : text(given.description, "description"),
		tags: given.tags === undefined ? [] : texts(given.tags, "tags"),
	};
}

/** The values the model gave, keyed by property id, each checked the way the entity form checks it; a reference
 * names one of `entities`. */
function valuesOf(
	data: AppData,
	type: EntityType,
	given: Record<string, unknown>,
	entities: readonly Candidate[] = data.entities,
): Record<string, PropertyValue> {
	const entityTypes = new Map(entities.map((e) => [e.id, e.typeId]));
	const values: Record<string, PropertyValue> = {};
	for (const [name, raw] of Object.entries(given)) {
		const prop = propertyOf(type, name);
		if (raw === null) {
			values[prop.id] = null;
			continue;
		}
		if (prop.kind !== "reference") {
			const value = parseValue(prop, text(raw, prop.name), entityTypes);
			if (value === null && text(raw, prop.name).trim() !== "") {
				throw new ToolError(`"${raw}" isn't an option of ${prop.name}. Options: ${prop.options.join(", ")}.`);
			}
			values[prop.id] = value;
			continue;
		}
		const refs = typeof raw === "string" ? [raw] : texts(raw, prop.name);
		if (refs.length > 1 && !prop.reference?.multiple) throw new ToolError(`${prop.name} references one entity only.`);
		const targets = prop.reference?.typeIds ?? [];
		const candidates = entities.filter((e) => targets.includes(e.typeId));
		const ids = refs.map((ref) => {
			const byId = candidates.find((e) => e.id === ref);
			if (byId) return byId.id;
			const found = candidates.filter((e) => sameName(e.name, ref));
			const kinds = targets.map((id) => typeName(data, id)).join(" or ");
			if (found.length === 0) throw new ToolError(`${prop.name} points to ${kinds}, and there is no such entity "${ref}".`);
			if (found.length > 1) throw new ToolError(`Several ${kinds} entities are called "${ref}": ${found.map((e) => e.id).join(", ")}. Name it by id.`);
			return found[0]!.id;
		});
		values[prop.id] = parseValue(prop, ids, entityTypes);
	}
	return values;
}

/** The properties the model listed, as the type form drafts them: one listed with the id or name of one of
 * `current` keeps that one's id and whatever of it isn't given. */
function drafts(data: AppData, raw: unknown, current: readonly PropertyDef[]): DraftProperty[] {
	if (!Array.isArray(raw)) throw new ToolError("`properties` must be a list.");
	return raw.map((item, index) => {
		const given = record(item, `properties[${index}]`);
		const was = (typeof given.id === "string" ? current.find((p) => p.id === given.id) : undefined) ??
			(typeof given.name === "string" ? current.find((p) => sameName(p.name, given.name as string)) : undefined);
		if (typeof given.id === "string" && !was) throw new ToolError(`There is no property with the id ${given.id}.`);
		const kind = (given.kind ?? was?.kind) as PropertyKind;
		if (!PROPERTY_KINDS.includes(kind)) throw new ToolError(`properties[${index}] needs a kind: ${PROPERTY_KINDS.join(", ")}.`);
		const cardDisplay = (given.cardDisplay ?? was?.cardDisplay ?? "list") as CardDisplay;
		if (!CARD_DISPLAYS.includes(cardDisplay)) throw new ToolError(`properties[${index}].cardDisplay is one of ${CARD_DISPLAYS.join(", ")}.`);
		const reference =
			kind !== "reference"
				? null
				: {
						...(was?.reference ?? newReference([])),
						...(given.targets === undefined ? {} : { typeIds: texts(given.targets, "targets").map((t) => typeOf(data, t).id) }),
						...(given.multiple === undefined ? {} : { multiple: given.multiple === true }),
						...(given.required === undefined ? {} : { required: given.required === true }),
						...(given.inverseLabel === undefined ? {} : { inverseLabel: text(given.inverseLabel, "inverseLabel") }),
						...(given.arrow === undefined ? {} : { arrow: arrowOf(given.arrow, index) }),
						...(given.lineLabel === undefined ? {} : { lineLabel: text(given.lineLabel, "lineLabel") }),
					};
		const draft: DraftProperty = {
			name: given.name === undefined ? (was?.name ?? "") : text(given.name, "name"),
			kind,
			options: given.options === undefined ? (was?.options ?? []) : texts(given.options, "options"),
			reference,
			cardDisplay,
		};
		return was ? { ...draft, id: was.id } : draft;
	});
}

/** Where the arrowhead of `properties[index]`'s line goes, as the model gave it. */
function arrowOf(raw: unknown, index: number): LineArrow {
	const arrow = raw as LineArrow;
	if (!LINE_ARROWS.includes(arrow)) throw new ToolError(`properties[${index}].arrow is one of ${LINE_ARROWS.join(", ")}.`);
	return arrow;
}

/** Refuses a type (the one of `selfId`, or a new one) the type form would refuse, saying why. */
function check(data: AppData, name: string, properties: DraftProperty[], selfId: string | null): void {
	const errors = validateType(name, properties, data.types, selfId);
	if (errors.length > 0) throw new ToolError(`The type can't be saved: ${errors.map(problem).join(" ")}`);
}

function problem(error: ValidationError): string {
	switch (error.code) {
		case "typeNameRequired":
			return "It needs a name.";
		case "typeNameTaken":
			return `There is a type "${error.label}" already.`;
		case "propertyNameRequired":
			return "Every property needs a name.";
		case "reservedName":
			return `"${error.label}" is reserved (id, name, content, description).`;
		case "duplicateName":
			return `"${error.label}" is there twice.`;
		case "optionsRequired":
			return `${error.label} needs options.`;
		case "emptyOption":
			return `${error.label} has an empty option.`;
		case "duplicateOptions":
			return `${error.label} has an option twice.`;
		case "referenceTypeRequired":
			return `${error.label} needs targets: types that exist.`;
	}
}
