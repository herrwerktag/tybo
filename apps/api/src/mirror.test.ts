import assert from "node:assert/strict";
import postgres from "postgres";
import { test } from "node:test";
import type { AppData } from "@bekbon/core";
import { APP_KEY, readAppData, type Sql } from "./mirror.js";
import { postgresStorage } from "./postgres.js";
import { call, startApp } from "./test-server.js";

/** The database these tests run against; without it they are skipped, not failed. */
const url = process.env.DATABASE_URL;

/** Example app data, small enough that every mirror table gets exactly the rows one can check. */
const sample: AppData = {
	types: [
		{
			id: "type-role",
			name: "Rolle",
			properties: [
				{
					id: "prop-per",
					name: "Personen",
					kind: "reference",
					options: [],
					reference: { typeId: "type-person", multiple: true, arrow: "none", lineLabel: "", inverseLabel: "ist" },
					cardDisplay: "line",
				},
			],
			contentTemplate: "",
			color: "#f9c9c9",
		},
		{
			id: "type-person",
			name: "Person",
			properties: [
				{ id: "prop-skill", name: "Fähigkeit", kind: "options", options: ["schneiden", "kochen"], reference: null, cardDisplay: "list" },
				{ id: "prop-note", name: "Notiz", kind: "text", options: [], reference: null, cardDisplay: "hidden" },
			],
			contentTemplate: "Neue Person",
			color: "#c4dafa",
		},
	],
	entities: [
		{
			id: "ent-1",
			typeId: "type-person",
			name: "Ada",
			content: "kocht",
			description: "die erste",
			values: { "prop-skill": ["kochen"], "prop-note": "mit Ruhe" },
		},
		{ id: "ent-2", typeId: "type-role", name: "Chef", content: "", description: "", values: { "prop-per": ["ent-1"] } },
	],
	boards: [
		{
			id: "board-1",
			name: "Übersicht",
			cards: [{ id: "card-1", entityId: "ent-1", x: 10, y: 20, width: 240, height: 160 }],
			viewport: { x: 0, y: 0, zoom: 1 },
			drawings: [
				{ id: "draw-1", kind: "rect", x: 0, y: 0, width: 100, height: 50, color: "#f9c9c9", text: "", textSize: "m" },
				{ id: "draw-2", kind: "line", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: "#4a4a4a" },
			],
		},
	],
};

const sampleText = JSON.stringify(sample);

/** What each mirror table holds for the sample: the counts queries and `mirror_meta` both answer. */
const sampleCounts = {
	entity_types: 2,
	properties: 3,
	entities: 2,
	entity_values: 3,
	boards: 1,
	cards: 1,
	drawings: 2,
} as const;

/** The mirror's tables, without `mirror_meta`, which holds the markers instead of the data. */
const mirrorTables = ["entity_types", "properties", "entities", "entity_values", "boards", "cards", "drawings"] as const;

/** How many rows each mirror table holds — the table names are the file's own constants, nowhere else. */
async function mirrorCounts(sql: Sql): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const table of mirrorTables) {
		const [row] = await sql`select count(*)::int as count from ${sql(table)}`;
		counts[table] = row?.count ?? 0;
	}
	return counts;
}

/** The rows of `texts` this file has a say over: the app's blob key and this file's sentinel keys. Whatever
 * the tests do, these must stay exactly as they were — the mirror never writes `texts`. */
async function textsSnapshot(sql: Sql): Promise<{ key: string; value: string }[]> {
	return sql`select key, value from texts
		where key = ${APP_KEY} or key like 'mirror-test:%'
		order by key`;
}

test("readAppData takes only the app's shape, and everything else stays null", () => {
	assert.deepEqual(readAppData(sampleText), sample);
	assert.deepEqual(readAppData('{"types":[],"entities":[],"boards":[]}'), { types: [], entities: [], boards: [] });

	assert.equal(readAppData('{"types":[],"entities":[]}'), null, "boards are missing");
	assert.equal(readAppData('{"types":1,"entities":[],"boards":[]}'), null, "types isn't an array");
	assert.equal(readAppData('{"types":[],"entities":[],"boards":{}}'), null, "boards isn't an array");
	assert.equal(readAppData("garbage, not even json"), null);
	assert.equal(readAppData("null"), null);
	assert.equal(readAppData("[]"), null);
	assert.equal(readAppData("4"), null);
});

