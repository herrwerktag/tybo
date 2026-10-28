import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AppData, Change, SavedChanges } from "@tybo/core";
import { CHANGE_KINDS, DATA_VERSION, moveItem, unitStands, untouched } from "@tybo/core";
import { assembleAppData, type StoredWorkspace } from "./data.js";
import { changeEntries, type HistoryEntry, type HistoryOperation, type NewEntry } from "./history.js";
import type { Api } from "./http.js";

/** The API's storage in a local SQLite file, plus what running the server against it takes — the same as
 * `PostgresStorage`, for working without a Postgres server at hand. */
export interface SqliteStorage extends Api {
	/** Brings the schema up to date; calling it again changes nothing. Answers the versions of the steps it ran. */
	init(): Promise<number[]>;
	/** Gives each workspace made before the history its starting point (see `recordBaselines` in data.ts); answers how many. */
	recordBaselines(): Promise<number>;
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
	{
		version: 2,
		up(db) {
			db.exec("alter table entities add column tags text");
		},
	},
	{
		version: 3,
		up(db) {
			// As Postgres's step 6: a board's steps become one story, with the board's id.
			db.exec(`
				alter table boards add column stories text;
				update boards set stories = case
					when coalesce(json_array_length(pages), 0) > 0 or story = 1
						then json_array(json_object('id', id, 'name', 'Story 1', 'pages', json(coalesce(pages, '[]'))))
					else '[]'
				end;
				alter table boards drop column story;
				alter table boards drop column pages;
			`);
		},
	},
	{
		version: 4,
		up(db) {
			// As Postgres's step 7: null in rows from before.
			db.exec("alter table boards add column frames text; alter table boards add column view_frame_id text;");
		},
	},
	{
		version: 5,
		up(db) {
			// As Postgres's step 8, the same way whichever form step 4 had.
			const columns = new Set((db.prepare("pragma table_info(boards)").all() as { name: string }[]).map((c) => c.name));
			if (!columns.has("view_frame")) db.exec("alter table boards add column view_frame text");
			if (columns.has("view_frame_id")) db.exec("alter table boards drop column view_frame_id");
		},
	},
	{
		version: 6,
		up(db) {
			// As Postgres's step 9.
			db.exec(`
				create table analyses (
					workspace_id text not null references workspaces(id) on delete cascade,
					id text not null,
					position integer not null,
					name text,
					type_id text,
					group_paths text,
					column_paths text,
					updated_at text not null default current_timestamp,
					primary key (workspace_id, id)
				);
			`);
		},
	},
	{
		version: 7,
		up(db) {
			// As Postgres's step 10.
			db.exec("alter table boards drop column stories; alter table boards drop column frames;");
		},
	},
	{
		version: 8,
		up(db) {
			// As Postgres's step 11.
			db.exec("delete from drawings where kind = 'symbol'; drop table library_drawings;");
		},
	},
	{
		version: 9,
		up(db) {
			// As Postgres's step 12; the time with milliseconds, in the form Postgres answers it.
			db.exec(`
				create table history (
					id integer primary key autoincrement,
					workspace_id text not null,
					revision integer,
					at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
					source text,
					operation text not null,
					kind text,
					unit_id text,
					board_id text,
					before text,
					after text,
					collided integer not null default 0
				);
				create index history_workspace on history (workspace_id, id desc);
			`);
		},
	},
	{
		version: 10,
		up(db) {
			// As Postgres's step 13 (SQLite can't make a column not null afterwards; every write sets it).
			db.exec("alter table history add column data_version integer; update history set data_version = 9;");
		},
	},
	{
		version: 11,
		up(db) {
			// As Postgres's step 14.
			db.exec("update workspaces set data_version = 9");
		},
	},
];

