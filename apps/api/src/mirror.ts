import postgres from "postgres";
import type { AppData } from "@bekbon/core";

/** The key the app saves its data under, as one JSON blob in `texts`. The blob stays the source of truth;
 * everything this module writes is a read-only display copy ("the mirror") of exactly that blob. */
export const APP_KEY = "entities-app";

/** What every mirror table tells whoever queries it: this copy is filled only from the blob. */
const DERIVED =
	"Abgeleitete Anzeige-Kopie aus dem Blob texts[entities-app] - NICHT hier schreiben, der Schreibpfad ist allein die App.";

/** What `mirror_meta` says under `direction`: the blob is the source, the mirror only a reading view of it. */
const DIRECTION = {
	text: "texts[entities-app] (der Blob) ist die Quelle der Wahrheit. Diese Tabellen sind eine abgeleitete, nur lesbare Sicht: Was hier geschrieben wird, ueberschreibt der naechste Abgleich mit dem Blob wieder.",
};

/** The seven tables that carry the app's data, filled from the blob — everything but `mirror_meta`,
 * which holds the markers instead. The migration and its tests read these names from here too. */
export const DERIVED_TABLES = [
	"entity_types",
	"properties",
	"entities",
	"entity_values",
	"boards",
	"cards",
	"drawings",
] as const;

/** One of the seven data tables the blob is spread over. */
export type DerivedTable = (typeof DERIVED_TABLES)[number];

/** How many rows each of the seven tables holds — the shape of every Soll/Ist-Zahl. */
export type TableCounts = Record<DerivedTable, number>;

/** No rows anywhere; the honest answer for no blob or one that isn't app data. */
export const EMPTY_TABLE_COUNTS: TableCounts = {
	entity_types: 0,
	properties: 0,
	entities: 0,
	entity_values: 0,
	boards: 0,
	cards: 0,
	drawings: 0,
};

/** The mirror's own tables — all of it derived from the blob, including `mirror_meta` with the markers. */
const MIRROR_TABLES = [...DERIVED_TABLES, "mirror_meta"] as const;

/** The driver's query function, so the mirror can share the storage's connection. */
export type Sql = postgres.Sql<{}>;

/** The parameter for a jsonb column: `null` where the data has nothing (SQL null, not jsonb `null`), the
 * value as JSON everywhere else — the driver's own serializer, nothing home-grown. */
const jsonb = (sql: Sql, value: unknown): postgres.Parameter | null =>
	value === null || value === undefined ? null : sql.json(value as postgres.JSONValue);

/** The Postgres side of the mirror. None of this ever flows back into the app: the only writer of app data
 * is the app itself, into the blob; the mirror is filled from the blob and read back only by queries. */
export interface PostgresMirror {
	/** Creates the mirror tables if they don't exist yet, with their read-only comments; calling it again changes nothing. */
	init(): Promise<void>;
	/** Rebuilds the mirror from the given app data, in one transaction: all-or-nothing, never a half-mirror.
	 * Data without the app's shape (types/entities/boards not arrays) is refused — nothing is written then. */
	syncMirror(data: AppData): Promise<void>;
	/** Reads the text as app data and mirrors it. Text that doesn't read as app data changes nothing. */
	syncFromText(text: string): Promise<void>;
}

/** Reads candidate app data off a saved text: only a JSON object with types, entities and boards arrays counts;
 * everything else (including no JSON at all) reads as null, so the mirror is left alone. */
export function readAppData(text: string): AppData | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return isAppData(parsed) ? (parsed as AppData) : null;
	} catch {
		return null;
	}
}

