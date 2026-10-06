import type { Change, SavedChanges } from "@bekbon/core";
import { CHANGE_KINDS, unitStands, untouched } from "@bekbon/core";
import { readAppData } from "./data.js";
import type { Queries, Sql } from "./schema.js";

/**
 * The change-set writer: the one way the app's data is written. A save never carries the whole document —
 * only the units it changed, each by its id, so whoever moves a card and whoever edits an entity write
 * different rows, let alone collide on them.
 *
 * Which units collided decides the writer, one at a time: a unit whose `before` is the stand the tables
 * hold right now — or whose absence its "new" says — was touched by nobody else and writes without a
 * word. A unit whose stand differs (someone else changed it in between, or it went away) is a collision;
 * it is written anyway — the last save wins — and its id is reported back, so the saver can tell its user
 * about it: warn, keep the own changes, reload to see the rest. Units a change set never names are never
 * touched at all.
 *
 * All-or-nothing: the whole save runs in one transaction, which also raises the workspace's revision by
 * one, so the rows and the version can't disagree afterwards.
 */

/** The table holding each kind of unit, one row per unit. */
const TABLES: Record<Change["kind"], string> = {
	type: "entity_types",
	entity: "entities",
	board: "boards",
	card: "cards",
	drawing: "drawings",
};

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
		if (typeof kind !== "string" || !CHANGE_KINDS.includes(kind as Change["kind"])) return null;
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

/** Writes the change set into the workspace: only the rows of the units it names, one transaction around
 * everything — a failure writes nothing half. Answers the new revision and the ids of the units that
 * collided (written anyway — the last save wins). A change set without a unit writes nothing at all, and
 * says where the revision stands. Null when there is no workspace of that id; refused (thrown) when it
 * couldn't be written honestly — then it changed nothing. */
export async function applyChanges(sql: Sql, workspaceId: string, changes: readonly Change[]): Promise<SavedChanges | null> {
	if (changes.length === 0) {
		// Nothing changed: nothing is written, not even the revision.
		const [row] = await sql`select revision::text as version from workspaces where id = ${workspaceId}`;
		return row ? { version: row.version as string, collided: [] } : null;
	}
	return sql.begin(async (tx) => {
		// One save of a workspace at a time: each compares its units with what the one before it left.
		const [locked] = await tx`select id from workspaces where id = ${workspaceId} for update`;
		if (!locked) return null;

		const stands = unitStands(await readAppData(tx, workspaceId));
		// Parents before children; a stable sort keeps each kind's units in the order they came.
		const ordered = [...changes].sort((a, b) => CHANGE_KINDS.indexOf(a.kind) - CHANGE_KINDS.indexOf(b.kind));
		const collided: string[] = [];
		for (const unit of ordered) {
			// Whatever the tables hold differs from the unit's `before`: someone else was here first.
			if (!untouched(stands, unit)) collided.push(unit.id);
			await writeUnit(tx, workspaceId, unit);
		}

		const [stored] = await tx`update workspaces set revision = revision + 1, updated_at = now()
			where id = ${workspaceId}
			returning revision::text as version`;
		return { version: stored!.version as string, collided };
	});
}

/** The jsonb parameter the driver makes, in the transaction at hand (`null` stays SQL null, not jsonb `null`). */
function jsonbParameter(queries: Queries, value: unknown) {
	return value === null || value === undefined ? null : queries.json(value as never);
}

/** Writes one unit's rows within the transaction — only that unit's own, in its workspace: its delete is a
 * delete of its one row (the tables' references cascade what hung below it), its write an upsert of it. */
