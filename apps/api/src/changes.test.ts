import assert from "node:assert/strict";
import postgres from "postgres";
import { test } from "node:test";
import { changesBetween, type AppData, type Change } from "@bekbon/core";
import { APP_KEY, readAppData, readAppDataFromTables } from "./mirror.js";
import { postgresStorage } from "./postgres.js";
import { call, startApp } from "./test-server.js";

/** The database these tests run against; without it they are skipped, not failed. */
const url = process.env.DATABASE_URL;

/** A state of the app's data: one type with a text property, two entities, one board with two cards and
 * one drawing — enough of every unit to change, add or delete one without touching the others. */
function state(): AppData {
	return {
		types: [
			{
				id: "type-person",
				name: "Person",
				properties: [{ id: "p-note", name: "Notiz", kind: "text", options: [], reference: null, cardDisplay: "list" }],
				contentTemplate: "",
				color: "#c4dafa",
			},
		],
		entities: [
			{ id: "ent-ada", typeId: "type-person", name: "Ada", content: "kocht", description: "die erste", values: { "p-note": "mit Ruhe" } },
			{ id: "ent-bob", typeId: "type-person", name: "Bob", content: "", description: "", values: {} },
		],
		boards: [
			{
				id: "board-1",
				name: "Übersicht",
				cards: [
					{ id: "card-ada", entityId: "ent-ada", x: 10, y: 20, width: 240, height: 160 },
					{ id: "card-bob", entityId: "ent-bob", x: 330.5, y: -40, width: 160, height: 80 },
				],
				viewport: { x: 0, y: 0, zoom: 1 },
				drawings: [{ id: "draw-line", kind: "line", points: [{ x: 0, y: 0 }, { x: 5.5, y: 5.25 }], color: "#4a4a4a" }],
			},
		],
	};
}

/** The saved text of app data, the way `toSaved` writes it: the format version around the three arrays. */
const savedText = (data: AppData): string => JSON.stringify({ version: 1, ...data });

const path = `texts/${encodeURIComponent(APP_KEY)}`;
const changesPath = `${path}/changes`;

/** The whole situation of a test: the storage against the database, the API over it, and a connection of
 * the tests' own to look into the tables with. close() closes all three again. */
async function theApp() {
	const storage = postgresStorage(url!);
	const sql = postgres(url!, { connect_timeout: 5 });
	await storage.init();
	// The tests need the first-save path, which only passes under a key nothing is stored under.
	await storage.removeItem(APP_KEY);
	const api = await startApp(storage);
	return {
		storage,
		sql,
		url: api.url,
		close: async () => {
			await api.close();
			await storage.close();
			await sql.end({ timeout: 5 });
		},
	};
}

type Testing = Awaited<ReturnType<typeof theApp>>;

/** The app's first save, the way a store without anything stored yet makes it: the whole document, no
 * stand to name — its change sets build on it afterwards. Answers the version its 204 named. */
async function firstSave(app: Testing, data: AppData): Promise<string> {
	const saved = await call(app.url, path, { method: "PUT", body: savedText(data) });
	assert.equal(saved.status, 204);
	const version = saved.header("etag")!;
	assert.ok(version);
	return version;
}

/** A change-set save over the wire, building on `version` — however out of date the caller wants it.
 * Answers the API's `{ version, collided }`. */
async function saveChanges(app: Testing, changes: readonly Change[], version: string | null): Promise<{ version: string; collided: string[] }> {
	const saved = await call(app.url, changesPath, {
		method: "PUT",
		body: JSON.stringify(changes),
		headers: version ? { "if-match": version } : {},
	});
	assert.equal(saved.status, 200, `the change set went in (${saved.text})`);
	const answer = JSON.parse(saved.text) as { version: string; collided: string[] };
	assert.equal(answer.version, saved.header("etag"), "the answer's version travels in the etag too");
	return answer;
}

/** Everything that tells the app its stand says the same: the tables read as one, the blob that answers
 * a read, the GET over the wire — deep-equal the expected stand and at `version`. */
