import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { test } from "node:test";
import { changesBetween, type AppData, type Change } from "@bekbon/core";
import { readWorkspace } from "./data.js";
import { postgresStorage } from "./postgres.js";
import { call, startApp } from "./test-server.js";

/** The test database these tests run against (never the productive DATABASE_URL); without it they are skipped, not failed. */
const url = process.env.TEST_DATABASE_URL;

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
				kind: "storyboard",
				cards: [
					{ id: "card-ada", entityId: "ent-ada", x: 10, y: 20, width: 240, height: 160 },
					{ id: "card-bob", entityId: "ent-bob", x: 330.5, y: -40, width: 160, height: 80 },
				],
				viewport: { x: 0, y: 0, zoom: 1 },
				drawings: [{ id: "draw-line", kind: "line", points: [{ x: 0, y: 0 }, { x: 5.5, y: 5.25 }], color: "#4a4a4a" }],
				pages: [
					{
						id: "page-1",
						name: "Anfang",
						description: "Nur **Ada**",
						descriptionPosition: { x: 250.5, y: 120 },
						viewport: { x: -10, y: 20, zoom: 1.5 },
						cardIds: ["card-ada"],
						drawingIds: ["draw-line"],
					},
				],
			},
		],
	};
}

/** A workspace before its first save: nothing in it, not even a board. */
const empty = (): AppData => ({ types: [], entities: [], boards: [] });

/** The whole situation of a test: the storage against the database, the API over it, a workspace of the
 * test's own (no other test sees its rows), and a connection of the tests' own to look into the tables
 * with. close() deletes the workspace and closes all three again. */
async function theApp() {
	const storage = postgresStorage(url!);
	const sql = postgres(url!, { connect_timeout: 5 });
	await storage.init();
	const ws = `api-test:${randomUUID()}`;
	assert.equal(await storage.createWorkspace({ id: ws, name: "Test" }, 1), true);
	const api = await startApp(storage);
	const base = `workspaces/${encodeURIComponent(ws)}`;
	return {
		storage,
		sql,
		ws,
		url: api.url,
		dataPath: `${base}/data`,
		changesPath: `${base}/changes`,
		close: async () => {
			await api.close();
			await storage.deleteWorkspace(ws);
			await storage.close();
			await sql.end({ timeout: 5 });
		},
	};
}

type Testing = Awaited<ReturnType<typeof theApp>>;

/** A change-set save over the wire — the version it builds on travels along for the record; the units'
 * own `before` stands decide what collided. Answers the API's `{ version, collided }`. */
async function saveChanges(app: Testing, changes: readonly Change[]): Promise<{ version: string; collided: string[] }> {
	const saved = await call(app.url, app.changesPath, { method: "PUT", body: JSON.stringify(changes) });
	assert.equal(saved.status, 200, `the change set went in (${saved.text})`);
	const answer = JSON.parse(saved.text) as { version: string; collided: string[] };
	assert.equal(answer.version, saved.header("etag"), "the answer's version travels in the etag too");
	return answer;
}

/** The app's first save into the empty workspace: every unit new. Answers the version it reached. */
async function firstSave(app: Testing, data: AppData): Promise<string> {
	const saved = await saveChanges(app, changesBetween(empty(), data));
	assert.deepEqual(saved.collided, []);
	return saved.version;
}

/** Everything that tells the app its stand says the same: the read of the tables, and the GET over the
 * wire — deep-equal the expected stand (in format 1) and at `version`. */
async function assertServes(app: Testing, expected: AppData, version: string): Promise<void> {
	const stored = await readWorkspace(app.sql, app.ws);
	assert.ok(stored);
	assert.deepEqual(stored.data, { version: 1, ...expected }, "deep-equal what the tables read");
	assert.equal(stored.revision, version);
	const got = await call(app.url, app.dataPath);
	assert.equal(got.status, 200);
	assert.deepEqual(JSON.parse(got.text), { version: 1, ...expected }, "deep-equal what GET answers");
	assert.equal(got.header("etag"), version);
}