/** The table holding each kind of unit, one row per unit. */
const TABLES: Record<Change["kind"], string> = {
	type: "entity_types",
	entity: "entities",
	analysis: "analyses",
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
			entities: all("select id, type_id, name, content, description, tags from entities where workspace_id = ? order by position, id").map(
				(row) => ({ ...row, tags: parsed(row.tags) }),
			),
			values: all("select entity_id, property_id, value from entity_values where workspace_id = ? order by entity_id, position, property_id").map(
				(row) => ({ ...row, value: parsed(row.value) }),
			),
			boards: all("select id, name, viewport, view_frame from boards where workspace_id = ? order by position, id").map((row) => ({
				...row,
				viewport: parsed(row.viewport),
				view_frame: parsed(row.view_frame),
			})),
			cards: all("select id, board_id, entity_id, x, y, width, height from cards where workspace_id = ? order by board_id, position, id"),
			drawings: all("select board_id, body from drawings where workspace_id = ? order by board_id, position, id").map((row) => ({
				...row,
				body: parsed(row.body),
			})),
			analyses: all("select id, name, type_id, group_paths, column_paths from analyses where workspace_id = ? order by position, id").map((row) => ({
				...row,
				group_paths: parsed(row.group_paths),
				column_paths: parsed(row.column_paths),
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
					`insert into entities (workspace_id, id, type_id, position, name, content, description, tags, updated_at)
					values (?, ?, ?, ?, ?, ?, ?, ?, current_timestamp)
					on conflict (workspace_id, id) do update set
						type_id = excluded.type_id, position = excluded.position, name = excluded.name,
						content = excluded.content, description = excluded.description, tags = excluded.tags, updated_at = current_timestamp`,
					ws, entity.id, entity.typeId, unit.after.position, plain(entity.name), plain(entity.content), plain(entity.description),
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
				return;
			}
			case "analysis": {
				const item = unit.after.value;
				run(
					`insert into analyses (workspace_id, id, position, name, type_id, group_paths, column_paths, updated_at)
					values (?, ?, ?, ?, ?, ?, ?, current_timestamp)
					on conflict (workspace_id, id) do update set
						position = excluded.position, name = excluded.name, type_id = excluded.type_id, group_paths = excluded.group_paths,
						column_paths = excluded.column_paths, updated_at = current_timestamp`,
					ws, item.id, unit.after.position, plain(item.name), plain(item.typeId), json(item.groups), json(item.columns),
				);
				return;
			}
			case "board": {
				const board = unit.after.value;
				run(
					`insert into boards (workspace_id, id, position, name, viewport, view_frame, updated_at)
					values (?, ?, ?, ?, ?, ?, current_timestamp)
					on conflict (workspace_id, id) do update set
						position = excluded.position, name = excluded.name, viewport = excluded.viewport, view_frame = excluded.view_frame,
						updated_at = current_timestamp`,
					ws, board.id, unit.after.position, plain(board.name), json(board.viewport), json(board.viewFrame ?? null),
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

	/** Adds the entries for the workspace, within the transaction of the write they tell of (see `history.ts`). */
	const recordHistory = (ws: string, source: string | null, entries: readonly NewEntry[]): void => {
		const insert = db.prepare(
			`insert into history (workspace_id, revision, source, operation, data_version, kind, unit_id, board_id, before, after, collided)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const entry of entries) {
			insert.run(
				ws, plain(entry.revision === undefined || entry.revision === null ? null : Number(entry.revision)), source, entry.operation, DATA_VERSION,
				plain(entry.kind), plain(entry.unitId), plain(entry.boardId), json(entry.before), json(entry.after), entry.collided ? 1 : 0,
			);
		}
	};

	/** The workspace's revision and name, or undefined when there is none of that id. */
	const workspaceRow = (id: string) => db.prepare("select name, data_version, revision from workspaces where id = ?").get(id);

	/** Everything the workspace holds — its name, revision and data; null when there is none of that id. The data's
	 * format is the entry's own (see `snapshot` in data.ts). */
	const snapshot = (id: string) => {
		const row = workspaceRow(id);
		if (!row) return null;
		return { name: row.name as string, revision: String(row.revision), data: readAppData(id) };
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

		async createWorkspace(info, dataVersion, source = null) {
			return transaction(db, () => {
				const [inserted] = db
					.prepare(
						`insert into workspaces (id, position, name, data_version)
						values (?, (select coalesce(max(position) + 1, 0) from workspaces), ?, ?)
						on conflict (id) do nothing
						returning position`,
					)
					.all(info.id, info.name, dataVersion);
				if (!inserted) return false;
				recordHistory(info.id, source, [
					{ operation: "create", revision: "0", before: null, after: { name: info.name, position: Number(inserted.position), dataVersion } },
				]);
				return true;
			});
		},

		async renameWorkspace(id, name, source = null) {
			return transaction(db, () => {
				const was = workspaceRow(id);
				if (!was) return false;
				db.prepare("update workspaces set name = ?, updated_at = current_timestamp where id = ?").run(name, id);
				recordHistory(id, source, [{ operation: "rename", revision: String(was.revision), before: { name: was.name as string }, after: { name } }]);
				return true;
			});
		},

		async moveWorkspace(id, to, source = null) {
			return transaction(db, () => {
				const ids = db
					.prepare("select id from workspaces order by position, created_at, id")
					.all()
					.map((row) => row.id as string);
				const from = ids.indexOf(id);
				if (from < 0) return false;
				const update = db.prepare("update workspaces set position = ? where id = ?");
				const moved = moveItem(ids, from, to);
				moved.forEach((each, position) => update.run(position, each));
				recordHistory(id, source, [
					{ operation: "move", revision: revisionOf(id), before: { position: from }, after: { position: moved.indexOf(id) } },
				]);
				return true;
			});
		},

		async deleteWorkspace(id, source = null) {
			transaction(db, () => {
				const was = snapshot(id);
				if (!was) return;
				db.prepare("delete from workspaces where id = ?").run(id);
				recordHistory(id, source, [{ operation: "delete", revision: was.revision, before: was, after: null }]);
			});
		},

		async recordBaselines() {
			// One transaction for all: the file has one writer at a time anyway, and no save lands in between.
			return transaction(db, () => {
				const ids = db
					.prepare(
						`select id from workspaces
						where not exists (select 1 from history where workspace_id = workspaces.id and operation in ('create', 'baseline'))
						order by position, created_at, id`,
					)
					.all()
					.map((row) => row.id as string);
				for (const id of ids) {
					const now = snapshot(id)!;
					recordHistory(id, null, [{ operation: "baseline", revision: now.revision, before: null, after: now }]);
				}
				return ids.length;
			});
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

		async writeChanges(id, changes, source = null): Promise<SavedChanges | null> {
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
				const version = revisionOf(id)!;
				recordHistory(id, source, changeEntries(stands, ordered, collided).map((entry) => ({ ...entry, revision: version })));
				return { version, collided };
			});
		},

		async readHistory(id, page): Promise<HistoryEntry[]> {
			const rows = db
				.prepare(
					`select id, workspace_id, revision, at, source, operation, data_version, kind, unit_id, board_id, before, after, collided
					from history where workspace_id = ? and id < ? order by id desc limit ?`,
				)
				.all(id, page.before === undefined ? Number.MAX_SAFE_INTEGER : Number(page.before), page.limit);
			return rows.map((row) => ({
				id: String(row.id),
				workspaceId: row.workspace_id as string,
				revision: row.revision === null ? null : String(row.revision),
				at: row.at as string,
				source: (row.source as string | null) ?? null,
				operation: row.operation as HistoryOperation,
				dataVersion: Number(row.data_version),
				kind: (row.kind as HistoryEntry["kind"]) ?? null,
				unitId: (row.unit_id as string | null) ?? null,
				boardId: (row.board_id as string | null) ?? null,
				before: parsed(row.before),
				after: parsed(row.after),
				collided: row.collided === 1,
			}));
		},

		async healthy() {
			return db.isOpen;
		},

		async close() {
			db.close();
		},
	};
}
