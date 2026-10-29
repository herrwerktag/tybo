import {
	BOARD_UNIT,
	CARD_UNIT,
	DRAWING_UNIT,
	ENTITY_UNIT,
	TYPE_UNIT,
	jsonEqual,
	type AppData,
	type BoardMeta,
	type CanvasCard,
	type Drawing,
	type Entity,
	type EntityType,
	type UnitStand,
} from "../core/index.js";
import { groupBy, jsonbParameter, json, parsed, plain, type Rows, type UnitStorage } from "../../shared/api/index.js";

/** How a kind of unit of the app's data is kept. */
type AppStorage<T extends { id: string }, R> = UnitStorage<T, R, AppData>;

/** Types with their properties: a row each, the properties in a table of their own. */
export const TYPE_STORAGE: AppStorage<EntityType, { types: Rows; properties: Rows }> = {
	unit: TYPE_UNIT,
	table: "entity_types",
	async readPostgres(queries, ws) {
		const [types, properties] = await Promise.all([
			queries`select id, name, content_template, color from entity_types where workspace_id = ${ws} order by position, id`,
			queries`select id, type_id, name, kind, options, reference, card_display from properties where workspace_id = ${ws} order by type_id, position, id`,
		]);
		return { types, properties };
	},
	readSqlite: (all) => ({
		types: all("select id, name, content_template, color from entity_types where workspace_id = ? order by position, id"),
		properties: all(
			"select id, type_id, name, kind, options, reference, card_display from properties where workspace_id = ? order by type_id, position, id",
		).map((row) => ({ ...row, options: parsed(row.options), reference: parsed(row.reference) })),
	}),
	assemble(data, { types, properties }) {
		const propertiesOf = groupBy(properties, "type_id", (property) => ({
			id: property.id,
			name: property.name,
			kind: property.kind,
			options: property.options ?? [],
			reference: property.reference ?? null,
			cardDisplay: property.card_display,
		}));
		return {
			...data,
			types: types.map(({ id, name, content_template, color }) => ({
				id,
				name,
				properties: propertiesOf.get(id) ?? [],
				contentTemplate: content_template,
				color,
			})),
		};
	},
	async writePostgres(tx, ws, { value: type, position }) {
		await tx`insert into entity_types (workspace_id, id, position, name, content_template, color, updated_at)
			values (${ws}, ${type.id}, ${position}, ${type.name}, ${type.contentTemplate}, ${type.color}, now())
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name,
				content_template = excluded.content_template, color = excluded.color, updated_at = now()`;
		const properties = type.properties ?? [];
		// Properties the type no longer has lose their rows — their values go with them, the tables'
		// references take care of what hangs below a property (or its type) going away.
		if (properties.length === 0) await tx`delete from properties where workspace_id = ${ws} and type_id = ${type.id}`;
		else
			await tx`delete from properties
				where workspace_id = ${ws} and type_id = ${type.id} and id <> all(${properties.map((p) => p.id)})`;
		for (const [index, property] of properties.entries()) {
			await tx`insert into properties (workspace_id, id, type_id, position, name, kind, options, reference, card_display)
				values (${ws}, ${property.id}, ${type.id}, ${index}, ${property.name}, ${property.kind},
					${jsonbParameter(tx, property.options)}, ${jsonbParameter(tx, property.reference)}, ${property.cardDisplay})
				on conflict (workspace_id, id) do update set
					type_id = excluded.type_id, position = excluded.position, name = excluded.name,
					kind = excluded.kind, options = excluded.options, reference = excluded.reference,
					card_display = excluded.card_display`;
		}
	},
	writeSqlite(run, ws, { value: type, position }) {
		run(
			`insert into entity_types (workspace_id, id, position, name, content_template, color, updated_at)
			values (?, ?, ?, ?, ?, ?, current_timestamp)
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name,
				content_template = excluded.content_template, color = excluded.color, updated_at = current_timestamp`,
			ws, type.id, position, plain(type.name), plain(type.contentTemplate), plain(type.color),
		);
		const properties = type.properties ?? [];
		run(
			"delete from properties where workspace_id = ? and type_id = ? and id not in (select value from json_each(?))",
			ws, type.id, JSON.stringify(properties.map((p) => p.id)),
		);
		for (const [index, property] of properties.entries()) {
			run(
				`insert into properties (workspace_id, id, type_id, position, name, kind, options, reference, card_display)
				values (?, ?, ?, ?, ?, ?, ?, ?, ?)
				on conflict (workspace_id, id) do update set
					type_id = excluded.type_id, position = excluded.position, name = excluded.name,
					kind = excluded.kind, options = excluded.options, reference = excluded.reference,
					card_display = excluded.card_display`,
				ws, property.id, type.id, index, plain(property.name), plain(property.kind),
				json(property.options), json(property.reference), plain(property.cardDisplay),
			);
		}
	},
};