test("the mirror tables carry their read-only markers, and syncMirror fills them with the app's data", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();

		// Every mirror table says the same thing: this copy isn't the place to write.
		const [described] = await sql`select obj_description('entities'::regclass) as description`;
		assert.match(described?.description, /NICHT hier schreiben/);

		// The blob holds the sample, so what a concurrent start-up fill would write matches.
		await storage.setItem(APP_KEY, sampleText);
		await storage.mirror.syncMirror(sample);

		const entityTypes = [...await sql`select id, position, name, content_template, color from entity_types order by position`];
		assert.deepEqual(entityTypes, [
			{ id: "type-role", position: 0, name: "Rolle", content_template: "", color: "#f9c9c9" },
			{ id: "type-person", position: 1, name: "Person", content_template: "Neue Person", color: "#c4dafa" },
		]);

		const properties = [...await sql`select id, type_id, position, name, kind, options, reference, card_display
			from properties order by type_id, position`];
		assert.deepEqual(properties, [
			{
				id: "prop-skill",
				type_id: "type-person",
				position: 0,
				name: "Fähigkeit",
				kind: "options",
				options: ["schneiden", "kochen"],
				reference: null,
				card_display: "list",
			},
			{ id: "prop-note", type_id: "type-person", position: 1, name: "Notiz", kind: "text", options: [], reference: null, card_display: "hidden" },
			{
				id: "prop-per",
				type_id: "type-role",
				position: 0,
				name: "Personen",
				kind: "reference",
				options: [],
				reference: { typeId: "type-person", multiple: true, arrow: "none", lineLabel: "", inverseLabel: "ist" },
				card_display: "line",
			},
		]);

		const entities = [...await sql`select id, type_id, name, content, description from entities order by id`];
		assert.deepEqual(entities, [
			{ id: "ent-1", type_id: "type-person", name: "Ada", content: "kocht", description: "die erste" },
			{ id: "ent-2", type_id: "type-role", name: "Chef", content: "", description: "" },
		]);

		const values = [...await sql`select entity_id, property_id, position, value from entity_values order by entity_id, position`];
		assert.deepEqual(values, [
			{ entity_id: "ent-1", property_id: "prop-skill", position: 0, value: ["kochen"] },
			{ entity_id: "ent-1", property_id: "prop-note", position: 1, value: "mit Ruhe" },
			{ entity_id: "ent-2", property_id: "prop-per", position: 0, value: ["ent-1"] },
		]);

		const boards = [...await sql`select id, position, name, viewport from boards`];
		assert.deepEqual(boards, [{ id: "board-1", position: 0, name: "Übersicht", viewport: { x: 0, y: 0, zoom: 1 } }]);

		const cards = [...await sql`select id, board_id, entity_id, position, x, y, width, height from cards`];
		assert.deepEqual(cards, [{ id: "card-1", board_id: "board-1", entity_id: "ent-1", position: 0, x: 10, y: 20, width: 240, height: 160 }]);

		const drawings = [...await sql`select id, board_id, position, kind, body from drawings order by position`];
		assert.deepEqual(drawings, [
			{
				id: "draw-1",
				board_id: "board-1",
				position: 0,
				kind: "rect",
				body: { id: "draw-1", kind: "rect", x: 0, y: 0, width: 100, height: 50, color: "#f9c9c9", text: "", textSize: "m" },
			},
			{
				id: "draw-2",
				board_id: "board-1",
				position: 1,
				kind: "line",
				body: { id: "draw-2", kind: "line", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: "#4a4a4a" },
			},
		]);

		assert.deepEqual(await mirrorCounts(sql), sampleCounts);
		const [sync] = await sql`select value from mirror_meta where key = 'sync'`;
		assert.equal(sync?.value.source_key, APP_KEY);
		assert.deepEqual(sync?.value.counts, sampleCounts);
		assert.equal(typeof sync?.value.synced_at, "string");
		const [direction] = await sql`select value from mirror_meta where key = 'direction'`;
		assert.match(direction?.value.text, /Quelle der Wahrheit/);
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("the mirror overwrites contradictory rows, never the other way around — texts stays untouched", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		await storage.setItem(APP_KEY, sampleText);
		await storage.mirror.syncMirror(sample);

		// Rows the blob never knew: an entity no app data contains, and its card.
		await sql`insert into entities (id, type_id, name, content, description)
			values ('ent-ghost', 'type-person', 'Ghost', 'widerspricht dem Blob', 'widerspricht dem Blob')`;
		await sql`insert into cards (id, board_id, entity_id, position, x, y, width, height)
			values ('card-ghost', 'board-1', 'ent-ghost', 9, 0, 0, 10, 10)`;
		await storage.setItem("mirror-test:sentinel", "bleib stehen");

		const textsBefore = await textsSnapshot(sql);

		await storage.syncFromText(sampleText);

		// The ghosts are gone: the mirror describes exactly the blob again.
		const ghosts = await sql`select id from entities where id = 'ent-ghost'`;
		assert.equal(ghosts.length, 0);
		const ghostCards = await sql`select id from cards where id = 'card-ghost'`;
		assert.equal(ghostCards.length, 0);
		assert.deepEqual(await mirrorCounts(sql), sampleCounts);

		// And texts is where it was, down to the row: the mirror never writes it.
		assert.deepEqual(await textsSnapshot(sql), textsBefore);
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("input without the app's shape writes nothing; empty app data empties the mirror", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		await storage.setItem(APP_KEY, sampleText);
		await storage.mirror.syncMirror(sample);
		const filled = await mirrorCounts(sql);
		const [metaBefore] = await sql`select value from mirror_meta where key = 'sync'`;

		// Neither unreadable text nor mis-shaped input may empty or change the filled mirror.
		await storage.syncFromText("kein JSON, nur Worte");
		await storage.syncFromText('{"types":[],"entities":[]}'); // boards fehlen
		await storage.mirror.syncMirror({ types: [], entities: [] } as unknown as AppData);
		assert.deepEqual(await mirrorCounts(sql), filled);
		const [metaAfter] = await sql`select value from mirror_meta where key = 'sync'`;
		assert.deepEqual(metaAfter, metaBefore);

		// Empty but well-formed app data is a valid state: the mirror copies it faithfully, all of it.
		const empty = JSON.stringify({ types: [], entities: [], boards: [] });
		await storage.setItem(APP_KEY, empty);
		await storage.syncFromText(empty);
		assert.deepEqual(await mirrorCounts(sql), {
			entity_types: 0,
			properties: 0,
			entities: 0,
			entity_values: 0,
			boards: 0,
			cards: 0,
			drawings: 0,
		});
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("start-up init fills the mirror from the blob once — and leaves it empty without one", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		// A mirror without app data, and no blob to fill from.
		await storage.init();
		await storage.setItem(APP_KEY, JSON.stringify({ types: [], entities: [], boards: [] }));
		await storage.syncFromText(JSON.stringify({ types: [], entities: [], boards: [] }));
		await storage.removeItem(APP_KEY);
		assert.equal(await storage.getItem(APP_KEY), null);

		// The start-up init with no blob: an empty mirror is a valid state, not a failure.
		await storage.init();
		assert.deepEqual(await mirrorCounts(sql), {
			entity_types: 0,
			properties: 0,
			entities: 0,
			entity_values: 0,
			boards: 0,
			cards: 0,
			drawings: 0,
		});

		// With a blob, the very same init makes it visible in the mirror, no matter how often it runs.
		await storage.setItem(APP_KEY, sampleText);
		await storage.init();
		await storage.init();
		assert.deepEqual(await mirrorCounts(sql), sampleCounts);
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("saving through the API mirrors the app's key — other keys and unreadable text leave the mirror alone", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		await storage.setItem(APP_KEY, sampleText);
		await storage.mirror.syncMirror(sample);

		const api = await startApp(storage);
		try {
			// Saving now names the stand it read; this test reads the current version before each PUT. Text that
			// doesn't read as app data is stored, but the mirror keeps showing the last app data.
			const current = async () => (await call(api.url, `texts/${encodeURIComponent(APP_KEY)}`)).header("etag")!;
			const stored = await call(api.url, `texts/${encodeURIComponent(APP_KEY)}`, {
				method: "PUT",
				body: "keine App-Daten",
				headers: { "if-match": await current() },
			});
			assert.equal(stored.status, 204);
			assert.equal(await storage.getItem(APP_KEY), "keine App-Daten");
			assert.deepEqual(await mirrorCounts(sql), sampleCounts);

			// App data under another key is stored like any text, mirrored never. Last run's row (if any) goes
			// first: over stored data, a save has to name a stand.
			await storage.removeItem("mirror-test:other");
			const other = await call(api.url, "texts/mirror-test:other", { method: "PUT", body: sampleText });
			assert.equal(other.status, 204);
			assert.deepEqual(await mirrorCounts(sql), sampleCounts);

			// Saving the app's data through the API puts it into the mirror, exactly as saved.
			const saved = await call(api.url, `texts/${encodeURIComponent(APP_KEY)}`, {
				method: "PUT",
				body: sampleText,
				headers: { "if-match": await current() },
			});
			assert.equal(saved.status, 204);
			assert.equal(await storage.getItem(APP_KEY), sampleText);
			assert.deepEqual(await mirrorCounts(sql), sampleCounts);
			const values = await sql`select entity_id, property_id, value from entity_values order by entity_id, position`;
			assert.deepEqual(values.map(({ value }) => value), [["kochen"], "mit Ruhe", ["ent-1"]]);
		} finally {
			await api.close();
		}
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});
