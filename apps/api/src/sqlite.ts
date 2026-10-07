import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AppData, Change, SavedChanges } from "@bekbon/core";
import { CHANGE_KINDS, unitStands, untouched } from "@bekbon/core";
import { assembleAppData, type StoredWorkspace } from "./data.js";
import type { Api } from "./http.js";

/** The API's storage in a local SQLite file, plus what running the server against it takes — the same as
 * `PostgresStorage`, for working without a Postgres server at hand. */
export interface SqliteStorage extends Api {
	/** Brings the schema up to date; calling it again changes nothing. Answers the versions of the steps it ran. */
	init(): Promise<number[]>;
	/** Closes the file; the data stays. */
	close(): Promise<void>;
}

/** One step of the local schema, counted in the file's `user_version` — never changed once it has run
 * anywhere; a correction is a further step. */
interface Migration {
	version: number;
	up(db: DatabaseSync): void;
}

/** The local schema: the tables of Postgres's (see `schema.ts`) as they stand now, JSON kept as text. */
export const SQLITE_MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		up(db) {
			db.exec(`
				create table workspaces (
					id text primary key,
					position integer not null,
					name text not null,
					data_version integer not null,
					revision integer not null default 0,
					created_at text not null default current_timestamp,
					updated_at text not null default current_timestamp
				);
				create table entity_types (
					workspace_id text not null references workspaces(id) on delete cascade,
					id text not null,
					position integer not null,
					name text,
					content_template text,
					color text,
					updated_at text not null default current_timestamp,
					primary key (workspace_id, id)
				);
				create table properties (
					workspace_id text not null,
					id text not null,
					type_id text not null,
					position integer not null,
					name text,
					kind text,
					options text,
					reference text,
					card_display text,
					primary key (workspace_id, id),
					foreign key (workspace_id, type_id) references entity_types(workspace_id, id) on delete cascade
				);
				create table entities (
					workspace_id text not null,
					id text not null,
					type_id text not null,
					position integer not null,
					name text,
					content text,
					description text,
					updated_at text not null default current_timestamp,
					primary key (workspace_id, id),
					foreign key (workspace_id, type_id) references entity_types(workspace_id, id) on delete cascade
				);
				create table entity_values (
					workspace_id text not null,
					entity_id text not null,
					property_id text not null,
					position integer not null,
					value text,
					primary key (workspace_id, entity_id, property_id),
					foreign key (workspace_id, entity_id) references entities(workspace_id, id) on delete cascade,
					foreign key (workspace_id, property_id) references properties(workspace_id, id) on delete cascade
				);
				create table boards (
					workspace_id text not null references workspaces(id) on delete cascade,
					id text not null,
					position integer not null,
					name text,
					viewport text,
					story integer,
					pages text,
					updated_at text not null default current_timestamp,
					primary key (workspace_id, id)
				);
				create table cards (
					workspace_id text not null,
					id text not null,
					board_id text not null,
					entity_id text not null,
					position integer not null,
					x real not null,
					y real not null,
					width real not null,
					height real not null,
					primary key (workspace_id, id),
					foreign key (workspace_id, board_id) references boards(workspace_id, id) on delete cascade,
					foreign key (workspace_id, entity_id) references entities(workspace_id, id) on delete cascade
				);
				create table drawings (
					workspace_id text not null,
					id text not null,
					board_id text not null,
					position integer not null,
					kind text not null,
					body text not null,
					primary key (workspace_id, id),
					foreign key (workspace_id, board_id) references boards(workspace_id, id) on delete cascade
				);
				create table library_drawings (
					workspace_id text not null references workspaces(id) on delete cascade,
					id text not null,
					position integer not null,
					name text,
					tags text,
					drawings text,
					updated_at text not null default current_timestamp,
					primary key (workspace_id, id)
				);
			`);
		},
	},
];

/** The table holding each kind of unit, one row per unit. */
const TABLES: Record<Change["kind"], string> = {
	type: "entity_types",
	entity: "entities",
	library: "library_drawings",
	board: "boards",
	card: "cards",
	drawing: "drawings",
};

/** A JSON column's parameter: null stays SQL null, anything else its JSON text. */
const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

/** A JSON column's value as read: its text parsed, SQL null as null. */
const parsed = (text: unknown): unknown => (text === null || text === undefined ? null : JSON.parse(text as string));

/** A plain column's parameter: what SQLite can't bind (undefined) as null. */
const plain = (value: unknown): SQLInputValue => (value === undefined ? null : (value as SQLInputValue));

