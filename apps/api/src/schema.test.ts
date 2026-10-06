import assert from "node:assert/strict";
import postgres from "postgres";
import { test } from "node:test";
import { MIGRATIONS, migrateSchema } from "./schema.js";

/** The test database these tests run against (never the productive DATABASE_URL); without it they are skipped, not failed. */
const url = process.env.TEST_DATABASE_URL;

/** Every table of the schema. */
const ALL_TABLES = ["schema_migrations", "workspaces", "entity_types", "properties", "entities", "entity_values", "boards", "cards", "drawings"];

/** Takes the test database back to before any schema: none of its tables there. */
async function wipe(sql: postgres.Sql<{}>): Promise<void> {
	for (const table of ALL_TABLES) {
		const [row] = await sql`select to_regclass(${table}) is not null as there`;
		if (row?.there) await sql`drop table ${sql(table)} cascade`;
	}
}

/** The tables of the schema that are there now. */
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
