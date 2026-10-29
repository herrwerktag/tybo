import {
	ANALYSIS_UNIT,
	BOARD_UNIT,
	CARD_UNIT,
	DRAWING_UNIT,
	ENTITY_UNIT,
	TYPE_UNIT,
	jsonEqual,
	type Analysis,
	type AppData,
	type BoardMeta,
	type CanvasCard,
	type Drawing,
	type Entity,
	type EntityType,
	type UnitKind,
	type UnitStand,
} from "@tybo/app/core";
import type { Queries } from "./schema.js";
import { json, parsed, plain, type All, type Run } from "./sqlite-values.js";

/**
 * How one kind of unit is kept in the tables, in Postgres and in SQLite alike: the rows it is read from and
 * put together of, and how one unit's rows are written. Deleting a unit is its one row going (`table`); the
 * tables' references cascade what hung below it.
 *
 * `R` is what its reading answers — its rows, the JSON columns already parsed, whichever database answered.
 */
export interface UnitStorage<T extends { id: string } = any, R = any> {
	unit: UnitKind<AppData, T>;
	/** The table holding one row per unit. */
	table: string;
	readPostgres(queries: Queries, ws: string): Promise<R>;
	readSqlite(all: All): R;
	/** The app's data with its units put in, from the rows read. Kinds are put in parents first. */
	assemble(data: AppData, rows: R): AppData;
	/** Writes the unit's rows (an upsert of its own, and of what belongs to it alone). */
	writePostgres(tx: Queries, ws: string, after: UnitStand<T>, boardId: string | undefined): Promise<void>;
	writeSqlite(run: Run, ws: string, after: UnitStand<T>, boardId: string | undefined): void;
	/** Whether a change between the two stands is no news for the history (it's saved, but leaves no entry). */
	quiet?(before: UnitStand<T> | null, after: UnitStand<T> | null): boolean;
}

/** The jsonb parameter the driver makes, in the transaction at hand (`null` stays SQL null, not jsonb `null`). */
function jsonbParameter(queries: Queries, value: unknown) {
	return value === null || value === undefined ? null : queries.json(value as never);
}

/** The rows by the parent their `column` names, each turned into what the app holds, in the rows' order. */
function groupBy<R extends Record<string, unknown>, T>(rows: readonly R[], column: keyof R, make: (row: R) => T): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const parent = row[column] as string;
		const list = groups.get(parent) ?? [];
		list.push(make(row));
		groups.set(parent, list);
	}
	return groups;
}

type Rows = readonly Record<string, any>[];

/** Types with their properties: a row each, the properties in a table of their own. */
const TYPE_STORAGE: UnitStorage<EntityType, { types: Rows; properties: Rows }> = {
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
const ENTITY_STORAGE: UnitStorage<Entity, { entities: Rows; values: Rows }> = {
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

const ANALYSIS_STORAGE: UnitStorage<Analysis, Rows> = {
	unit: ANALYSIS_UNIT,
	table: "analyses",
	readPostgres: (queries, ws) =>
		queries`select id, name, type_id, group_paths, column_paths from analyses where workspace_id = ${ws} order by position, id`,
	readSqlite: (all) =>
		all("select id, name, type_id, group_paths, column_paths from analyses where workspace_id = ? order by position, id").map((row) => ({
			...row,
			group_paths: parsed(row.group_paths),
			column_paths: parsed(row.column_paths),
		})),
	assemble: (data, analyses) => ({
		...data,
		analyses: analyses.map(({ id, name, type_id, group_paths, column_paths }) => ({
			id,
			name,
			typeId: type_id,
			groups: group_paths ?? [],
			columns: column_paths ?? [],
		})),
	}),
	async writePostgres(tx, ws, { value: item, position }) {
		await tx`insert into analyses (workspace_id, id, position, name, type_id, group_paths, column_paths, updated_at)
			values (${ws}, ${item.id}, ${position}, ${item.name}, ${item.typeId}, ${jsonbParameter(tx, item.groups)},
				${jsonbParameter(tx, item.columns)}, now())
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name, type_id = excluded.type_id, group_paths = excluded.group_paths,
				column_paths = excluded.column_paths, updated_at = now()`;
	},
	writeSqlite(run, ws, { value: item, position }) {
		run(
			`insert into analyses (workspace_id, id, position, name, type_id, group_paths, column_paths, updated_at)
			values (?, ?, ?, ?, ?, ?, ?, current_timestamp)
			on conflict (workspace_id, id) do update set
				position = excluded.position, name = excluded.name, type_id = excluded.type_id, group_paths = excluded.group_paths,
				column_paths = excluded.column_paths, updated_at = current_timestamp`,
			ws, item.id, position, plain(item.name), plain(item.typeId), json(item.groups), json(item.columns),
		);
	},
};

/** Whether two stands of a board differ in nothing but its viewport — same place, same name, same frame. */
function onlyViewport(before: UnitStand<BoardMeta> | null, after: UnitStand<BoardMeta> | null): boolean {
	if (before === null || after === null || before.position !== after.position) return false;
	const { viewport: _was, ...was } = before.value;
	const { viewport: _now, ...now } = after.value;
	return jsonEqual(was, now);
}

const BOARD_STORAGE: UnitStorage<BoardMeta, Rows> = {
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

const CARD_STORAGE: UnitStorage<CanvasCard, Rows> = {
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

const DRAWING_STORAGE: UnitStorage<Drawing, Rows> = {
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

/** How each kind of unit is kept, parents before the children naming them — the order they are read, put
 * together and written in. */
export const UNIT_STORAGES: readonly UnitStorage[] = [TYPE_STORAGE, ENTITY_STORAGE, ANALYSIS_STORAGE, BOARD_STORAGE, CARD_STORAGE, DRAWING_STORAGE];

/** How the kind named is kept, or undefined for a kind there is none of. */
export function storageOf(kind: string): UnitStorage | undefined {
	return UNIT_STORAGES.find((storage) => storage.unit.kind === kind);
}

/** The app's data put together of every kind's rows, parents first. */
export function assembleAppData(rows: readonly unknown[]): AppData {
	return UNIT_STORAGES.reduce((data, storage, index) => storage.assemble(data, rows[index]), {} as AppData);
}

/** The app's kinds of unit, in the order of their storages. */
export const STORED_KINDS = UNIT_STORAGES.map(({ unit }) => unit);
