import assert from "node:assert/strict";
import postgres from "postgres";
import { test } from "node:test";
import { isBox, type AppData } from "@bekbon/core";
import { APP_KEY, readAppData, readAppDataFromTables } from "./mirror.js";
import { postgresStorage } from "./postgres.js";
import { call, startApp } from "./test-server.js";

/** The database these tests run against; without it they are skipped, not failed. */
const url = process.env.DATABASE_URL;

/** A small fixture: one type, one entity, one board — one row per table to check. */
const small: AppData = {
	types: [
		{
			id: "type-person",
			name: "Person",
			properties: [{ id: "p-note", name: "Notiz", kind: "text", options: [], reference: null, cardDisplay: "hidden" }],
			contentTemplate: "Neue Person",
			color: "#c4dafa",
		},
	],
	entities: [{ id: "ent-ada", typeId: "type-person", name: "Ada", content: "kocht", description: "die erste", values: { "p-note": "mit Ruhe" } }],
	boards: [
		{
			id: "board-1",
			name: "Übersicht",
			cards: [{ id: "card-1", entityId: "ent-ada", x: 10, y: 20, width: 240, height: 160 }],
			viewport: { x: 0, y: 0, zoom: 1 },
			drawings: [{ id: "draw-l", kind: "line", points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: "#4a4a4a" }],
		},
	],
};

/** A realistic fixture: several types of every property kind, entities with values (text, options with
 * several choices, single and multiple references, null, and none at all), several boards, and drawings
 * of every `kind`. The ids stand in an order the alphabet doesn't explain, and the numbers are the ones
 * that don't survive a careless round trip — both must come back exactly as they went in. */
const rich: AppData = {
	types: [
		{
			id: "type-task",
			name: "Aufgabe",
			properties: [
				{ id: "p-status", name: "Status", kind: "options", options: ["offen", "erledigt"], reference: null, cardDisplay: "list" },
				{
					id: "p-owner",
					name: "Verantwortlich",
					kind: "reference",
					options: [],
					reference: { typeId: "type-person", multiple: false, arrow: "to", lineLabel: "hat", inverseLabel: "ist für" },
					cardDisplay: "line",
				},
				{ id: "p-due", name: "Fällig", kind: "text", options: [], reference: null, cardDisplay: "hidden" },
			],
			contentTemplate: "Neue Aufgabe",
			color: "#f9c9c9",
		},
		{
			id: "type-person",
			name: "Person",
			properties: [
				{ id: "p-skill", name: "Fähigkeit", kind: "options", options: ["schneiden", "kochen"], reference: null, cardDisplay: "list" },
				{ id: "p-note", name: "Notiz", kind: "text", options: [], reference: null, cardDisplay: "hidden" },
				{
					id: "p-knows",
					name: "kennt",
					kind: "reference",
					options: [],
					reference: { typeId: "type-person", multiple: true, arrow: "none", lineLabel: "kennt", inverseLabel: "kennt" },
					cardDisplay: "list",
				},
			],
			contentTemplate: "Neue Person",
			color: "#c4dafa",
		},
		{ id: "type-place", name: "Ort", properties: [], contentTemplate: "", color: "#c8ebbf" },
	],
	entities: [
		{
			id: "ent-kueche",
			typeId: "type-place",
			name: "Küche",
			content: "hinten links",
			description: "",
			values: {},
		},
		{
			id: "ent-ada",
			typeId: "type-person",
			name: "Ada",
			content: "kocht",
			description: "die erste",
			values: { "p-skill": null, "p-note": "mit Ruhe", "p-knows": ["ent-bob"] },
		},
		{ id: "ent-bob", typeId: "type-person", name: "Bob", content: "", description: "", values: { "p-skill": ["schneiden", "kochen"] } },
		{
			id: "ent-chef",
			typeId: "type-task",
			name: "Abendessen",
			content: "Suppe für alle",
			description: "jährlich",
			values: { "p-status": "offen", "p-owner": "ent-ada", "p-due": "morgen" },
		},
		{
			id: "ent-aufraeumen",
			typeId: "type-task",
			name: "Ausräumen",
			content: "",
			description: "",
			values: { "p-status": "erledigt", "p-owner": "ent-bob", "p-due": "gestern" },
		},
	],
	boards: [
		{
			id: "board-main",
			name: "Alles zusammen",
			cards: [
				{ id: "card-chef", entityId: "ent-chef", x: 0.1, y: 20.199999999999996, width: 240.50000000000006, height: 79.69519999999999 },
				{ id: "card-ada", entityId: "ent-ada", x: -0.30000000000000004, y: 1e-10, width: 160, height: 80 },
				{ id: "card-bob", entityId: "ent-bob", x: 123456789.123456789, y: -79.95, width: 240, height: 160 },
				{ id: "card-kueche", entityId: "ent-kueche", x: 300.25, y: 40.5, width: 240, height: 160 },
			],
			viewport: { x: -12.34, y: 56.7890123456789, zoom: 0.675 },
			drawings: [
				{ id: "draw-line", kind: "line", points: [{ x: 0, y: 0 }, { x: 5.5, y: 5.25 }], color: "#4a4a4a" },
				{
					id: "draw-pen",
					kind: "pen",
					points: [
						{ x: 0.1, y: 0.2 },
						{ x: 0.30000000000000004, y: 21.4 },
						{ x: 66000000000.000001, y: -0.5 },
					],
					color: "#4a4a4a",
				},
				{ id: "draw-text", kind: "text", x: 0, y: 200.5, width: 100.05, height: 30.005, color: "#4a4a4a", text: "Notiz am Brett", textSize: "l" },
				{ id: "draw-ellipse", kind: "ellipse", x: 20.25, y: 20.75, width: 80.125, height: 40.0625, color: "#f6e8a6", text: "", textSize: "s" },
				{ id: "draw-arrow", kind: "arrow", points: [{ x: 10.1, y: 10.2 }, { x: 50.3, y: 60.4 }], color: "#f9c9c9" },
				{ id: "draw-rect", kind: "rect", x: 0.0000000001, y: 100, width: 3456789012.3456, height: 50.25, color: "#c8ebbf", text: "Ecke", textSize: "m" },
			],
		},
		{
			id: "board-two",
			name: "Zweites Brett",
			cards: [{ id: "card-aufraeumen", entityId: "ent-aufraeumen", x: 0, y: 0, width: 240, height: 160 }],
			viewport: { x: 100, y: 0, zoom: 2 },
			drawings: [],
		},
		{
			id: "board-third",
			name: "Drittes Brett",
			cards: [],
			viewport: { x: 0.5, y: -0.5, zoom: 0.0000001 },
			drawings: [{ id: "draw-ellipse-only", kind: "ellipse", x: 1, y: 2, width: 3, height: 4, color: "#d6ccf7", text: "", textSize: "m" }],
		},
	],
};

