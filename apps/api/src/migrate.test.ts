import assert from "node:assert/strict";
import postgres from "postgres";
import { test } from "node:test";
import type { AppData } from "@bekbon/core";
import { APP_KEY, DERIVED_TABLES, type Sql, type TableCounts } from "./mirror.js";
import { compareCounts, describeMigration, migrateBlob, tableCounts } from "./migrate.js";
import { postgresStorage } from "./postgres.js";

/** The test database these tests run against (never the productive DATABASE_URL); without it they are skipped, not failed. */
const url = process.env.TEST_DATABASE_URL;

/** Example app data, wide enough that every derived table gets several rows to count and order. */
const sample: AppData = {
	types: [
		{
			id: "type-person",
			name: "Person",
			contentTemplate: "Neue Person",
			color: "#c4dafa",
			properties: [
				{ id: "prop-skill", name: "Fähigkeit", kind: "options", options: ["kochen", "schneiden"], reference: null, cardDisplay: "list" },
				{ id: "prop-note", name: "Notiz", kind: "text", options: [], reference: null, cardDisplay: "hidden" },
			],
		},
		{
			id: "type-role",
			name: "Rolle",
			contentTemplate: "",
			color: "#f9c9c9",
			properties: [
				{
					id: "prop-holder",
					name: "Inhaber",
					kind: "reference",
					options: [],
					reference: { typeId: "type-person", multiple: false, arrow: "to", lineLabel: "hat", inverseLabel: "ist" },
					cardDisplay: "line",
				},
			],
		},
		{ id: "type-place", name: "Ort", contentTemplate: "", color: "#c8ebbf", properties: [] },
	],
	entities: [
		{ id: "ent-1", typeId: "type-person", name: "Ada", content: "kocht", description: "die erste", values: { "prop-skill": ["kochen"], "prop-note": "mit Ruhe" } },
		{ id: "ent-2", typeId: "type-person", name: "Bob", content: "", description: "", values: { "prop-skill": "schneiden" } },
		{ id: "ent-3", typeId: "type-role", name: "Chef", content: "", description: "", values: { "prop-holder": "ent-1" } },
		{ id: "ent-4", typeId: "type-place", name: "Küche", content: "", description: "", values: {} },
	],
	boards: [
		{
			id: "board-1",
			name: "Erstes Brett",
			viewport: { x: 0, y: 0, zoom: 1 },
			cards: [
				{ id: "card-1", entityId: "ent-1", x: 10, y: 20, width: 240, height: 160 },
				{ id: "card-3", entityId: "ent-3", x: 300, y: 40, width: 240, height: 160 },
			],
			drawings: [
				{ id: "draw-rect", kind: "rect", x: 0, y: 0, width: 100, height: 50, color: "#f9c9c9", text: "Ecke", textSize: "m" },
				{ id: "draw-line", kind: "line", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: "#4a4a4a" },
			],
		},
		{
			id: "board-2",
			name: "Zweites Brett",
			viewport: { x: 100, y: 0, zoom: 2 },
			cards: [{ id: "card-2", entityId: "ent-2", x: 0, y: 0, width: 240, height: 160 }],
			drawings: [
				{ id: "draw-ellipse", kind: "ellipse", x: 20, y: 20, width: 80, height: 40, color: "#f6e8a6", text: "", textSize: "s" },
				{ id: "draw-text", kind: "text", x: 0, y: 200, width: 100, height: 30, color: "#4a4a4a", text: "Notiz am Brett", textSize: "l" },
			],
		},
	],
};

const sampleText = JSON.stringify(sample);

/** The Soll-Zahlen, straight from the blob's own arrays — this is the blob saying how many rows it holds,
 * not anything the tests hard-code and the migration would only have to agree with. */
function blobCounts(data: AppData): TableCounts {
	return {
		entity_types: data.types.length,
		properties: data.types.reduce((sum, type) => sum + type.properties.length, 0),
		entities: data.entities.length,
		entity_values: data.entities.reduce((sum, entity) => sum + Object.keys(entity.values).length, 0),
		boards: data.boards.length,
		cards: data.boards.reduce((sum, board) => sum + board.cards.length, 0),
		drawings: data.boards.reduce((sum, board) => sum + board.drawings.length, 0),
	};
}

