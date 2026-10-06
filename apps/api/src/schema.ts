import type postgres from "postgres";

/** The driver's query function, a connection's or a transaction's — everything here runs on either. */
export type Queries = postgres.ISql<{}>;

/** A connection of the driver, which can open transactions. */
export type Sql = postgres.Sql<{}>;

/** One step of the schema: run exactly once per database, in its own place of the order, never changed
 * once it has run anywhere — a correction is a further step. */
interface Migration {
	version: number;
	/** What the step does, for the log. */
	name: string;
	up(tx: Queries): Promise<void>;
}

/** The schema, step by step. The app's data lives in these tables and nowhere else: every row belongs to its
 * workspace, and a workspace's rows go with it. */
export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "workspaces and their data tables",
		async up(tx) {
			// `revision` is the workspace's version: it grows by one on every save of its data, so no two saves
			// share one and a look can tell whether someone else saved in between. `data_version` is the format
			// the rows are in (the app's DATA_VERSION when the workspace was made).
			await tx`create table workspaces (
				id text primary key,
				position int not null,
				name text not null,
				data_version int not null,
				revision bigint not null default 0,
				created_at timestamptz not null default now(),
				updated_at timestamptz not null default now()
			)`;
			// Ids are unique within a workspace, not across them: a workspace made with copies of another's
			// types keeps their ids. So every key, and every reference between the tables, names the workspace.
			await tx`create table entity_types (
				workspace_id text not null references workspaces(id) on delete cascade,
				id text not null,
				position int not null,
				name text,
				content_template text,
				color text,
				updated_at timestamptz not null default now(),
				primary key (workspace_id, id)
			)`;
			await tx`create table properties (
				workspace_id text not null,
				id text not null,
				type_id text not null,
				position int not null,
				name text,
				kind text,
				options jsonb,
				reference jsonb,
				card_display text,
				primary key (workspace_id, id),
				foreign key (workspace_id, type_id) references entity_types(workspace_id, id) on delete cascade
			)`;
			await tx`create table entities (
				workspace_id text not null,
				id text not null,
				type_id text not null,
				position int not null,
				name text,
				content text,
				description text,
				updated_at timestamptz not null default now(),
				primary key (workspace_id, id),
				foreign key (workspace_id, type_id) references entity_types(workspace_id, id) on delete cascade
			)`;
			await tx`create table entity_values (
				workspace_id text not null,
				entity_id text not null,
				property_id text not null,
				position int not null,
				value jsonb,
				primary key (workspace_id, entity_id, property_id),
				foreign key (workspace_id, entity_id) references entities(workspace_id, id) on delete cascade,
				foreign key (workspace_id, property_id) references properties(workspace_id, id) on delete cascade
			)`;
			await tx`create table boards (
				workspace_id text not null references workspaces(id) on delete cascade,
				id text not null,
				position int not null,
				name text,
				viewport jsonb,
				updated_at timestamptz not null default now(),
				primary key (workspace_id, id)
			)`;
			await tx`create table cards (
				workspace_id text not null,
				id text not null,
				board_id text not null,
				entity_id text not null,
				position int not null,
				x double precision not null,
				y double precision not null,
				width double precision not null,
				height double precision not null,
				primary key (workspace_id, id),
				foreign key (workspace_id, board_id) references boards(workspace_id, id) on delete cascade,
				foreign key (workspace_id, entity_id) references entities(workspace_id, id) on delete cascade
			)`;
			await tx`create table drawings (
				workspace_id text not null,
				id text not null,
				board_id text not null,
				position int not null,
				kind text not null,
				body jsonb not null,
				primary key (workspace_id, id),
				foreign key (workspace_id, board_id) references boards(workspace_id, id) on delete cascade
			)`;
		},
	},
];

/** Whether a table of that name is there, asked without a statement that would only say so in a notice. */
async function exists(tx: Queries, table: string): Promise<boolean> {
	const [row] = await tx`select to_regclass(${table}) is not null as there`;
	return Boolean(row?.there);
}

/** A number of the app's own, so two servers starting at once take turns on the schema instead of both
 * running the same step. */
const MIGRATION_LOCK = 4_711_001;

/**
 * Brings the database's schema up to date: every step it hasn't run yet, in order, and each recorded in
 * `schema_migrations` so it never runs again. All of it in one transaction — a step that fails leaves the
 * schema exactly as it was. Answers the versions it ran (none: the schema was up to date already).
 */
export async function migrateSchema(sql: Sql, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
	return sql.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
		if (!(await exists(tx, "schema_migrations"))) {
			await tx`create table schema_migrations (
				version int primary key,
				name text not null,
				applied_at timestamptz not null default now()
			)`;
		}
		const done = new Set((await tx`select version from schema_migrations`).map((row) => row.version as number));
		const ran: number[] = [];
		for (const migration of migrations) {
			if (done.has(migration.version)) continue;
			await migration.up(tx);
			await tx`insert into schema_migrations (version, name) values (${migration.version}, ${migration.name})`;
			ran.push(migration.version);
		}
		return ran;
	});
}