/** The saved text of app data, the way `toSaved` writes it: the format version around the three arrays. */
const savedText = (data: AppData, ...extras: [string, unknown][]): string =>
	JSON.stringify({ version: 1, ...Object.fromEntries(extras), ...data });

const smallText = savedText(small);
const richText = savedText(rich);
/** A saved text carrying more than the version around its arrays: whatever else is there must come back
 * out of the tables too, or the read path would answer less than the blob does. */
const extrasText = savedText(small, ["note", "extra info, fuer niemanden brauchbar"]);

test("was aus den Tabellen gebaut ist, ist tiefengleich dem Blob — an mehreren Fixtures und an einem realistischen", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		for (const text of [smallText, extrasText, richText]) {
			await storage.setItem(APP_KEY, text);
			await storage.syncFromText(text);

			// The proof of this step: assembled out of the tables, deeply equal to what the blob hands over —
			// same values, same array order, floats bit for bit.
			const ausTabellen = await readAppDataFromTables(sql);
			assert.deepEqual(ausTabellen, readAppData(text), "aus den Tabellen gebaut != aus dem Blob gelesen");

			// And over the wire: the GET answers a text the app can read, in the same JSON as before.
			const api = await startApp(storage);
			try {
				const got = await call(api.url, `texts/${encodeURIComponent(APP_KEY)}`);
				assert.equal(got.status, 200);
				assert.equal(got.header("content-type"), "text/plain; charset=utf-8");
				// A text the app can read, the way it reads the blob — and the same data as the blob's.
				assert.notEqual(readAppData(got.text), null, "der ausgelieferte Text muesste App-Daten sein");
				assert.deepEqual(readAppData(got.text), readAppData(text), "was GET liefert != was der Blob hergibt");
			} finally {
				await api.close();
			}
		}
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("Reihenfolge und Zahlen: position traegt die Ordnung, Fliesskommazahlen bleiben bit-genau", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		await storage.setItem(APP_KEY, richText);
		await storage.syncFromText(richText);
		const built = await readAppDataFromTables(sql);
		assert.ok(built, "die Tabellen tragen die Daten");

		// Every array comes back in the order the tables' `position` columns hold — not in id or
		// alphabet order, which several of these ids would otherwise suggest.
		assert.deepEqual(built.types.map((type) => type.id), ["type-task", "type-person", "type-place"]);
		assert.deepEqual(built.types[0]!.properties.map((prop) => prop.id), ["p-status", "p-owner", "p-due"]);
		assert.deepEqual(built.entities.map((entity) => entity.id), ["ent-kueche", "ent-ada", "ent-bob", "ent-chef", "ent-aufraeumen"]);
		assert.deepEqual(built.boards.map((board) => board.id), ["board-main", "board-two", "board-third"]);
		assert.deepEqual(built.boards[0]!.cards.map((card) => card.id), ["card-chef", "card-ada", "card-bob", "card-kueche"]);
		assert.deepEqual(built.boards[0]!.drawings.map((drawing) => drawing.id), [
			"draw-line",
			"draw-pen",
			"draw-text",
			"draw-ellipse",
			"draw-arrow",
			"draw-rect",
		]);

		// The numbers a careless round trip wouldn't survive: same double, bit for bit, on the cards,
		// the viewports and the drawings alike.
		const main = built.boards[0]!;
		const chef = main.cards.find((card) => card.id === "card-chef")!;
		assert.equal(chef.x, 0.1);
		assert.equal(chef.y, 20.199999999999996);
		assert.equal(chef.width, 240.50000000000006);
		assert.equal(chef.height, 79.69519999999999);
		assert.equal(main.viewport.zoom, 0.675);
		assert.equal(main.viewport.y, 56.7890123456789);
		assert.equal(built.boards[2]!.viewport.zoom, 0.0000001);
		const rect = main.drawings.find((drawing) => drawing.id === "draw-rect")!;
		assert.ok(isBox(rect));
		if (isBox(rect)) {
			assert.equal(rect.x, 0.0000000001);
			assert.equal(rect.width, 3456789012.3456);
		}
		const pen = main.drawings.find((drawing) => drawing.id === "draw-pen")!;
		assert.ok(!isBox(pen));
		if ("points" in pen) assert.deepEqual(pen.points[2], { x: 66000000000.000001, y: -0.5 });
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("nach jedem Speichern lesen Tabellen und Blob wieder dasselbe — der Spiegel wird ja neu gebaut", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	try {
		await storage.init();
		// Whatever an earlier test left under the app's key goes first: this test needs the first-save
		// path, which only passes under a key nothing is stored under.
		await storage.removeItem(APP_KEY);
		const api = await startApp(storage);
		const path = `texts/${encodeURIComponent(APP_KEY)}`;
		try {
			// The first save puts rich data in; the GET answers it — from the tables, deep-equal the blob.
			const first = await call(api.url, path, { method: "PUT", body: richText });
			assert.equal(first.status, 204);
			const gotRich = await call(api.url, path);
			assert.deepEqual(readAppData(gotRich.text), readAppData(richText));
			assert.equal(gotRich.header("etag"), first.header("etag"));

			// A save of other data rebuilds the mirror out of the new blob — the reads agree again.
			const second = await call(api.url, path, { method: "PUT", body: smallText, headers: { "if-match": first.header("etag")! } });
			assert.equal(second.status, 204);
			const gotSmall = await call(api.url, path);
			assert.deepEqual(readAppData(gotSmall.text), readAppData(smallText));
			assert.equal(gotSmall.header("etag"), second.header("etag"));

			const third = await call(api.url, path, { method: "PUT", body: richText, headers: { "if-match": second.header("etag")! } });
			assert.equal(third.status, 204);
			const gotRichAgain = await call(api.url, path);
			assert.deepEqual(readAppData(gotRichAgain.text), readAppData(richText));

			// The blob itself went along with every save, untouched by the read path.
			assert.equal(await storage.getItem(APP_KEY), richText);
		} finally {
			await api.close();
		}
	} finally {
		await storage.close();
	}
});

test("Rueckfallebene: keine Tabellenzeilen, aber ein Blob — GET liefert den Blob, nicht leer und ohne Fehler", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	const sql = postgres(url, { connect_timeout: 5 });
	try {
		await storage.init();
		await storage.setItem(APP_KEY, richText);
		await storage.syncFromText(richText);

		// The state of a database before its first sync: a blob, and not a row in any derived table. Only
		// the mirror's own tables are cleared here, the way its own sync does; `texts` keeps every row.
		await sql`truncate entity_types, properties, entities, entity_values, boards, cards, drawings`;
		assert.deepEqual(await readAppDataFromTables(sql), null, "ohne Tabellenzeilen gibt es aus den Tabellen nichts");

		// Reading falls back onto the blob, word for word — the app never sees an empty answer.
		const stored = await storage.read(APP_KEY);
		assert.equal(stored?.text, richText);
		assert.ok(stored?.version, "die Version gehoert zur Antwort");

		const api = await startApp(storage);
		try {
			const got = await call(api.url, `texts/${encodeURIComponent(APP_KEY)}`);
			assert.equal(got.status, 200);
			assert.equal(got.text, richText, "GET liefert den Blob als Rueckfallebene, Wort fuer Wort");
			assert.equal(got.header("etag"), stored?.version);
		} finally {
			await api.close();
		}
	} finally {
		await storage.close();
		await sql.end({ timeout: 5 });
	}
});