async function assertServes(app: Testing, expected: AppData, version: string): Promise<void> {
	assert.deepEqual(await readAppDataFromTables(app.sql), readAppData(savedText(expected)), "deep-equal what the tables read");
	const stored = await app.storage.read(APP_KEY);
	assert.ok(stored);
	assert.deepEqual(readAppData(stored.text), readAppData(savedText(expected)), "deep-equal what a read answers");
	assert.equal(stored.version, version);
	const got = await call(app.url, path);
	assert.equal(got.status, 200);
	assert.deepEqual(readAppData(got.text), readAppData(savedText(expected)), "deep-equal what GET answers");
	assert.equal(got.header("etag"), version);
}

test("The main proof: moving a card and editing an entity don't disturb each other — no conflict, both changes live", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		const seen = await firstSave(app, base);

		// A moves card-ada — to another place and to the front, the way a drag does.
		const a = structuredClone(base);
		const board = a.boards[0]!;
		board.cards = [...board.cards.filter((c) => c.id !== "card-ada"), { ...board.cards[0]!, x: 300.25, y: -5 }];
		const aChanges = changesBetween(base, a);
		// The moved card and its neighbour whose place up front it took — the board itself isn't addressed,
		// least of all the entity someone else is editing.
		assert.deepEqual(aChanges.flatMap((c) => (c.kind === "card" ? [c.id] : [])), ["card-ada", "card-bob"]);
		assert.equal(aChanges.some((c) => c.kind !== "card"), false);

		// B, independently, edits ent-ada's value.
		const b = structuredClone(base);
		b.entities[0]!.values = { "p-note": "im Eiltempo" };
		const bChanges = changesBetween(base, b);
		assert.deepEqual(bChanges.map((c) => c.kind), ["entity"], "B's change set addresses the entity alone");

		const savedA = await saveChanges(app, aChanges, seen);
		assert.deepEqual(savedA.collided, [], "nobody else had the card — no conflict");
		const savedB = await saveChanges(app, bChanges, seen); // on the stand both read — another row though
		assert.deepEqual(savedB.collided, [], "the entity was never the card's row — no conflict, no change lost");
		assert.notEqual(savedB.version, savedA.version);

		// Both changes are there, exactly as they were made; tables, blob and GET agree with each other.
		const both = structuredClone(a);
		both.entities[0]!.values = { "p-note": "im Eiltempo" };
		await assertServes(app, both, savedB.version);
	} finally {
		await app.close();
	}
});

test("Only the rows of the change set's units are touched — a row nobody named keeps its very bits", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		const seen = await firstSave(app, base);

		// Every writable row gets a time long past: whatever a save updates or rebuilds moves its stamp,
		// and a row that was never touched keeps both its content and its stamp.
		const longAgo = new Date(Date.UTC(2001, 0, 1));
		await app.sql`update entity_types set updated_at = timestamptz '2001-01-01 00:00'`;
		await app.sql`update entities set updated_at = timestamptz '2001-01-01 00:00'`;
		await app.sql`update boards set updated_at = timestamptz '2001-01-01 00:00'`;
		const untouchedCardRow = await app.sql`select * from cards where id = 'card-bob'`;

		const a = structuredClone(base);
		a.boards[0]!.cards[0]!.x = -100;
		const b = structuredClone(base);
		b.entities[0]!.values = { "p-note": "together" };
		const savedA = await saveChanges(app, changesBetween(base, a), seen);
		const savedB = await saveChanges(app, changesBetween(base, b), seen);
		assert.notEqual(savedA.version, savedB.version, "both saves really did write");

		// The rows neither change set named: content bit for bit, stamp exactly where it was put.
		const stamps = await app.sql`select updated_at as at from entity_types where id = 'type-person'`;
		assert.equal(new Date(stamps[0]!.at).getTime(), longAgo.getTime(), "the type row was never touched");
		const bobStamp = await app.sql`select updated_at as at from entities where id = 'ent-bob'`;
		assert.equal(new Date(bobStamp[0]!.at).getTime(), longAgo.getTime(), "the untouched entity's row was never touched");
		const boardStamp = await app.sql`select updated_at as at from boards where id = 'board-1'`;
		assert.equal(new Date(boardStamp[0]!.at).getTime(), longAgo.getTime(), "the board row was never touched — a card move isn't the board's");
		assert.deepEqual(await app.sql`select * from cards where id = 'card-bob'`, untouchedCardRow, "the other card kept every bit");

		// The named one's row was really written: its stamp moved.
		const adaStamp = await app.sql`select updated_at as at from entities where id = 'ent-ada'`;
		assert.ok(new Date(adaStamp[0]!.at).getTime() > longAgo.getTime(), "the named unit's row was written");
	} finally {
		await app.close();
	}
});