/** Entities with their values: a row each, the values in a table of their own. */
export const ENTITY_STORAGE: AppStorage<Entity, { entities: Rows; values: Rows }> = {
	unit: ENTITY_UNIT,
	table: "entities",
	async readPostgres(queries, ws) {
		const [entities, values] = await Promise.all([
			queries`select id, type_id, name, content, description, tags from entities where workspace_id = ${ws} order by position, id`,
			queries`select entity_id, property_id, value from entity_values where workspace_id = ${ws} order by entity_id, position, property_id`,
		]);
		return { entities, values };
	},
	readSqlite: (all) => ({
		entities: all("select id, type_id, name, content, description, tags from entities where workspace_id = ? order by position, id").map(
			(row) => ({ ...row, tags: parsed(row.tags) }),
		),
		values: all("select entity_id, property_id, value from entity_values where workspace_id = ? order by entity_id, position, property_id").map(
			(row) => ({ ...row, value: parsed(row.value) }),
		),
	}),
	assemble(data, { entities, values }) {
		const valuesOf = new Map<string, Record<string, unknown>>();
		for (const { entity_id, property_id, value } of values) {
			const record = valuesOf.get(entity_id) ?? {};
			record[property_id] = value;
			valuesOf.set(entity_id, record);
		}
		return {
			...data,
			entities: entities.map(({ id, type_id, name, content, description, tags }) => ({
				id,
				typeId: type_id,
				name,
				content,
				description,
				tags: tags ?? [],
				values: (valuesOf.get(id) ?? {}) as Entity["values"],
			})),
		};
	},
	async writePostgres(tx, ws, { value: entity, position }) {
		await tx`insert into entities (workspace_id, id, type_id, position, name, content, description, tags, updated_at)
			values (${ws}, ${entity.id}, ${entity.typeId}, ${position}, ${entity.name}, ${entity.content}, ${entity.description},
				${jsonbParameter(tx, entity.tags ?? [])}, now())
			on conflict (workspace_id, id) do update set
				type_id = excluded.type_id, position = excluded.position, name = excluded.name,
				content = excluded.content, description = excluded.description, tags = excluded.tags, updated_at = now()`;
		// The values the entity no longer has lose their rows; the ones it has are written — the place
		// is the record's own order, the read assembles the record either way.
		const values = Object.entries(entity.values ?? {});
		if (values.length === 0) await tx`delete from entity_values where workspace_id = ${ws} and entity_id = ${entity.id}`;
		else
			await tx`delete from entity_values
				where workspace_id = ${ws} and entity_id = ${entity.id} and property_id <> all(${values.map(([propertyId]) => propertyId)})`;
		for (const [index, [propertyId, value]] of values.entries()) {
			await tx`insert into entity_values (workspace_id, entity_id, property_id, position, value)
				values (${ws}, ${entity.id}, ${propertyId}, ${index}, ${jsonbParameter(tx, value)})
				on conflict (workspace_id, entity_id, property_id) do update set position = excluded.position, value = excluded.value`;
		}
	},
	writeSqlite(run, ws, { value: entity, position }) {
		run(
			`insert into entities (workspace_id, id, type_id, position, name, content, description, tags, updated_at)
			values (?, ?, ?, ?, ?, ?, ?, ?, current_timestamp)
			on conflict (workspace_id, id) do update set
				type_id = excluded.type_id, position = excluded.position, name = excluded.name,
				content = excluded.content, description = excluded.description, tags = excluded.tags, updated_at = current_timestamp`,
			ws, entity.id, entity.typeId, position, plain(entity.name), plain(entity.content), plain(entity.description),
			json(entity.tags ?? []),
		);
		const values = Object.entries(entity.values ?? {});
		run(
			"delete from entity_values where workspace_id = ? and entity_id = ? and property_id not in (select value from json_each(?))",
			ws, entity.id, JSON.stringify(values.map(([propertyId]) => propertyId)),
		);
		for (const [index, [propertyId, value]] of values.entries()) {
			run(
				`insert into entity_values (workspace_id, entity_id, property_id, position, value)
				values (?, ?, ?, ?, ?)
				on conflict (workspace_id, entity_id, property_id) do update set position = excluded.position, value = excluded.value`,
				ws, entity.id, propertyId, index, json(value),
			);
		}
	},
};

/** Whether two stands of a board differ in nothing but its viewport — same place, same name, same frame. */
function onlyViewport(before: UnitStand<BoardMeta> | null, after: UnitStand<BoardMeta> | null): boolean {
	if (before === null || after === null || before.position !== after.position) return false;
	const { viewport: _was, ...was } = before.value;
	const { viewport: _now, ...now } = after.value;
	return jsonEqual(was, now);
}