/** The columns each table's rows are compared by — the ones the migration writes, never the moving
 * `updated_at` of an earlier snapshot. */
const ROW_QUERIES: Record<(typeof DERIVED_TABLES)[number], string> = {
	entity_types: "select id, position, name, content_template, color from entity_types order by position",
	properties: "select id, type_id, position, name, kind, options, reference, card_display from properties order by type_id, position",
	entities: "select id, type_id, name, content, description from entities order by id",
	entity_values: "select entity_id, property_id, position, value from entity_values order by entity_id, position",
	boards: "select id, position, name, viewport from boards order by position",
	cards: "select id, board_id, entity_id, position, x, y, width, height from cards order by board_id, position",
	drawings: "select id, board_id, position, kind, body from drawings order by board_id, position",
};

/** The whole state of the derived tables, row for row — what "the same as before" is compared against. */
async function snapshot(sql: Sql): Promise<{ counts: TableCounts; rows: Record<(typeof DERIVED_TABLES)[number], unknown[]> }> {
	const rows = {} as Record<(typeof DERIVED_TABLES)[number], unknown[]>;
	for (const table of DERIVED_TABLES) {
		rows[table] = [...(await sql.unsafe(ROW_QUERIES[table]))];
	}
	return { counts: await tableCounts(sql), rows };
}

/** Every row of `texts`, whatever its key: the whole table the migration must leave alone. */
async function textsSnapshot(sql: Sql): Promise<{ key: string; value: string }[]> {
	return [...(await sql`select key, value from texts order by key`)] as { key: string; value: string }[];
}