test("The same unit from two sides: the collision is reported, and the last save wins", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		const seen = await firstSave(app, base);

		// Both change ent-ada's very value, each from the stand both read.
		const mine = structuredClone(base);
		mine.entities[0]!.values = { "p-note": "von A" };
		const theirs = structuredClone(base);
		theirs.entities[0]!.values = { "p-note": "von B" };

		const first = await saveChanges(app, changesBetween(base, mine), seen);
		assert.deepEqual(first.collided, []);
		const second = await saveChanges(app, changesBetween(base, theirs), seen); // on the outdated stand!
		assert.deepEqual(second.collided, ["ent-ada"], "the one unit both changed is reported by its id");

		// The last save won: everything that tells the app its stand says the last stand, the other's
		// value nowhere in it.
		await assertServes(app, theirs, second.version);
	} finally {
		await app.close();
	}
});

test("New and deleted: units appear and disappear in the tables and in every answer", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		const seen = await firstSave(app, base);

		// A new entity (with a value of its type's property), its card on the board; one card gone and
		// the drawing with it (the drawings array emptied).
		const grown = structuredClone(base);
		grown.entities.push({ id: "ent-new", typeId: "type-person", name: "Neu", content: "", description: "", values: { "p-note": "neu hier" } });
		const board = grown.boards[0]!;
		board.cards = [board.cards[0]!, { id: "card-new", entityId: "ent-new", x: 660, y: 12.5, width: 240, height: 160 }];
		board.drawings = [];
		const changes = changesBetween(base, grown);
		assert.deepEqual(changes.map((c) => `${c.kind}:${c.id}`), ["entity:ent-new", "card:card-bob", "card:card-new", "drawing:draw-line"]);
		const byId = new Map(changes.map((change) => [`${change.kind}:${change.id}` as string, change]));
		assert.equal(byId.get("entity:ent-new")!.before, null, "the new entity wasn't there before");
		assert.equal(byId.get("card:card-new")!.before, null, "the new card wasn't there before either");
		assert.equal(byId.get("card:card-bob")!.after, null, "the card is gone");
		assert.equal(byId.get("drawing:draw-line")!.after, null, "the drawing is gone");

		const saved = await saveChanges(app, changes, seen);
		assert.deepEqual(saved.collided, []);
		await assertServes(app, grown, saved.version); // there they are — card-bob and draw-line gone

		// What the rows themselves say about it:
		const [counts] = await app.sql`select
			(select count(*)::int from entities) as entities,
			(select count(*)::int from cards) as cards,
			(select count(*)::int from drawings) as drawings`;
		assert.deepEqual(counts, { entities: 3, cards: 2, drawings: 0 });

		// And the other way around: the new entity goes again — its card goes with it.
		const shrunk = structuredClone(grown);
		shrunk.entities = shrunk.entities.filter((e) => e.id !== "ent-new");
		shrunk.boards[0]!.cards = shrunk.boards[0]!.cards.filter((c) => c.id !== "card-new");
		const removing = changesBetween(grown, shrunk);
		assert.deepEqual(removing.map((c) => `${c.kind}:${c.id}`), ["entity:ent-new", "card:card-new"]);
		const removed = await saveChanges(app, removing, saved.version);
		assert.deepEqual(removed.collided, []);
		await assertServes(app, shrunk, removed.version); // deeply equal as read — deletes included
		const [afterCounts] = await app.sql`select
			(select count(*)::int from entities) as entities,
			(select count(*)::int from cards) as cards,
			(select count(*)::int from entity_values) as values`;
		assert.deepEqual(afterCounts, { entities: 2, cards: 1, values: 1 });
	} finally {
		await app.close();
	}
});

