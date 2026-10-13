import assert from "node:assert/strict";
import postgres from "postgres";
import { test } from "node:test";
import { MIGRATIONS, migrateSchema } from "./schema.js";

/** The test database these tests run against (never the productive DATABASE_URL); without it they are skipped, not failed. */
const url = process.env.TEST_DATABASE_URL;

/** Every table of the schema. */
const ALL_TABLES = ["schema_migrations", "workspaces", "entity_types", "properties", "entities", "entity_values", "boards", "cards", "drawings", "library_drawings"];

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
		assert.deepEqual(await tables(sql), ["boards", "cards", "drawings", "entities", "entity_types", "entity_values", "library_drawings", "properties", "schema_migrations", "workspaces"]);
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

test("steps 6 and 7: a board's steps from before become one story, with the board's id; its frames stay null", { skip: !url }, async () => {
	const sql = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	try {
		await wipe(sql);
		await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 6));
		await sql`insert into workspaces (id, position, name, data_version) values ('ws', 0, 'Alt', 4)`;
		const board = (id: string, position: number, story: boolean | null, pages: unknown) =>
			sql`insert into boards (workspace_id, id, position, name, story, pages)
				values ('ws', ${id}, ${position}, ${id}, ${story}, ${pages === null ? null : sql.json(pages as never)})`;
		await board("on", 0, true, [{ id: "p1", name: "Eins" }]);
		await board("off", 1, false, [{ id: "p2", name: "Zwei" }]);
		await board("none", 2, false, []);
		await board("null", 3, null, null);

		assert.deepEqual(await migrateSchema(sql), [6, 7]);
		const rows = await sql`select id, stories from boards order by position`;
		// Step 7 leaves the frames null: the app makes them of the steps' pan/zoom.
		assert.deepEqual([...(await sql`select distinct frames, view_frame_id from boards`)], [{ frames: null, view_frame_id: null }]);
		assert.deepEqual(
			rows.map((row) => [row.id, row.stories]),
			[
				["on", [{ id: "on", name: "Story 1", pages: [{ id: "p1", name: "Eins" }] }]],
				["off", [{ id: "off", name: "Story 1", pages: [{ id: "p2", name: "Zwei" }] }]],
				["none", []],
				["null", []],
			],
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
});