export function createMirror(sql: Sql): PostgresMirror {
	const json = (value: unknown) => jsonb(sql, value);
	const mirror: PostgresMirror = {
		async init() {
			await sql`create table if not exists entity_types (
				id text primary key,
				position int not null,
				name text,
				content_template text,
				color text,
				updated_at timestamptz not null default now()
			)`;
			await sql`create table if not exists properties (
				id text primary key,
				type_id text not null references entity_types(id) on delete cascade,
				position int not null,
				name text,
				kind text,
				options jsonb,
				reference jsonb,
				card_display text
			)`;
			await sql`create table if not exists entities (
				id text primary key,
				type_id text not null references entity_types(id) on delete cascade,
				name text,
				content text,
				description text,
				updated_at timestamptz not null default now()
			)`;
			await sql`create table if not exists entity_values (
				entity_id text not null references entities(id) on delete cascade,
				property_id text not null references properties(id) on delete cascade,
				position int not null,
				value jsonb,
				primary key (entity_id, property_id)
			)`;
			await sql`create table if not exists boards (
				id text primary key,
				position int not null,
				name text,
				viewport jsonb,
				updated_at timestamptz not null default now()
			)`;
			await sql`create table if not exists cards (
				id text primary key,
				board_id text not null references boards(id) on delete cascade,
				entity_id text not null references entities(id) on delete cascade,
				position int not null,
				x double precision not null,
				y double precision not null,
				width double precision not null,
				height double precision not null
			)`;
			await sql`create table if not exists drawings (
				id text primary key,
				board_id text not null references boards(id) on delete cascade,
				position int not null,
				kind text not null,
				body jsonb not null
			)`;
			await sql`create table if not exists mirror_meta (
				key text primary key,
				value jsonb not null
			)`;
			// The marker every query sees, so no one mistakes the mirror for the place to write. Postgres takes
			// the comment only as a literal (no parameter), and both the table and the text are this module's
			// own constants — nothing from outside ever reaches this query.
			const marker = `'${DERIVED.replace(/'/g, "''")}'`;
			for (const table of MIRROR_TABLES) {
				await sql.unsafe(`comment on table ${JSON.stringify(table)} is ${marker}`);
			}
		},

		async syncMirror(data) {
			if (!isAppData(data)) return;
			const rows = mirrorRows(data);
			await sql.begin(async (tx) => {
				// Only the mirror's own tables are ever truncated — `texts` is never touched here.
				await tx`truncate entity_types, properties, entities, entity_values, boards, cards, drawings, mirror_meta`;
				// Parents before children, so the references between the mirror's tables hold while inserting.
				for (const { id, position, name, contentTemplate, color } of rows.entityTypes) {
					await tx`insert into entity_types (id, position, name, content_template, color)
						values (${id}, ${position}, ${name}, ${contentTemplate}, ${color})`;
				}
				for (const { id, typeId, position, name, kind, options, reference, cardDisplay } of rows.properties) {
					await tx`insert into properties (id, type_id, position, name, kind, options, reference, card_display)
						values (${id}, ${typeId}, ${position}, ${name}, ${kind}, ${json(options)}, ${json(reference)}, ${cardDisplay})`;
				}
				for (const { id, typeId, name, content, description } of rows.entities) {
					await tx`insert into entities (id, type_id, name, content, description)
						values (${id}, ${typeId}, ${name}, ${content}, ${description})`;
				}
				for (const { entityId, propertyId, position, value } of rows.entityValues) {
					await tx`insert into entity_values (entity_id, property_id, position, value)
						values (${entityId}, ${propertyId}, ${position}, ${json(value)})`;
				}
				for (const { id, position, name, viewport } of rows.boards) {
					await tx`insert into boards (id, position, name, viewport)
						values (${id}, ${position}, ${name}, ${json(viewport)})`;
				}
				for (const { id, boardId, entityId, position, x, y, width, height } of rows.cards) {
					await tx`insert into cards (id, board_id, entity_id, position, x, y, width, height)
						values (${id}, ${boardId}, ${entityId}, ${position}, ${x}, ${y}, ${width}, ${height})`;
				}
				for (const { id, boardId, position, kind, body } of rows.drawings) {
					await tx`insert into drawings (id, board_id, position, kind, body)
						values (${id}, ${boardId}, ${position}, ${kind}, ${json(body)})`;
				}
				await tx`insert into mirror_meta (key, value) values
					('sync', ${json({ source_key: APP_KEY, synced_at: new Date().toISOString(), counts: rows.counts })}),
					('direction', ${json(DIRECTION)})`;
			});
		},

		async syncFromText(text) {
			const data = readAppData(text);
			if (data) await mirror.syncMirror(data);
		},
	};
	return mirror;
}

/** Whether a value has the app's shape; the mirror writes nothing when it hasn't. */
function isAppData(value: unknown): value is AppData {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { types?: unknown }).types) &&
		Array.isArray((value as { entities?: unknown }).entities) &&
		Array.isArray((value as { boards?: unknown }).boards)
	);
}