test("Rueckfallebene: gehen die Tabellen beim Lesen kaputt, antwortet der Blob — nie ein Fehler", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	try {
		await storage.init();
		await storage.setItem(APP_KEY, richText);
		await storage.syncFromText(richText);
		const stored = await storage.read(APP_KEY);
		assert.ok(stored);
		assert.deepEqual(readAppData(stored.text), readAppData(richText));

		const api = await startApp(storage);
		try {
			// The tables turn unreadable, the way a half-finished upgrade or an accident would: no assembled
			// answer can come out of them anymore.
			const sql = postgres(url!, { connect_timeout: 5 });
			try {
				await sql`drop table cards`;
			} finally {
				await sql.end({ timeout: 5 });
			}

			const got = await call(api.url, `texts/${encodeURIComponent(APP_KEY)}`);
			assert.equal(got.status, 200, "kein Fehler, keine leere App — der Blob antwortet");
			assert.equal(got.text, richText);
			assert.equal(got.header("etag"), stored.version);
		} finally {
			await api.close();
			// The tables return, filled anew from the blob — nothing here stays broken behind this test.
			await storage.mirror.init();
			await storage.syncFromText(richText);
		}
		const healed = await storage.read(APP_KEY);
		assert.deepEqual(readAppData(healed?.text ?? ""), readAppData(richText));
	} finally {
		await storage.close();
	}
});

