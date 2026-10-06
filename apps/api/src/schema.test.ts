import assert from "node:assert/strict";
import postgres from "postgres";
import { test } from "node:test";
import { DATA_TABLES, MIGRATIONS, migrateSchema } from "./schema.js";

/** The test database these tests run against (never the productive DATABASE_URL); without it they are skipped, not failed. */
const url = process.env.TEST_DATABASE_URL;

/** Every table the schema has ever had, the old text storage and its mirror included. */
const ALL_TABLES = ["schema_migrations", "texts", "texts_archive", "mirror_meta", ...DATA_TABLES, "workspaces"];

/** Takes the test database back to before any schema: none of the tables there. */
async function wipe(sql: postgres.Sql<{}>): Promise<void> {
	for (const table of ALL_TABLES) {
		const [row] = await sql`select to_regclass(${table}) is not null as there`;
		if (row?.there) await sql`drop table ${sql(table)} cascade`;
	}
}

/** The tables that are there now, of the ones the schema has ever had. */
async function tables(sql: postgres.Sql<{}>): Promise<string[]> {
	const rows = await sql`select table_name from information_schema.tables
		where table_schema = current_schema() and table_name in ${sql(ALL_TABLES)} order by table_name`;
	return rows.map((row) => row.table_name as string);
}

test("an empty database gets the whole schema, and a second run has nothing left to do", { skip: !url }, async () => {
	const sql = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	try {
		await wipe(sql);
		assert.deepEqual(await migrateSchema(sql), MIGRATIONS.map((m) => m.version));
		assert.deepEqual(await tables(sql), ["boards", "cards", "drawings", "entities", "entity_types", "entity_values", "properties", "schema_migrations", "workspaces"]);
		assert.deepEqual(await migrateSchema(sql), []);
	} finally {
		await sql.end({ timeout: 5 });
	}
});

test("the text storage of before is set aside untouched, its derived copy goes — and then the archive too", { skip: !url }, async () => {
	const sql = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	try {
		await wipe(sql);
		// The layout the API had before: the texts, and the mirror's tables filled from them.
		await sql`create table texts (key text primary key, value text not null, revision bigint not null default 0)`;
		await sql`insert into texts (key, value, revision) values ('entities-app', '{"types":[]}', 3)`;
		await sql`create table mirror_meta (key text primary key, value jsonb not null)`;
		await sql`create table entity_types (id text primary key, position int not null)`;
		await sql`create table properties (id text primary key, type_id text not null references entity_types(id))`;

		// The steps before the archive's end: the texts are aside, untouched.
		await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 3));

		assert.deepEqual([...(await sql`select key, value, revision::int from texts_archive`)], [{ key: "entities-app", value: '{"types":[]}', revision: 3 }]);
		const tablesNow = await tables(sql);
		assert.equal(tablesNow.includes("texts"), false);
		assert.equal(tablesNow.includes("mirror_meta"), false);
		// The data tables are the new ones now, with their workspace.
		const [column] = await sql`select 1 as there from information_schema.columns where table_name = 'entity_types' and column_name = 'workspace_id'`;
		assert.ok(column);

		// The next step drops the archive for good.
		assert.deepEqual(await migrateSchema(sql), [3]);
		assert.equal((await tables(sql)).includes("texts_archive"), false);
	} finally {
		await sql.end({ timeout: 5 });
	}
});

test("a step that fails leaves the schema exactly as it was — none of the run is kept", { skip: !url }, async () => {
	const sql = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	try {
		await wipe(sql);
		await migrateSchema(sql);
		const before = await sql`select version from schema_migrations order by version`;

		const failing = [
			...MIGRATIONS,
			{ version: 900, name: "made for the test", up: async (tx: postgres.ISql<{}>) => void (await tx`create table schema_test_half (id int)`) },
			{ version: 901, name: "fails", up: async () => Promise.reject(new Error("the step fails")) },
		];
		await assert.rejects(migrateSchema(sql, failing));

		assert.deepEqual(await sql`select version from schema_migrations order by version`, before);
		const [half] = await sql`select to_regclass('schema_test_half') is not null as there`;
		assert.equal(half?.there, false, "the step before the failing one was rolled back with it");
	} finally {
		await sql.end({ timeout: 5 });
	}
});
