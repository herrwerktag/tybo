import { isUlid, ulid } from "./ulid.js";
import { clampZoom, defaultViewport, type Viewport } from "./viewport.js";
import {
	DEFAULT_CARD_SIZE,
	MIN_CARD_SIZE,
	PROPERTY_KINDS,
	entityTypeMap,
	migrateValues,
	type AppData,
	type CanvasCard,
	type CanvasData,
	type DraftProperty,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyValue,
} from "./model.js";

export type Store = ReturnType<typeof createStore>;

function emptyData(): AppData {
	return { types: [], entities: [], canvas: { cards: [], viewport: defaultViewport() } };
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Keeps only well-formed cards and viewport; anything else falls back to an empty canvas. */
function normalizeCanvas(canvas: Partial<CanvasData> | undefined): CanvasData {
	const cards = Array.isArray(canvas?.cards)
		? canvas.cards.filter(
				(c: Partial<CanvasCard>) =>
					typeof c.entityId === "string" && isNumber(c.x) && isNumber(c.y) && isNumber(c.width) && isNumber(c.height),
			)
		: [];
	const v = canvas?.viewport;
	const viewport = v && isNumber(v.x) && isNumber(v.y) && isNumber(v.zoom) ? { ...v, zoom: clampZoom(v.zoom) } : defaultViewport();
	return { cards, viewport };
}

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
		canvas: { ...data.canvas, cards: data.canvas.cards.filter((c) => entityTypes.has(c.entityId)) },
	};
}

/** Fills in fields that data saved by earlier versions may lack (e.g. number/boolean/date kinds, non-string values, entity names, ULIDs). */
function normalize(data: AppData): AppData {
	return {
		canvas: normalizeCanvas(data.canvas),
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
		return emptyData();
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
				...data,
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

		/** Puts an entity's card at (x, y) on top of the others, creating it with the default size if needed. */
		placeCard(entityId: string, x: number, y: number): void {
			const existing = data.canvas.cards.find((c) => c.entityId === entityId);
			const card: CanvasCard = { ...(existing ?? { entityId, ...DEFAULT_CARD_SIZE }), x, y };
			data = {
				...data,
				canvas: { ...data.canvas, cards: [...data.canvas.cards.filter((c) => c.entityId !== entityId), card] },
			};
			save();
		},

		resizeCard(entityId: string, width: number, height: number): void {
			const size = { width: Math.max(MIN_CARD_SIZE.width, width), height: Math.max(MIN_CARD_SIZE.height, height) };
			data = {
				...data,
				canvas: {
					...data.canvas,
					cards: data.canvas.cards.map((c) => (c.entityId === entityId ? { ...c, ...size } : c)),
				},
			};
			save();
		},

		/** Takes the card off the canvas; the entity itself stays. */
		removeCard(entityId: string): void {
			data = { ...data, canvas: { ...data.canvas, cards: data.canvas.cards.filter((c) => c.entityId !== entityId) } };
			save();
		},

		setViewport(viewport: Viewport): void {
			data = { ...data, canvas: { ...data.canvas, viewport: { ...viewport, zoom: clampZoom(viewport.zoom) } } };
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
