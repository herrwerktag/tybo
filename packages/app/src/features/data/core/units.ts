import type { UnitKind } from "../../../shared/core/index.js";
import type { AppData } from "../../../legacy/core/model.js";
import type { Entity, EntityType } from "./model.js";

/** Each type is a unit of its own, with its properties. */
export const TYPE_UNIT: UnitKind<AppData, EntityType> = {
	kind: "type",
	lists: (data) => [{ items: data.types }],
	withList: (data, types) => ({ ...data, types }),
};

export const ENTITY_UNIT: UnitKind<AppData, Entity> = {
	kind: "entity",
	lists: (data) => [{ items: data.entities }],
	withList: (data, entities) => ({ ...data, entities }),
	// Entities of a type that went go with it.
	settle: (data) => {
		const types = new Set(data.types.map(({ id }) => id));
		return { ...data, entities: data.entities.filter((entity) => types.has(entity.typeId)) };
	},
};
