import { moveItem, refuseTakenName, ulid, type StoreCore } from "../../../shared/core/index.js";
import { reconcileValues } from "./normalize.js";
import {
	effectiveCardDisplay,
	nextTypeColor,
	parseTags,
	type DraftProperty,
	type Entity,
	type EntityData,
	type EntityType,
	type PropertyDef,
	type PropertyValue,
} from "./model.js";

/** An entity to add with `addEntities`; without an id it gets a new one. */
export interface NewEntity {
	id?: string;
	typeId: string;
	name: string;
	content: string;
	values: Record<string, PropertyValue>;
	description?: string;
	tags?: readonly string[];
}

function toPropertyDefs(properties: DraftProperty[]): PropertyDef[] {
	return properties.map((p) => ({
		id: p.id ?? ulid(),
		name: p.name.trim(),
		kind: p.kind,
		options: p.kind === "options" ? p.options.map((o) => o.trim()) : [],
		reference:
			p.kind === "reference" && p.reference
				? { ...p.reference, lineLabel: p.reference.lineLabel.trim(), inverseLabel: p.reference.inverseLabel.trim() }
				: null,
		cardDisplay: effectiveCardDisplay(p),
	}));
}

/**
 * The changes to the types and entities, on a store of data that holds them (`D`). `settle` puts right what the
 * data builds on them (e.g. the boards' cards of entities that are gone); the values are checked anew here.
 */
export function dataOps<D extends EntityData>(core: StoreCore<D>, settle: (data: D) => D = (data) => data) {
	const reconciled = (data: D): D => settle(reconcileValues(data));

	return {
		/** Without a color, the type gets the first palette color no other type uses. A name another type has is
		 * refused with a `NameTaken`. */
		addType(
			name: string,
			properties: DraftProperty[],
			contentTemplate: string,
			color = nextTypeColor(core.data.types.map((t) => t.color)),
		): EntityType {
			refuseTakenName("type", core.data.types, name);
			const type: EntityType = {
				id: ulid(),
				name: name.trim(),
				properties: toPropertyDefs(properties),
				contentTemplate,
				color,
			};
			core.change({ ...core.data, types: [...core.data.types, type] });
			return type;
		},

		/** Existing entities keep their content when the template changes. Without a color, the type keeps its own. A
		 * name another type has is refused with a `NameTaken`. */
		updateType(typeId: string, name: string, properties: DraftProperty[], contentTemplate: string, color?: string): void {
			refuseTakenName("type", core.data.types, name, typeId);
			const current = core.data.types.find((t) => t.id === typeId);
			const updated: EntityType = {
				id: typeId,
				name: name.trim(),
				properties: toPropertyDefs(properties),
				contentTemplate,
				color: color ?? current?.color ?? nextTypeColor(core.data.types.map((t) => t.color)),
			};
			core.change(reconciled({ ...core.data, types: core.data.types.map((t) => (t.id === typeId ? updated : t)) }));
		},

		deleteType(typeId: string): void {
			core.change(
				reconciled({
					...core.data,
					types: core.data.types.filter((t) => t.id !== typeId),
					entities: core.data.entities.filter((e) => e.typeId !== typeId),
				}),
			);
		},

		/** Moves the type to index `to` in the list of types. */
		moveType(typeId: string, to: number): void {
			const from = core.data.types.findIndex((t) => t.id === typeId);
			if (from < 0) return;
			core.change({ ...core.data, types: moveItem(core.data.types, from, to) });
		},

		addEntity(
			typeId: string,
			name: string,
			content: string,
			values: Record<string, PropertyValue>,
			description = "",
			tags: readonly string[] = [],
		): Entity {
			const entity: Entity = { id: ulid(), typeId, name: name.trim(), content, description, tags: parseTags(tags.join(",")), values };
			core.change({ ...core.data, entities: [...core.data.entities, entity] });
			return entity;
		},

		/** Adds several entities as one change — one save, one step to undo. One given with an id keeps it, so the
		 * others can already reference it. */
		addEntities(items: readonly NewEntity[]): Entity[] {
			const entities = items.map(
				(item): Entity => ({
					id: item.id ?? ulid(),
					typeId: item.typeId,
					name: item.name.trim(),
					content: item.content,
					description: item.description ?? "",
					tags: parseTags((item.tags ?? []).join(",")),
					values: item.values,
				}),
			);
			core.change({ ...core.data, entities: [...core.data.entities, ...entities] });
			return entities;
		},

		/** Without a description or tags, the entity keeps its current ones. */
		updateEntity(
			entityId: string,
			name: string,
			content: string,
			values: Record<string, PropertyValue>,
			description?: string,
			tags?: readonly string[],
		): void {
			core.change({
				...core.data,
				entities: core.data.entities.map((e) =>
					e.id === entityId
						? {
								...e,
								name: name.trim(),
								content,
								description: description ?? e.description,
								tags: tags ? parseTags(tags.join(",")) : e.tags,
								values,
							}
						: e,
				),
			});
		},

		/** Moves the entity to index `to` among the entities of its type; other types' entities keep their places. */
		moveEntity(entityId: string, to: number): void {
			const entity = core.data.entities.find((e) => e.id === entityId);
			if (!entity) return;
			const ofType = core.data.entities.filter((e) => e.typeId === entity.typeId);
			const reordered = moveItem(ofType, ofType.indexOf(entity), to);
			let next = 0;
			core.change({ ...core.data, entities: core.data.entities.map((e) => (e.typeId === entity.typeId ? reordered[next++]! : e)) });
		},

		deleteEntity(entityId: string): void {
			core.change(reconciled({ ...core.data, entities: core.data.entities.filter((e) => e.id !== entityId) }));
		},

		/** How many property values (across all entities) point to this entity. */
		referencesTo(entityId: string): number {
			let count = 0;
			for (const entity of core.data.entities) {
				for (const value of Object.values(entity.values)) {
					if (value === entityId || (Array.isArray(value) && value.includes(entityId))) count++;
				}
			}
			return count;
		},

		/** "Type.property" names of other types' reference properties that point to this type. */
		typeReferrers(typeId: string): string[] {
			return core.data.types
				.filter((t) => t.id !== typeId)
				.flatMap((t) =>
					t.properties.filter((p) => p.reference?.typeIds.includes(typeId)).map((p) => `${t.name}.${p.name}`),
				);
		},
	};
}
