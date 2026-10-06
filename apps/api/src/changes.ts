import type { AppData, Change, SavedChanges } from "@bekbon/core";
import { jsonEqual, unitStands } from "@bekbon/core";
import { APP_KEY, expectedMirrorCounts, readAppData, readAppDataFrom, writeMirrorRows, type Queries, type Sql } from "./mirror.js";

/**
 * The change-set writer: the writing side of the addressable tables, while reading comes out of them
 * (2b-2a). A save no longer carries the whole document — only the units it changed, each by its id, so
 * whoever moves a card and whoever edits an entity write different rows, let alone collide on them.
 *
 * Which units collided decides the writer, one at a time: a unit whose `before` is the stand the tables
 * hold right now — or whose absence its "new" says — was touched by nobody else and writes without a
 * word. A unit whose stand differs (someone else changed it in between, or it went away) is a collision;
 * it is written anyway — the last save wins — and its id is reported back, so the saver can tell its user
 * about it the way it always did (`saveConflict`): warn, keep the own changes, reload to see the rest.
 * Units a change set never names are never touched at all — therein lies the whole gain.
 *
 * All-or-nothing: the whole save runs in one transaction, so a failure writes nothing half. The blob
 * (`texts`) is kept in step with the tables — it's the fallback of the read path — by rebuilding it out
 * of the tables within the very same transaction and raising the revision by one, so tables, blob and
 * version can't disagree afterwards.
 */

/** The change kinds, in the order their rows are written: parents before children. */
const WRITE_ORDER = ["type", "entity", "board", "card", "drawing"] as const;

type ChangeKind = (typeof WRITE_ORDER)[number];

/** Whether `raw` is a change set: an array of units, each with its `kind` (one of the five), a non-empty
 * `id`, at least one of `before`/`after` (a unit can't be neither — and a new one that is already gone
 * nobody asks for), and for cards and drawings the board they stand on. What a stand holds — a type with
 * its properties, a card's numbers — is the writer's business with the database: what doesn't fit makes
 * the save fail as a whole, its transaction refused, nothing written. Null when `raw` isn't such an array
 * at all — the request is refused without touching a thing. */
export function parseChanges(raw: unknown): Change[] | null {
	if (!Array.isArray(raw)) return null;
	const changes: Change[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) return null;
		const { kind, id, boardId, before, after } = entry as Record<string, unknown>;
		if (typeof kind !== "string" || !WRITE_ORDER.includes(kind as ChangeKind)) return null;
		if (typeof id !== "string" || id === "") return null;
		const onBoard = kind === "card" || kind === "drawing";
		if (onBoard && (typeof boardId !== "string" || boardId === "")) return null;
		const was = stand(before);
		const now = stand(after);
		if (was === undefined || now === undefined) return null;
		if (was === null && now === null) return null;
		// What a stand holds is the unit's own (a type with its properties, a card's numbers …): the database
		// makes the whole save fail on what doesn't fit — nothing written. Here, only the unit's address is
		// the request's shape to answer for.
		const wireUnit = onBoard
			? { kind, id, boardId: boardId as string, before: was, after: now }
			: { kind, id, before: was, after: now };
		changes.push(wireUnit as Change);
	}
	return changes;
}

/** A stand as it came over the wire: null when the unit wasn't (or isn't) there, or `{ value, position }`
 * with its place in its list. Undefined marks anything that isn't such a stand. */
function stand(raw: unknown): { value: object; position: number } | null | undefined {
	if (raw === null) return null;
	if (typeof raw !== "object" || raw === null) return undefined;
	const { value, position } = raw as Record<string, unknown>;
	if (typeof position !== "number" || !Number.isInteger(position) || position < 0) return undefined;
	if (typeof value !== "object" || value === null) return undefined;
	return { value, position };
}

/** Writes the change set: only the rows of the units it names, one transaction around everything — a
 * failure writes nothing half. Answers the new version and the ids of the units that collided (written
 * anyway — the last save wins). A change set without a unit writes nothing at all, and says where the
 * version stands. Refused (thrown) only when it couldn't be written honestly — then it changed nothing. */