test("An empty change set writes nothing at all: no row, no blob, no version moves", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		const seen = await firstSave(app, base);
		const blobBefore = await app.sql`select value, revision from texts where key = ${APP_KEY}`;

		const answer = await saveChanges(app, [], seen);
		assert.deepEqual(answer.collided, []);
		assert.equal(answer.version, seen, "the version stands where it stood");

		const blobAfter = await app.sql`select value, revision from texts where key = ${APP_KEY}`;
		assert.deepEqual(blobAfter, blobBefore, "not even the blob's row was touched");
		const [syncRow] = await app.sql`select updated_at as at from entities where id = 'ent-ada'`;
		assert.ok(syncRow, "the tables answered, exactly as they did before");
	} finally {
		await app.close();
	}
});

test("A change set the tables can't answer never writes anything half: 503, tables and blob as they were", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		await firstSave(app, base);
		const blobBefore = await app.sql`select value, revision from texts where key = ${APP_KEY}`;
		const rowsBefore = await app.sql`select id from cards order by id`;

		// A card for an entity that doesn't exist: the tables' reference refuses it, and the whole save
		// with it — whatever it wrote before failing is rolled back with it.
		const refused = await call(app.url, changesPath, {
			method: "PUT",
			body: JSON.stringify([
				{
					kind: "card",
					id: "card-dream",
					boardId: "board-1",
					before: null,
					after: { value: { id: "card-dream", entityId: "ent-gone", x: 0, y: 0, width: 10, height: 10 }, position: 0 },
				},
			]),
		});
		assert.equal(refused.status, 503);

		assert.deepEqual(await app.sql`select id from cards order by id`, rowsBefore, "no row was written");
		const blobAfter = await app.sql`select value, revision from texts where key = ${APP_KEY}`;
		assert.deepEqual(blobAfter, blobBefore, "the blob and version are where they were");
	} finally {
		await app.close();
	}
});

test("A whole-document save between change sets keeps the two in step — and the next change set builds on it", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		const seen = await firstSave(app, base);

		// A first change set: A moves the card and renames the board.
		const a = structuredClone(base);
		a.boards[0]!.name = "Plan";
		a.boards[0]!.cards[0]!.x = 40;
		const savedA = await saveChanges(app, changesBetween(base, a), seen);
		assert.deepEqual(savedA.collided, []);

		// Then someone saves the whole document over it — an older client, say: the mirror is rebuilt
		// from the blob, exactly as it always is.
		const whole = structuredClone(a);
		whole.entities[1]!.name = "Bobby";
		const put = await call(app.url, path, { method: "PUT", body: savedText(whole), headers: { "if-match": savedA.version } });
		assert.equal(put.status, 204);
		assert.notEqual(put.header("etag"), savedA.version);

		// And the change sets go right on from there, over the rebuilt tables.
		const mine = structuredClone(whole);
		mine.entities[0]!.values = { "p-note": "endet hier" };
		const savedMine = await saveChanges(app, changesBetween(whole, mine), put.header("etag"));
		assert.deepEqual(savedMine.collided, [], "the rebuilt tables answer what the change set asks");
		await assertServes(app, mine, savedMine.version);
	} finally {
		await app.close();
	}
});

test("A wiped mirror with a blob: a change set fills the tables from the blob first, and nothing is lost", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		const seen = await firstSave(app, base);
		// The state of a mirror emptied by hand: the blob answers, and there isn't a row to read — the
		// read path's fallback in full view.
		await app.sql`truncate entity_types, properties, entities, entity_values, boards, cards, drawings`;
		const fellBack = await app.storage.read(APP_KEY);
		assert.ok(fellBack, "the blob answers where the tables can't");

		// A change set arrives against that state: it can't be written on rows that don't say what the
		// change's `before` stands came from — so the blob is filled into the tables first, here, and the
		// save goes through all-or-nothing, with nothing of the blob lost on the way.
		const mine = structuredClone(base);
		mine.entities[0]!.values = { "p-note": "im Eiltempo" };
		const saved = await saveChanges(app, changesBetween(base, mine), seen);
		assert.deepEqual(saved.collided, []);

		await assertServes(app, mine, saved.version); // the tables answer again, and deeply equal
	} finally {
		await app.close();
	}
});
