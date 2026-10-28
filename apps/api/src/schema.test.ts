import assert from "node:assert/strict";
import postgres from "postgres";
import { test } from "node:test";
import { MIGRATIONS, SchemaMismatch, migrateSchema } from "./schema.js";

/** The test database these tests run against (never the productive DATABASE_URL); without it they are skipped, not failed. */
const url = process.env.TEST_DATABASE_URL;

/** Every table of the schema, and the library's, which only steps 4 to 10 have. */
const ALL_TABLES = ["schema_migrations", "workspaces", "entity_types", "properties", "entities", "entity_values", "boards", "cards", "drawings", "library_drawings", "analyses", "history"];

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
		assert.deepEqual(await tables(sql), ["analyses", "boards", "cards", "drawings", "entities", "entity_types", "entity_values", "history", "properties", "schema_migrations", "workspaces"]);
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

test("a step recorded under another name stops the run before anything runs", { skip: !url }, async () => {
	const sql = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	try {
		// As a database brought up by another branch: its own step 9, not this one's.
		await wipe(sql);
		await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 9));
		await sql`insert into schema_migrations (version, name) values (9, 'from another branch')`;
		const last = MIGRATIONS.at(-1)!;
		const later = [...MIGRATIONS, { version: last.version + 1, name: "later", up: async (tx: postgres.ISql<{}>) => void (await tx`create table schema_test_later (id int)`) }];

		await assert.rejects(migrateSchema(sql, later), (error) =>
			error instanceof SchemaMismatch && error.version === 9 && error.recorded === "from another branch" && error.expected === MIGRATIONS.find((m) => m.version === 9)!.name,
		);
		const [table] = await sql`select to_regclass('schema_test_later') is not null as there`;
		assert.equal(table?.there, false, "no step ran");
	} finally {
		await sql.end({ timeout: 5 });
	}
});

test("steps 6 to 8: a board's steps from before become one story, with the board's id; its frames stay null", { skip: !url }, async () => {
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

		assert.deepEqual(await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 10)), [6, 7, 8, 9]);
		const rows = await sql`select id, stories from boards order by position`;
		// Steps 7 and 8 leave the frames null: the app makes them of the board's and the steps' pan/zoom.
		assert.deepEqual([...(await sql`select distinct view_frame, frames from boards`)], [{ view_frame: null, frames: null }]);
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

test("step 8 gives boards their own frame, whichever form step 7 ran in", { skip: !url }, async () => {
	const sql = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	const columns = async () =>
		(await sql`select column_name from information_schema.columns where table_name = 'boards' and column_name like '%frame%' order by column_name`).map(
			(row) => row.column_name as string,
		);
	try {
		// As step 7 is.
		await wipe(sql);
		await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 8));
		assert.deepEqual(await columns(), ["frames", "view_frame_id"]);
		assert.deepEqual(await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 10)), [8, 9]);
		assert.deepEqual(await columns(), ["frames", "view_frame"]);

		// As step 7 briefly was: with `view_frame` already.
		await wipe(sql);
		await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 7));
		await sql`alter table boards add column view_frame jsonb, add column frames jsonb`;
		await sql`insert into schema_migrations (version, name) values (7, 'view frames')`;
		assert.deepEqual(await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 10)), [8, 9]);
		assert.deepEqual(await columns(), ["frames", "view_frame"]);
	} finally {
		await sql.end({ timeout: 5 });
	}
});

test("step 10 drops what was saved of stories and their frames; the board's own frame stays", { skip: !url }, async () => {
	const sql = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	try {
		await wipe(sql);
		await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 10));
		await sql`insert into workspaces (id, position, name, data_version) values ('ws', 0, 'Alt', 7)`;
		await sql`insert into boards (workspace_id, id, position, name, view_frame, frames, stories)
			values ('ws', 'b', 0, 'Flow', ${sql.json({ x: 0, y: 0, width: 1280, height: 720 })}, '[]', ${sql.json([{ id: "s", name: "Story 1", pages: [] }])})`;

		assert.deepEqual(await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 11)), [10]);
		const columns = await sql`select column_name from information_schema.columns where table_name = 'boards' order by column_name`;
		assert.deepEqual(
			columns.map((row) => row.column_name),
			["id", "name", "position", "updated_at", "view_frame", "viewport", "workspace_id"],
		);
		assert.deepEqual([...(await sql`select id, view_frame from boards`)], [{ id: "b", view_frame: { x: 0, y: 0, width: 1280, height: 720 } }]);
	} finally {
		await sql.end({ timeout: 5 });
	}
});

test("step 11 drops the library and the library drawings placed on boards; other drawings stay", { skip: !url }, async () => {
	const sql = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	try {
		await wipe(sql);
		await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 11));
		await sql`insert into workspaces (id, position, name, data_version) values ('ws', 0, 'Alt', 8)`;
		await sql`insert into boards (workspace_id, id, position, name) values ('ws', 'b', 0, 'Flow')`;
		await sql`insert into drawings (workspace_id, id, board_id, position, kind, body) values
			('ws', 'box', 'b', 0, 'textbox', ${sql.json({ id: "box", kind: "textbox" })}),
			('ws', 'placed', 'b', 1, 'symbol', ${sql.json({ id: "placed", kind: "symbol", libraryId: "lib" })})`;
		await sql`insert into library_drawings (workspace_id, id, position, name) values ('ws', 'lib', 0, 'Stern')`;

		assert.deepEqual(await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 12)), [11]);
		assert.equal(await tables(sql).then((names) => names.includes("library_drawings")), false);
		assert.deepEqual([...(await sql`select id from drawings`)], [{ id: "box" }]);
	} finally {
		await sql.end({ timeout: 5 });
	}
});

test("step 13 gives the entries written before it their format, 9", { skip: !url }, async () => {
	const sql = postgres(url!, { connect_timeout: 5, onnotice: () => {} });
	try {
		await wipe(sql);
		await migrateSchema(sql, MIGRATIONS.filter((m) => m.version < 13));
		await sql`insert into history (workspace_id, operation) values ('ws', 'create')`;

		assert.deepEqual(await migrateSchema(sql), [13]);
		assert.deepEqual([...(await sql`select data_version from history`)], [{ data_version: 9 }]);
	} finally {
		await sql.end({ timeout: 5 });
	}
});