export const BOARD_STORAGE: AppStorage<BoardMeta, Rows> = {
	unit: BOARD_UNIT,
	table: "boards",
	readPostgres: (queries, ws) => queries`select id, name, viewport, view_frame from boards where workspace_id = ${ws} order by position, id`,
	readSqlite: (all) =>
		all("select id, name, viewport, view_frame from boards where workspace_id = ? order by position, id").map((row) => ({
			...row,
			viewport: parsed(row.viewport),
			view_frame: parsed(row.view_frame),
		})),
	// The frame is null on boards saved before frames (JSON keeps a null, unlike a missing value, so a save's
	// `before` still matches): the app makes it of the board's pan/zoom. Cards and drawings are put in by their own kinds.
	assemble: (data, boards) => ({
		...data,
		boards: boards.map(({ id, name, viewport, view_frame }) => ({ id, name, viewport, viewFrame: view_frame ?? null }) as AppData["boards"][number]),
	}),
	async writePostgres(tx, ws, { value: board, position }) {
		await tx`insert into boards (workspace_id, id, position, name, viewport, view_frame, updated_at)
			values (${ws}, ${board.id}, ${position}, ${board.name}, ${jsonbParameter(tx, board.viewport)},
				${jsonbParameter(tx, board.viewFrame ?? null)}, now())
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name, viewport = excluded.viewport, view_frame = excluded.view_frame,
				updated_at = now()`;
	},
	writeSqlite(run, ws, { value: board, position }) {
		run(
			`insert into boards (workspace_id, id, position, name, viewport, view_frame, updated_at)
			values (?, ?, ?, ?, ?, ?, current_timestamp)
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name, viewport = excluded.viewport, view_frame = excluded.view_frame,
				updated_at = current_timestamp`,
			ws, board.id, position, plain(board.name), json(board.viewport), json(board.viewFrame ?? null),
		);
	},
	// Pan and zoom are saved, but they are no part of the undo history either, and would flood this one.
	quiet: onlyViewport,
};

export const CARD_STORAGE: AppStorage<CanvasCard, Rows> = {
	unit: CARD_UNIT,
	table: "cards",
	readPostgres: (queries, ws) =>
		queries`select id, board_id, entity_id, x, y, width, height from cards where workspace_id = ${ws} order by board_id, position, id`,
	readSqlite: (all) => all("select id, board_id, entity_id, x, y, width, height from cards where workspace_id = ? order by board_id, position, id"),
	assemble(data, cards) {
		const cardsOf = groupBy(cards, "board_id", ({ id, entity_id, x, y, width, height }) => ({ id, entityId: entity_id, x, y, width, height }));
		return { ...data, boards: data.boards.map((board) => ({ ...board, cards: cardsOf.get(board.id) ?? [] })) };
	},
	async writePostgres(tx, ws, { value: card, position }, boardId) {
		await tx`insert into cards (workspace_id, id, board_id, entity_id, position, x, y, width, height)
			values (${ws}, ${card.id}, ${boardId!}, ${card.entityId}, ${position}, ${card.x}, ${card.y}, ${card.width}, ${card.height})
			on conflict (workspace_id, id) do update set
				board_id = excluded.board_id, entity_id = excluded.entity_id, position = excluded.position,
				x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height`;
	},
	writeSqlite(run, ws, { value: card, position }, boardId) {
		run(
			`insert into cards (workspace_id, id, board_id, entity_id, position, x, y, width, height)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict (workspace_id, id) do update set
				board_id = excluded.board_id, entity_id = excluded.entity_id, position = excluded.position,
				x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height`,
			ws, card.id, plain(boardId), card.entityId, position, card.x, card.y, card.width, card.height,
		);
	},
};

export const DRAWING_STORAGE: AppStorage<Drawing, Rows> = {
	unit: DRAWING_UNIT,
	table: "drawings",
	readPostgres: (queries, ws) => queries`select board_id, body from drawings where workspace_id = ${ws} order by board_id, position, id`,
	readSqlite: (all) =>
		all("select board_id, body from drawings where workspace_id = ? order by board_id, position, id").map((row) => ({ ...row, body: parsed(row.body) })),
	assemble(data, drawings) {
		const drawingsOf = groupBy(drawings, "board_id", ({ body }) => body as Drawing);
		return { ...data, boards: data.boards.map((board) => ({ ...board, drawings: drawingsOf.get(board.id) ?? [] })) };
	},
	async writePostgres(tx, ws, { value: drawing, position }, boardId) {
		await tx`insert into drawings (workspace_id, id, board_id, position, kind, body)
			values (${ws}, ${drawing.id}, ${boardId!}, ${position}, ${drawing.kind}, ${jsonbParameter(tx, drawing)})
			on conflict (workspace_id, id) do update set
				board_id = excluded.board_id, position = excluded.position, kind = excluded.kind, body = excluded.body`;
	},
	writeSqlite(run, ws, { value: drawing, position }, boardId) {
		run(
			`insert into drawings (workspace_id, id, board_id, position, kind, body)
			values (?, ?, ?, ?, ?, ?)
			on conflict (workspace_id, id) do update set
				board_id = excluded.board_id, position = excluded.position, kind = excluded.kind, body = excluded.body`,
			ws, drawing.id, plain(boardId), position, drawing.kind, JSON.stringify(drawing),
		);
	},
};
