import { isUlid, ulid } from "./ulid.js";
import {
	PROPERTY_KINDS,
	entityTypeMap,
	migrateValues,
	type AppData,
	type DraftProperty,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyValue,
} from "./model.js";

export type Store = ReturnType<typeof createStore>;

/** Re-validates every entity's values against its type's current properties, e.g. dropping references to deleted entities. */
function reconcile(data: AppData): AppData {
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

/** Fills in fields that data saved by earlier versions may lack (e.g. number/boolean/date kinds, non-string values, entity names, ULIDs). */
function normalize(data: AppData): AppData {
	return {
		types: data.types.map((type) => ({
			...type,
			contentTemplate: typeof type.contentTemplate === "string" ? type.contentTemplate : "",
			properties: type.properties.map((prop) => ({
				...prop,
				kind: PROPERTY_KINDS.includes(prop.kind) ? prop.kind : "text",
				options: Array.isArray(prop.options) ? prop.options : [],
				reference: prop.reference ?? null,
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
			return { ...entity, id: isUlid(entity.id) ? entity.id : ulid(), name, content, values };
		}),
	};
}

function toPropertyDefs(properties: DraftProperty[]): PropertyDef[] {
	return properties.map((p) => ({
		id: p.id ?? crypto.randomUUID(),
		name: p.name.trim(),
		kind: p.kind,
		options: p.kind === "options" ? p.options.map((o) => o.trim()) : [],
		reference: p.kind === "reference" && p.reference ? { ...p.reference } : null,
	}));
}

export function createStore(storage: Pick<Storage, "getItem" | "setItem">, key = "entities-app") {
	let data = load();

	function load(): AppData {
		try {
			const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
			if (
				parsed &&
				typeof parsed === "object" &&
				Array.isArray((parsed as AppData).types) &&
				Array.isArray((parsed as AppData).entities)
			) {
				return reconcile(normalize(parsed as AppData));
			}
		} catch {
			// Unreadable or corrupt storage: start fresh.
		}
		return { types: [], entities: [] };
	}

	function save(): void {
		try {
			storage.setItem(key, JSON.stringify(data));
		} catch {
			// Storage full or blocked: keep working in memory.
		}
	}

	return {
		get data(): AppData {
			return data;
		},

		addType(name: string, properties: DraftProperty[], contentTemplate: string): EntityType {
			const type: EntityType = {
				id: crypto.randomUUID(),
				name: name.trim(),
				properties: toPropertyDefs(properties),
				contentTemplate,
			};
			data = { ...data, types: [...data.types, type] };
			save();
			return type;
		},

		/** Existing entities keep their content when the template changes. */
		updateType(typeId: string, name: string, properties: DraftProperty[], contentTemplate: string): void {
			const updated: EntityType = { id: typeId, name: name.trim(), properties: toPropertyDefs(properties), contentTemplate };
			data = reconcile({ ...data, types: data.types.map((t) => (t.id === typeId ? updated : t)) });
			save();
		},

		deleteType(typeId: string): void {
			data = reconcile({
				types: data.types.filter((t) => t.id !== typeId),
				entities: data.entities.filter((e) => e.typeId !== typeId),
			});
			save();
		},

		addEntity(typeId: string, name: string, content: string, values: Record<string, PropertyValue>): Entity {
			const entity: Entity = { id: ulid(), typeId, name: name.trim(), content, values };
			data = { ...data, entities: [...data.entities, entity] };
			save();
			return entity;
		},

		updateEntity(entityId: string, name: string, content: string, values: Record<string, PropertyValue>): void {
			data = {
				...data,
				entities: data.entities.map((e) => (e.id === entityId ? { ...e, name: name.trim(), content, values } : e)),
			};
			save();
		},

		deleteEntity(entityId: string): void {
			data = reconcile({ ...data, entities: data.entities.filter((e) => e.id !== entityId) });
			save();
		},

		/** How many property values (across all entities) point to this entity. */
		referencesTo(entityId: string): number {
			let count = 0;
			for (const entity of data.entities) {
				for (const value of Object.values(entity.values)) {
					if (value === entityId || (Array.isArray(value) && value.includes(entityId))) count++;
				}
			}
			return count;
		},

		/** "Type.property" names of other types' reference properties that point to this type. */
		typeReferrers(typeId: string): string[] {
			return data.types
				.filter((t) => t.id !== typeId)
				.flatMap((t) =>
					t.properties.filter((p) => p.reference?.typeId === typeId).map((p) => `${t.name}.${p.name}`),
				);
		},
	};
}