async function writeUnit(tx: Queries, ws: string, unit: Change): Promise<void> {
	if (unit.after === null) {
		// Gone: its one row goes, and the tables' references take care of what belonged below it — values
		// with their property or entity, cards and drawings with their board.
		await tx`delete from ${tx(TABLES[unit.kind])} where workspace_id = ${ws} and id = ${unit.id}`;
		return;
	}
	switch (unit.kind) {
		case "type": {
			const type = unit.after.value;
			await tx`insert into entity_types (workspace_id, id, position, name, content_template, color, updated_at)
				values (${ws}, ${type.id}, ${unit.after.position}, ${type.name}, ${type.contentTemplate}, ${type.color}, now())
				on conflict (workspace_id, id) do update set
					position = excluded.position, name = excluded.name,
					content_template = excluded.content_template, color = excluded.color, updated_at = now()`;
			const properties = type.properties ?? [];
			// Properties the type no longer has lose their rows — their values go with them, the tables'
			// references take care of what hangs below a property (or its type) going away.
			if (properties.length === 0) await tx`delete from properties where workspace_id = ${ws} and type_id = ${type.id}`;
			else
				await tx`delete from properties
					where workspace_id = ${ws} and type_id = ${type.id} and id <> all(${properties.map((p) => p.id)})`;
			for (const [index, property] of properties.entries()) {
				await tx`insert into properties (workspace_id, id, type_id, position, name, kind, options, reference, card_display)
					values (${ws}, ${property.id}, ${type.id}, ${index}, ${property.name}, ${property.kind},
						${jsonbParameter(tx, property.options)}, ${jsonbParameter(tx, property.reference)}, ${property.cardDisplay})
					on conflict (workspace_id, id) do update set
						type_id = excluded.type_id, position = excluded.position, name = excluded.name,
						kind = excluded.kind, options = excluded.options, reference = excluded.reference,
						card_display = excluded.card_display`;
			}
			return;
		}
		case "entity": {
			const entity = unit.after.value;
			await tx`insert into entities (workspace_id, id, type_id, position, name, content, description, updated_at)
				values (${ws}, ${entity.id}, ${entity.typeId}, ${unit.after.position}, ${entity.name}, ${entity.content}, ${entity.description}, now())
				on conflict (workspace_id, id) do update set
					type_id = excluded.type_id, position = excluded.position, name = excluded.name,
					content = excluded.content, description = excluded.description, updated_at = now()`;
			// The values the entity no longer has lose their rows; the ones it has are written — the place
			// is the record's own order, the read assembles the record either way.
			const values = Object.entries(entity.values ?? {});
			if (values.length === 0) await tx`delete from entity_values where workspace_id = ${ws} and entity_id = ${entity.id}`;
			else
				await tx`delete from entity_values
					where workspace_id = ${ws} and entity_id = ${entity.id} and property_id <> all(${values.map(([propertyId]) => propertyId)})`;
			for (const [index, [propertyId, value]] of values.entries()) {
				await tx`insert into entity_values (workspace_id, entity_id, property_id, position, value)
					values (${ws}, ${entity.id}, ${propertyId}, ${index}, ${jsonbParameter(tx, value)})
					on conflict (workspace_id, entity_id, property_id) do update set position = excluded.position, value = excluded.value`;
			}
			return;
		}
		case "board": {
			const board = unit.after.value;
			await tx`insert into boards (workspace_id, id, position, name, kind, viewport, pages, updated_at)
				values (${ws}, ${board.id}, ${unit.after.position}, ${board.name}, ${board.kind}, ${jsonbParameter(tx, board.viewport)},
					${jsonbParameter(tx, board.pages)}, now())
				on conflict (workspace_id, id) do update set
					position = excluded.position, name = excluded.name, kind = excluded.kind, viewport = excluded.viewport,
					pages = excluded.pages, updated_at = now()`;
			return;
		}
		case "card": {
			const card = unit.after.value;
			await tx`insert into cards (workspace_id, id, board_id, entity_id, position, x, y, width, height)
				values (${ws}, ${card.id}, ${unit.boardId}, ${card.entityId}, ${unit.after.position}, ${card.x}, ${card.y}, ${card.width}, ${card.height})
				on conflict (workspace_id, id) do update set
					board_id = excluded.board_id, entity_id = excluded.entity_id, position = excluded.position,
					x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height`;
			return;
		}
		case "drawing": {
			const drawing = unit.after.value;
			await tx`insert into drawings (workspace_id, id, board_id, position, kind, body)
				values (${ws}, ${drawing.id}, ${unit.boardId}, ${unit.after.position}, ${drawing.kind}, ${jsonbParameter(tx, drawing)})
				on conflict (workspace_id, id) do update set
					board_id = excluded.board_id, position = excluded.position, kind = excluded.kind, body = excluded.body`;
			return;
		}
	}
}