test("migrateBlob fills every table with exactly as many rows as the blob holds", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		const result = await migrateBlob(sampleText, sql);

		assert.equal(result.status, "migrated");
		assert.equal(result.complete, true, `the tables must hold the blob row for row: ${describeMigration(result)}`);

		// The Soll-Zahlen come from the blob's own arrays, and the Ist-Zahlen match them table for table.
		const fromTheBlob = blobCounts(sample);
		for (const table of DERIVED_TABLES) {
			assert.equal(result.expected[table], fromTheBlob[table], `${table}: the Soll-Zahl is the blob's own`);
			assert.equal(result.actual[table], fromTheBlob[table], `${table}: the Ist-Zahl matches the Soll-Zahl`);
		}
		assert.deepEqual(await tableCounts(sql), fromTheBlob);

		// And the same question, asked again out of band: the Abgleich as a function stays repeatable.
		assert.deepEqual(await compareCounts(sampleText, sql), {
			expected: fromTheBlob,
			actual: fromTheBlob,
			matches: true,
		});
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("position holds the order of the blob's arrays", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		await migrateBlob(sampleText, sql);

		assert.deepEqual(
			[...(await sql`select id, position from entity_types order by position`)],
			sample.types.map((type, position) => ({ id: type.id, position })),
		);
		assert.deepEqual(
			[...(await sql`select id, type_id, position from properties order by type_id, position`)],
			sample.types.flatMap((type) =>
				type.properties.map((property, position) => ({ id: property.id, type_id: type.id, position })),
			),
		);
		assert.deepEqual(
			[...(await sql`select id, position, name from boards order by position`)],
			sample.boards.map((board, position) => ({ id: board.id, position, name: board.name })),
		);
		assert.deepEqual(
			[...(await sql`select id, board_id, position from cards order by board_id, position`)],
			sample.boards.flatMap((board) =>
				board.cards.map((card, position) => ({ id: card.id, board_id: board.id, position })),
			),
		);
		assert.deepEqual(
			[...(await sql`select id, board_id, position from drawings order by board_id, position`)],
			sample.boards.flatMap((board) =>
				board.drawings.map((drawing, position) => ({ id: drawing.id, board_id: board.id, position })),
			),
		);
		// Every entity's values keep the order their properties have in the type.
		assert.deepEqual(
			[...(await sql`select entity_id, property_id, position from entity_values order by entity_id, position`)],
			sample.entities.flatMap((entity) => {
				const type = sample.types.find((t) => t.id === entity.typeId)!;
				const positions = new Map(type.properties.map((property, position) => [property.id, position] as const));
				return Object.keys(entity.values).map((propertyId) => ({
					entity_id: entity.id,
					property_id: propertyId,
					position: positions.get(propertyId)!,
				}));
			}),
		);
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("a second migration with the same blob changes nothing — no row doubles anywhere", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		const first = await migrateBlob(sampleText, sql);
		assert.equal(first.complete, true);
		const afterFirst = await snapshot(sql);

		const second = await migrateBlob(sampleText, sql);
		assert.equal(second.status, "migrated");
		assert.equal(second.complete, true);
		assert.deepEqual(await snapshot(sql), afterFirst);

		// The counts didn't add up either: still the blob's own numbers, row for row.
		assert.deepEqual(await tableCounts(sql), blobCounts(sample));
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("no blob at all is a valid state: empty tables, complete, no error", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		// Whatever is there gets emptied, so the "no blob" slide starts from a filled state.
		await migrateBlob(sampleText, sql);
		assert.deepEqual(await tableCounts(sql), blobCounts(sample));

		const result = await migrateBlob(null, sql);
		assert.equal(result.status, "empty");
		assert.equal(result.complete, true);
		assert.deepEqual(result.expected, zeroCounts());
		assert.deepEqual(result.actual, zeroCounts());
		assert.deepEqual(await tableCounts(sql), zeroCounts());
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("a blob without the app's shape writes nothing, and the result says so", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		await migrateBlob(sampleText, sql);
		const filled = await snapshot(sql);

		for (const broken of ["kein JSON, nur Worte", "", "null", "4", '{"types":[],"entities":[]}']) {
			const result = await migrateBlob(broken, sql);
			assert.equal(result.status, "invalid");
			assert.equal(result.complete, false, `the broken blob "${broken}" can't count as complete`);
			assert.deepEqual(await snapshot(sql), filled, `the broken blob "${broken}" must leave the tables as they were`);
		}
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("the tables move, the blob doesn't: texts keeps every row and values", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		await storage.setItem(APP_KEY, sampleText);
		const before = await textsSnapshot(sql);

		const result = await migrateBlob(sampleText, sql);
		assert.equal(result.complete, true);

		// Same number of rows in texts, and the app's own row still says exactly what it said.
		const after = await textsSnapshot(sql);
		assert.equal(after.length, before.length);
		assert.deepEqual(after, before);
		assert.equal(await storage.getItem(APP_KEY), sampleText);

		// And for the record: the empty blob, too, leaves texts alone.
		await migrateBlob(null, sql);
		assert.deepEqual(await textsSnapshot(sql), before);
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("a card whose entity is missing doesn't fail the migration — it just never becomes a row", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();

		// The blob carries a card that points at an entity it doesn't carry: the app would never say this,
		// but a migration must not fall over when it sees it anyway.
		const orphan: AppData = {
			...sample,
			boards: [
				{
					...sample.boards[0]!,
					cards: [
						...sample.boards[0]!.cards,
						{ id: "card-orphan", entityId: "ent-gone", x: 0, y: 0, width: 240, height: 160 },
					],
				},
			],
		};
		const orphanText = JSON.stringify(orphan);
		const result = await migrateBlob(orphanText, sql);

		assert.equal(result.status, "migrated");
		assert.equal(result.complete, true, "the migration made the tables describe the blob that is there");
		// The Soll-Zahl counts the card nowhere: the blob's cards, minus the one whose entity is missing.
		const entityIds = new Set(orphan.entities.map((entity) => entity.id));
		const cardsThatCount = orphan.boards.reduce(
			(sum, board) => sum + board.cards.filter((card) => entityIds.has(card.entityId)).length,
			0,
		);
		assert.equal(result.expected.cards, cardsThatCount);
		assert.equal(result.actual.cards, cardsThatCount);

		// And on the table, the row is simply absent — no error, no half-write.
		const found = await sql`select id from cards where id = 'card-orphan'`;
		assert.equal(found.length, 0);
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

/** The empty Ist-Zahlen, the shape every cleared table ends up with. */
function zeroCounts(): TableCounts {
	return {
		entity_types: 0,
		properties: 0,
		entities: 0,
		entity_values: 0,
		boards: 0,
		cards: 0,
		drawings: 0,
	};
}