/** The rows of the mirror, collected before anything is written, in the order they're inserted. */
interface MirrorRows {
	entityTypes: (AppData["types"][number] & { position: number })[];
	properties: { id: string; typeId: string; position: number; name: string; kind: string; options: unknown; reference: unknown; cardDisplay: string }[];
	entities: { id: string; typeId: string; name: string; content: string; description: string }[];
	entityValues: { entityId: string; propertyId: string; position: number; value: unknown }[];
	boards: (AppData["boards"][number] & { position: number })[];
	cards: { id: string; boardId: string; entityId: string; position: number; x: number; y: number; width: number; height: number }[];
	drawings: { id: string; boardId: string; position: number; kind: string; body: unknown }[];
	counts: TableCounts;
}

/** Turns app data into the mirror's rows. Rows whose parent is missing from the data are dropped (the app
 * keeps its data consistent, but a stray row must not fail the whole mirror), and duplicate ids count once —
 * the first one, like the app reading its lists. `position` holds each array's own order, which SQL
 * doesn't know on its own. */
function mirrorRows(data: AppData): MirrorRows {
	const rows: MirrorRows = {
		entityTypes: [],
		properties: [],
		entities: [],
		entityValues: [],
		boards: [],
		cards: [],
		drawings: [],
		counts: { ...EMPTY_TABLE_COUNTS },
	};

	const typeIds = new Set<string>();
	const propertyIds = new Set<string>();
	const propertyPosition = new Map<string, number>();
	const entityIds = new Set<string>();
	const boardIds = new Set<string>();

	data.types.forEach((type, position) => {
		if (typeIds.has(type.id)) return;
		typeIds.add(type.id);
		rows.entityTypes.push({ ...type, position });
		(type.properties ?? []).forEach((property, positionInType) => {
			if (propertyIds.has(property.id)) return;
			propertyIds.add(property.id);
			propertyPosition.set(property.id, positionInType);
			rows.properties.push({
				id: property.id,
				typeId: type.id,
				position: positionInType,
				name: property.name,
				kind: property.kind,
				options: property.options,
				reference: property.reference,
				cardDisplay: property.cardDisplay,
			});
		});
	});

	data.entities.forEach((entity) => {
		if (entityIds.has(entity.id) || !typeIds.has(entity.typeId)) return;
		entityIds.add(entity.id);
		rows.entities.push({
			id: entity.id,
			typeId: entity.typeId,
			name: entity.name,
			content: entity.content,
			description: entity.description,
		});
		for (const [propertyId, position] of propertyPosition) {
			const value = entity.values?.[propertyId];
			if (value === undefined) continue;
			rows.entityValues.push({ entityId: entity.id, propertyId, position, value });
		}
	});

	data.boards.forEach((board, position) => {
		if (boardIds.has(board.id)) return;
		boardIds.add(board.id);
		rows.boards.push({ ...board, position });
		board.cards?.forEach((card, cardPosition) => {
			if (!entityIds.has(card.entityId)) return;
			rows.cards.push({
				id: card.id,
				boardId: board.id,
				entityId: card.entityId,
				position: cardPosition,
				x: card.x,
				y: card.y,
				width: card.width,
				height: card.height,
			});
		});
		board.drawings?.forEach((drawing, drawingPosition) => {
			rows.drawings.push({ id: drawing.id, boardId: board.id, position: drawingPosition, kind: drawing.kind, body: drawing });
		});
	});

	rows.counts = {
		entity_types: rows.entityTypes.length,
		properties: rows.properties.length,
		entities: rows.entities.length,
		entity_values: rows.entityValues.length,
		boards: rows.boards.length,
		cards: rows.cards.length,
		drawings: rows.drawings.length,
	};
	return rows;
}

/** The Soll-Zahlen of app data: how many rows each derived table gets from it. Rows without a parent never
 * become rows, so they count in nowhere — the migration's completeness check builds on exactly this. */
export function expectedMirrorCounts(data: AppData): TableCounts {
	return isAppData(data) ? mirrorRows(data).counts : EMPTY_TABLE_COUNTS;
}