export async function applyChanges(sql: Sql, changes: readonly Change[]): Promise<SavedChanges> {
	if (changes.length === 0) {
		// Nothing changed: nothing is written, not even the blob and its revision.
		const rows = await sql`select revision::text as version from texts where key = ${APP_KEY}`;
		return { version: (rows[0] as { version?: string } | undefined)?.version ?? "0", collided: [] };
	}
	return sql.begin(async (tx) => {
		// One save at a time: the blob is rebuilt from what the tables hold afterwards, so saves must not
		// interleave. The whole-document write waits behind the same row, so the two ways stay in step.
		await tx`select revision from texts where key = ${APP_KEY} for update`;

		const stands = unitStands((await currentData(tx)) ?? emptyApp());
		const byKind: Record<ChangeKind, Change[]> = { type: [], entity: [], board: [], card: [], drawing: [] };
		for (const unit of changes) byKind[unit.kind]!.push(unit);
		const collided: string[] = [];
		for (const kind of WRITE_ORDER) {
			for (const unit of byKind[kind]) {
				// Whatever the tables hold differs from the unit's `before`: someone else was here first.
				if (!untouched(stands, unit)) collided.push(unit.id);
				await writeUnit(tx, unit);
			}
		}

		// The blob is the read path's fallback: it's put together out of the tables' very answer, in this
		// transaction — whatever made applying the units fail or left nothing to answer throws, refuses
		// the whole save, and leaves tables and blob exactly as they were.
		const built = await readAppDataFrom(tx);
		if (built === null) throw new Error("the tables answer nothing to build the blob from");
		const stored = await tx`insert into texts (key, value, revision)
			values (${APP_KEY}, ${JSON.stringify(built)}, 1)
			on conflict (key) do update set value = excluded.value, updated_at = now(), revision = texts.revision + 1
			returning revision::text`;
		const version = (stored[0] as { revision?: string } | undefined)?.revision ?? "0";
		// What every query sees of the mirror: filled by the last save, whichever way it went out.
		await tx`insert into mirror_meta (key, value) values
			('sync', ${jsonbParameter(tx, {
				source_key: APP_KEY,
				synced_at: new Date().toISOString(),
				revision: version,
				counts: expectedMirrorCounts(built),
			})})
			on conflict (key) do update set value = excluded.value`;
		return { version, collided };
	});
}

/** The jsonb parameter the driver makes, in the transaction at hand (`null` stays SQL null, the way the
 * mirror's own helper writes a jsonb column). */
function jsonbParameter(queries: Queries, value: unknown) {
	return value === null || value === undefined ? null : queries.json(value as never);
}

/** The app data the tables answer right now, within this transaction. Nothing mirrored? The blob — the
 * very fallback the read path leans on — fills the mirror first, all-or-nothing with this save: change
 * sets build on a whole read, so the tables must answer one before their units can be written from it.
 * Without a blob there was nothing saved at all — a first write, unit by unit, with nothing to lose.
 * Refuses (throws) when the blob is there but answers nothing the tables could be filled from: the data
 * stays as it is. */
async function currentData(tx: Queries): Promise<AppData | null> {
	const fromTables = await readAppDataFrom(tx);
	if (fromTables !== null) return fromTables;
	const rows = await tx`select value from texts where key = ${APP_KEY}`;
	const blob = (rows[0] as { value: string } | undefined)?.value;
	if (blob === undefined) return null;
	const data = readAppData(blob);
	if (data === null) throw new Error("the blob answers nothing the tables could be filled from");
	await writeMirrorRows(tx, data);
	return (await readAppDataFrom(tx)) ?? null;
}

/** The app data of a database before its first row — nothing anywhere, not even a board. */
function emptyApp(): AppData {
	return { types: [], entities: [], boards: [] };
}

/** The stand the tables hold for the unit right now, by the unit's own kind. */
function currentStand(stands: ReturnType<typeof unitStands>, unit: Change) {
	switch (unit.kind) {
		case "type":
			return stands.types.get(unit.id) ?? null;
		case "entity":
			return stands.entities.get(unit.id) ?? null;
		case "board":
			return stands.boards.get(unit.id) ?? null;
		case "card":
			return stands.cards.get(unit.id)?.stand ?? null;
		case "drawing":
			return stands.drawings.get(unit.id)?.stand ?? null;
	}
}

/** Whether nobody else has touched the unit since the change set's reader last saw it, so writing it
 * needs no word: a unit the change says is new passes where nothing is there (its first write); a unit
 * with a `before` passes only where the tables still hold exactly that stand. Anything else — gone,
 * changed, or someone else's new unit under the same id — was written by someone else in between. */
function untouched(stands: ReturnType<typeof unitStands>, unit: Change): boolean {
	const now = currentStand(stands, unit);
	if (unit.before === null) return now === null;
	// The very comparison the change set was built with (`sameStand`): same place, same content.
	return now !== null && now.position === unit.before.position && jsonEqual(now.value, unit.before.value);
}

/** Writes one unit's rows within the transaction — only that unit's own: its delete is a delete of its
 * one row (the tables' references cascade what hung below it), its write an upsert of it. */