test("The main proof: moving a card and editing an entity don't disturb each other — no conflict, both changes live", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		await firstSave(app, base);

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

		const savedA = await saveChanges(app, aChanges);
		assert.deepEqual(savedA.collided, [], "nobody else had the card — no conflict");
		const savedB = await saveChanges(app, bChanges); // built on the stand both read — another row though
		assert.deepEqual(savedB.collided, [], "the entity was never the card's row — no conflict, no change lost");
		assert.notEqual(savedB.version, savedA.version);

		// Both changes are there, exactly as they were made; the tables and GET agree with each other.
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
		await firstSave(app, base);

		// Every writable row gets a time long past: whatever a save updates or rebuilds moves its stamp,
		// and a row that was never touched keeps both its content and its stamp.
		const longAgo = new Date(Date.UTC(2001, 0, 1));
		await app.sql`update entity_types set updated_at = timestamptz '2001-01-01 00:00' where workspace_id = ${app.ws}`;
		await app.sql`update entities set updated_at = timestamptz '2001-01-01 00:00' where workspace_id = ${app.ws}`;
		await app.sql`update boards set updated_at = timestamptz '2001-01-01 00:00' where workspace_id = ${app.ws}`;
		const untouchedCardRow = await app.sql`select * from cards where workspace_id = ${app.ws} and id = 'card-bob'`;

		const a = structuredClone(base);
		a.boards[0]!.cards[0]!.x = -100;
		const b = structuredClone(base);
		b.entities[0]!.values = { "p-note": "together" };
		const savedA = await saveChanges(app, changesBetween(base, a));
		const savedB = await saveChanges(app, changesBetween(base, b));
		assert.notEqual(savedA.version, savedB.version, "both saves really did write");

		// The rows neither change set named: content bit for bit, stamp exactly where it was put.
		const stamps = await app.sql`select updated_at as at from entity_types where workspace_id = ${app.ws} and id = 'type-person'`;
		assert.equal(new Date(stamps[0]!.at).getTime(), longAgo.getTime(), "the type row was never touched");
		const bobStamp = await app.sql`select updated_at as at from entities where workspace_id = ${app.ws} and id = 'ent-bob'`;
		assert.equal(new Date(bobStamp[0]!.at).getTime(), longAgo.getTime(), "the untouched entity's row was never touched");
		const boardStamp = await app.sql`select updated_at as at from boards where workspace_id = ${app.ws} and id = 'board-1'`;
		assert.equal(new Date(boardStamp[0]!.at).getTime(), longAgo.getTime(), "the board row was never touched — a card move isn't the board's");
		assert.deepEqual(await app.sql`select * from cards where workspace_id = ${app.ws} and id = 'card-bob'`, untouchedCardRow, "the other card kept every bit");

		// The named one's row was really written: its stamp moved.
		const adaStamp = await app.sql`select updated_at as at from entities where workspace_id = ${app.ws} and id = 'ent-ada'`;
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
		await firstSave(app, base);

		// Both change ent-ada's very value, each from the stand both read.
		const mine = structuredClone(base);
		mine.entities[0]!.values = { "p-note": "von A" };
		const theirs = structuredClone(base);
		theirs.entities[0]!.values = { "p-note": "von B" };

		const first = await saveChanges(app, changesBetween(base, mine));
		assert.deepEqual(first.collided, []);
		const second = await saveChanges(app, changesBetween(base, theirs)); // built on the outdated stand!
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
		await firstSave(app, base);

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

		const saved = await saveChanges(app, changes);
		assert.deepEqual(saved.collided, []);
		await assertServes(app, grown, saved.version); // there they are — card-bob and draw-line gone

		// What the rows themselves say about it:
		const [counts] = await app.sql`select
			(select count(*)::int from entities where workspace_id = ${app.ws}) as entities,
			(select count(*)::int from cards where workspace_id = ${app.ws}) as cards,
			(select count(*)::int from drawings where workspace_id = ${app.ws}) as drawings`;
		assert.deepEqual(counts, { entities: 3, cards: 2, drawings: 0 });

		// And the other way around: the new entity goes again — its card goes with it.
		const shrunk = structuredClone(grown);
		shrunk.entities = shrunk.entities.filter((e) => e.id !== "ent-new");
		shrunk.boards[0]!.cards = shrunk.boards[0]!.cards.filter((c) => c.id !== "card-new");
		const removing = changesBetween(grown, shrunk);
		assert.deepEqual(removing.map((c) => `${c.kind}:${c.id}`), ["entity:ent-new", "card:card-new"]);
		const removed = await saveChanges(app, removing);
		assert.deepEqual(removed.collided, []);
		await assertServes(app, shrunk, removed.version); // deeply equal as read — deletes included
		const [afterCounts] = await app.sql`select
			(select count(*)::int from entities where workspace_id = ${app.ws}) as entities,
			(select count(*)::int from cards where workspace_id = ${app.ws}) as cards,
			(select count(*)::int from entity_values where workspace_id = ${app.ws}) as values`;
		assert.deepEqual(afterCounts, { entities: 2, cards: 1, values: 1 });
	} finally {
		await app.close();
	}
});

test("An empty change set writes nothing at all: no row, no version moves", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		const seen = await firstSave(app, base);
		const before = await app.sql`select revision, updated_at from workspaces where id = ${app.ws}`;

		const answer = await saveChanges(app, []);
		assert.deepEqual(answer.collided, []);
		assert.equal(answer.version, seen, "the version stands where it stood");

		const after = await app.sql`select revision, updated_at from workspaces where id = ${app.ws}`;
		assert.deepEqual(after, before, "not even the workspace's row was touched");
		await assertServes(app, base, seen);
	} finally {
		await app.close();
	}
});

test("A change set the tables can't answer never writes anything half: 503, rows and version as they were", { skip: !url }, async () => {
	assert.ok(url);
	const base = state();
	const app = await theApp();
	try {
		const seen = await firstSave(app, base);
		const rowsBefore = await app.sql`select id from cards where workspace_id = ${app.ws} order by id`;

		// A card for an entity that doesn't exist: the tables' reference refuses it, and the whole save
		// with it — whatever it wrote before failing is rolled back with it.
		const refused = await call(app.url, app.changesPath, {
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

		assert.deepEqual(await app.sql`select id from cards where workspace_id = ${app.ws} order by id`, rowsBefore, "no row was written");
		await assertServes(app, base, seen); // the data and version are where they were
	} finally {
		await app.close();
	}
});