/** Runs `work` in one transaction: all of it written, or — when it throws — none of it. */
function transaction<T>(db: DatabaseSync, work: () => T): T {
	db.exec("begin immediate");
	try {
		const result = work();
		db.exec("commit");
		return result;
	} catch (error) {
		db.exec("rollback");
		throw error;
	}
}

/** The app's data in a SQLite file at `path` (made when it isn't there): the same workspaces and tables as
 * in Postgres, written and read the same way — a save in one transaction, its units' collisions reported. */
export function sqliteStorage(path: string): SqliteStorage {
	const db = new DatabaseSync(path);
	// The references' cascades are what deleting a unit relies on; SQLite only follows them when asked to.
	db.exec("pragma foreign_keys = on; pragma journal_mode = wal; pragma busy_timeout = 5000");

	const revisionOf = (id: string): string | null => {
		const row = db.prepare("select revision from workspaces where id = ?").get(id);
		return row ? String(row.revision) : null;
	};

	const readAppData = (ws: string): AppData => {
		const all = (sql: string) => db.prepare(sql).all(ws) as Record<string, any>[];
		return assembleAppData({
			types: all("select id, name, content_template, color from entity_types where workspace_id = ? order by position, id"),
			properties: all(
				"select id, type_id, name, kind, options, reference, card_display from properties where workspace_id = ? order by type_id, position, id",
			).map((row) => ({ ...row, options: parsed(row.options), reference: parsed(row.reference) })),
			entities: all("select id, type_id, name, content, description from entities where workspace_id = ? order by position, id"),
			values: all("select entity_id, property_id, value from entity_values where workspace_id = ? order by entity_id, position, property_id").map(
				(row) => ({ ...row, value: parsed(row.value) }),
			),
			boards: all("select id, name, viewport, story, pages from boards where workspace_id = ? order by position, id").map((row) => ({
				...row,
				viewport: parsed(row.viewport),
				story: row.story === null ? null : Boolean(row.story),
				pages: parsed(row.pages),
			})),
			cards: all("select id, board_id, entity_id, x, y, width, height from cards where workspace_id = ? order by board_id, position, id"),
			drawings: all("select board_id, body from drawings where workspace_id = ? order by board_id, position, id").map((row) => ({
				...row,
				body: parsed(row.body),
			})),
			library: all("select id, name, tags, drawings from library_drawings where workspace_id = ? order by position, id").map((row) => ({
				...row,
				tags: parsed(row.tags),
				drawings: parsed(row.drawings),
			})),
		});
	};

	/** Writes one unit's rows — only that unit's own, in its workspace (see `changes.ts`, which does the same in Postgres). */
	const writeUnit = (ws: string, unit: Change): void => {
		const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);
		if (unit.after === null) {
			run(`delete from ${TABLES[unit.kind]} where workspace_id = ? and id = ?`, ws, unit.id);
			return;
		}
		switch (unit.kind) {
			case "type": {
				const type = unit.after.value;
				run(
					`insert into entity_types (workspace_id, id, position, name, content_template, color, updated_at)
					values (?, ?, ?, ?, ?, ?, current_timestamp)
					on conflict (workspace_id, id) do update set
						position = excluded.position, name = excluded.name,
						content_template = excluded.content_template, color = excluded.color, updated_at = current_timestamp`,
					ws, type.id, unit.after.position, plain(type.name), plain(type.contentTemplate), plain(type.color),
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
				return;
			}
			case "entity": {
				const entity = unit.after.value;
				run(
					`insert into entities (workspace_id, id, type_id, position, name, content, description, updated_at)
					values (?, ?, ?, ?, ?, ?, ?, current_timestamp)
					on conflict (workspace_id, id) do update set
						type_id = excluded.type_id, position = excluded.position, name = excluded.name,
						content = excluded.content, description = excluded.description, updated_at = current_timestamp`,
					ws, entity.id, entity.typeId, unit.after.position, plain(entity.name), plain(entity.content), plain(entity.description),
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
				return;
			}
			case "library": {
				const item = unit.after.value;
				run(
					`insert into library_drawings (workspace_id, id, position, name, tags, drawings, updated_at)
					values (?, ?, ?, ?, ?, ?, current_timestamp)
					on conflict (workspace_id, id) do update set
						position = excluded.position, name = excluded.name, tags = excluded.tags, drawings = excluded.drawings,
						updated_at = current_timestamp`,
					ws, item.id, unit.after.position, plain(item.name), json(item.tags), json(item.drawings),
				);
				return;
			}
			case "board": {
				const board = unit.after.value;
				run(
					`insert into boards (workspace_id, id, position, name, viewport, story, pages, updated_at)
					values (?, ?, ?, ?, ?, ?, ?, current_timestamp)
					on conflict (workspace_id, id) do update set
						position = excluded.position, name = excluded.name, viewport = excluded.viewport, story = excluded.story,
						pages = excluded.pages, updated_at = current_timestamp`,
					ws, board.id, unit.after.position, plain(board.name), json(board.viewport),
					board.story === null || board.story === undefined ? null : board.story ? 1 : 0, json(board.pages),
				);
				return;
			}
			case "card": {
				const card = unit.after.value;
				run(
					`insert into cards (workspace_id, id, board_id, entity_id, position, x, y, width, height)
					values (?, ?, ?, ?, ?, ?, ?, ?, ?)
					on conflict (workspace_id, id) do update set
						board_id = excluded.board_id, entity_id = excluded.entity_id, position = excluded.position,
						x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height`,
					ws, card.id, unit.boardId, card.entityId, unit.after.position, card.x, card.y, card.width, card.height,
				);
				return;
			}
			case "drawing": {
				const drawing = unit.after.value;
				run(
					`insert into drawings (workspace_id, id, board_id, position, kind, body)
					values (?, ?, ?, ?, ?, ?)
					on conflict (workspace_id, id) do update set
						board_id = excluded.board_id, position = excluded.position, kind = excluded.kind, body = excluded.body`,
					ws, drawing.id, unit.boardId, unit.after.position, drawing.kind, JSON.stringify(drawing),
				);
				return;
			}
		}
	};

	return {
		async init() {
			return transaction(db, () => {
				const done = Number(db.prepare("pragma user_version").get()!.user_version);
				const ran: number[] = [];
				for (const migration of SQLITE_MIGRATIONS) {
					if (migration.version <= done) continue;
					migration.up(db);
					db.exec(`pragma user_version = ${migration.version}`);
					ran.push(migration.version);
				}
				return ran;
			});
		},

		async listWorkspaces() {
			const rows = db.prepare("select id, name from workspaces order by position, created_at, id").all();
			return rows.map(({ id, name }) => ({ id: id as string, name: name as string }));
		},

		async createWorkspace(info, dataVersion) {
			const inserted = db
				.prepare(
					`insert into workspaces (id, position, name, data_version)
					values (?, (select coalesce(max(position) + 1, 0) from workspaces), ?, ?)
					on conflict (id) do nothing
					returning id`,
				)
				.all(info.id, info.name, dataVersion);
			return inserted.length > 0;
		},

		async renameWorkspace(id, name) {
			const updated = db.prepare("update workspaces set name = ?, updated_at = current_timestamp where id = ? returning id").all(name, id);
			return updated.length > 0;
		},

		async deleteWorkspace(id) {
			db.prepare("delete from workspaces where id = ?").run(id);
		},

		async readWorkspace(id): Promise<StoredWorkspace | null> {
			// Synchronous in one transaction: no save can land in between.
			return transaction(db, () => {
				const workspace = db.prepare("select data_version, revision from workspaces where id = ?").get(id);
				if (!workspace) return null;
				return { data: { version: Number(workspace.data_version), ...readAppData(id) }, revision: String(workspace.revision) };
			});
		},

		async workspaceRevision(id) {
			return revisionOf(id);
		},

		async writeChanges(id, changes): Promise<SavedChanges | null> {
			if (changes.length === 0) {
				const version = revisionOf(id);
				return version === null ? null : { version, collided: [] };
			}
			return transaction(db, () => {
				if (revisionOf(id) === null) return null;
				const stands = unitStands(readAppData(id));
				const ordered = [...changes].sort((a, b) => CHANGE_KINDS.indexOf(a.kind) - CHANGE_KINDS.indexOf(b.kind));
				const collided: string[] = [];
				for (const unit of ordered) {
					if (!untouched(stands, unit)) collided.push(unit.id);
					writeUnit(id, unit);
				}
				db.prepare("update workspaces set revision = revision + 1, updated_at = current_timestamp where id = ?").run(id);
				return { version: revisionOf(id)!, collided };
			});
		},

		async healthy() {
			return db.isOpen;
		},

		async close() {
			db.close();
		},
	};
}