async function writeUnit(tx: Queries, unit: Change): Promise<void> {
	if (unit.after === null) {
		// Gone: its one row goes, and the tables' references take care of what belonged below it — values
		// with their property or entity, cards and drawings with their board.
		switch (unit.kind) {
			case "type":
				return void (await tx`delete from entity_types where id = ${unit.id}`);
			case "entity":
				return void (await tx`delete from entities where id = ${unit.id}`);
			case "board":
				return void (await tx`delete from boards where id = ${unit.id}`);
			case "card":
				return void (await tx`delete from cards where id = ${unit.id}`);
			case "drawing":
				return void (await tx`delete from drawings where id = ${unit.id}`);
		}
	}
	switch (unit.kind) {
		case "type": {
			const type = unit.after.value;
			await tx`insert into entity_types (id, position, name, content_template, color, updated_at)
				values (${type.id}, ${unit.after.position}, ${type.name}, ${type.contentTemplate}, ${type.color}, now())
				on conflict (id) do update set
					position = excluded.position, name = excluded.name,
					content_template = excluded.content_template, color = excluded.color, updated_at = now()`;
			const properties = type.properties ?? [];
			// Properties the type no longer has lost their rows — their values go with them, the tables'
			// references take care of what hangs below a property (or its type) going away.
			if (properties.length === 0) await tx`delete from properties where type_id = ${type.id}`;
			else
				await tx`delete from properties
					where type_id = ${type.id} and id <> all(${properties.map((p) => p.id)})`;
			for (const [index, property] of properties.entries()) {
				await tx`insert into properties (id, type_id, position, name, kind, options, reference, card_display)
					values (${property.id}, ${type.id}, ${index}, ${property.name}, ${property.kind},
						${jsonbParameter(tx, property.options)}, ${jsonbParameter(tx, property.reference)}, ${property.cardDisplay})
					on conflict (id) do update set
						type_id = excluded.type_id, position = excluded.position, name = excluded.name,
						kind = excluded.kind, options = excluded.options, reference = excluded.reference,
						card_display = excluded.card_display`;
			}
			return;
		}
		case "entity": {
			const entity = unit.after.value;
			await tx`insert into entities (id, type_id, position, name, content, description, updated_at)
				values (${entity.id}, ${entity.typeId}, ${unit.after.position}, ${entity.name}, ${entity.content}, ${entity.description}, now())
				on conflict (id) do update set
					type_id = excluded.type_id, position = excluded.position, name = excluded.name,
					content = excluded.content, description = excluded.description, updated_at = now()`;
			// The values the entity no longer has lost their rows; the ones it has are written — the place
			// is the record's own order, the read assembles the record either way.
			const values = Object.entries(entity.values ?? {});
			if (values.length === 0) await tx`delete from entity_values where entity_id = ${entity.id}`;
			else
				await tx`delete from entity_values
					where entity_id = ${entity.id} and property_id <> all(${values.map(([propertyId]) => propertyId)})`;
			for (const [index, [propertyId, value]] of values.entries()) {
				await tx`insert into entity_values (entity_id, property_id, position, value)
					values (${entity.id}, ${propertyId}, ${index}, ${jsonbParameter(tx, value)})
					on conflict (entity_id, property_id) do update set position = excluded.position, value = excluded.value`;
			}
			return;
		}
		case "board": {
			const board = unit.after.value;
			await tx`insert into boards (id, position, name, viewport, updated_at)
				values (${board.id}, ${unit.after.position}, ${board.name}, ${jsonbParameter(tx, board.viewport)}, now())
				on conflict (id) do update set
					position = excluded.position, name = excluded.name, viewport = excluded.viewport, updated_at = now()`;
			return;
		}
		case "card": {
			const card = unit.after.value;
			await tx`insert into cards (id, board_id, entity_id, position, x, y, width, height)
				values (${card.id}, ${unit.boardId}, ${card.entityId}, ${unit.after.position}, ${card.x}, ${card.y}, ${card.width}, ${card.height})
				on conflict (id) do update set
					board_id = excluded.board_id, entity_id = excluded.entity_id, position = excluded.position,
					x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height`;
			return;
		}
		case "drawing": {
			const drawing = unit.after.value;
			await tx`insert into drawings (id, board_id, position, kind, body)
				values (${drawing.id}, ${unit.boardId}, ${unit.after.position}, ${drawing.kind}, ${jsonbParameter(tx, drawing)})
				on conflict (id) do update set
					board_id = excluded.board_id, position = excluded.position, kind = excluded.kind, body = excluded.body`;
			return;
		}
	}
}