test("eine leere App bleibt lesbar: ohne eine Tabellenzeile antwortet der Blob denselben Inhalt", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	try {
		await storage.init();
		// An app whose data is empty saves an empty blob — the mirrored tables hold no row for it. The
		// read falls back onto the blob, which is exactly the same answer: empty, but never absent.
		const emptyText = JSON.stringify({ version: 1, types: [], entities: [], boards: [] });
		await storage.setItem(APP_KEY, emptyText);
		await storage.syncFromText(emptyText);

		const api = await startApp(storage);
		try {
			const got = await call(api.url, `texts/${encodeURIComponent(APP_KEY)}`);
			assert.equal(got.status, 200);
			assert.equal(got.text, emptyText);
			assert.deepEqual(readAppData(got.text), { version: 1, types: [], entities: [], boards: [] });
		} finally {
			await api.close();
		}
	} finally {
		await storage.close();
	}
});

test("loescht jemand den Blob, antwortet das GET 404 wie bisher — Spiegelzeilen erwecken nichts wieder", { skip: !url }, async () => {
	assert.ok(url);
	const storage = postgresStorage(url);
	try {
		await storage.init();
		await storage.setItem(APP_KEY, richText);
		await storage.syncFromText(richText);

		const api = await startApp(storage);
		try {
			const removed = await call(api.url, `texts/${encodeURIComponent(APP_KEY)}`, { method: "DELETE" });
			assert.equal(removed.status, 204);
			const gone = await call(api.url, `texts/${encodeURIComponent(APP_KEY)}`);
			assert.equal(gone.status, 404);
		} finally {
			await api.close();
		}
	} finally {
		await storage.close();
	}
});

