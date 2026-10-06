import postgres from "postgres";
import type { AppData, Drawing } from "@bekbon/core";

/** The key the app saves its data under, as one JSON blob in `texts`. Writing keeps flowing from that blob:
 * every save stores it and the mirror is rebuilt from it. Reading, on the other hand, comes out of the
 * addressable tables now — `readAppDataFromTables` below assembles the app's data from them, and the blob
 * steps in only as the fallback for the states where the tables can't answer: nothing ever filled them
 * (a database before the first sync), or reading them failed. */
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

/** The queries of a connection or of a transaction in one: reading the tables is the same for either, and
 * even the writer of change sets reads them within its own transaction, so it sees its own writes. */
export type Queries = postgres.ISql<{}>;

/** The parameter for a jsonb column: `null` where the data has nothing (SQL null, not jsonb `null`), the
 * value as JSON everywhere else — the driver's own serializer, nothing home-grown. */
const jsonb = (sql: Queries, value: unknown): postgres.Parameter | null =>
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

/**
 * Assembles the app's data out of the addressable tables — the reverse of what `syncMirror` writes, with
 * the queries given: a connection of one of its own, or the transaction of a write that reads within it.
 *
 * The `position` columns hold every array's order; floats come back bit for bit, the way Postgres stores
 * and answers them. Rows without a parent (a property whose type is missing, a card without its board)
 * never became rows on the way in, so a stray row on the way out — which only hand-writing could have put
 * there — must not fail the read either: it's skipped, like the mirror itself would.
 *
 * Answers null when no data table holds any row at all — a database before its first sync, or one whose
 * mirror was emptied — telling the caller to fall back to the blob for the app's key.
 */
export async function readAppDataFrom(queries: Queries): Promise<AppData | null> {
	const [types, properties, entities, values, boards, cards, drawings, extras] = await Promise.all([
		queries`select id, position, name, content_template, color from entity_types order by position, id`,
		queries`select id, type_id, position, name, kind, options, reference, card_display from properties order by type_id, position, id`,
		queries`select id, type_id, position, name, content, description from entities order by position, id`,
		queries`select entity_id, property_id, position, value from entity_values order by entity_id, position, property_id`,
		queries`select id, position, name, viewport from boards order by position, id`,
		queries`select id, board_id, position, entity_id, x, y, width, height from cards order by board_id, position, id`,
		queries`select board_id, position, body from drawings order by board_id, position, id`,
		queries`select value from mirror_meta where key = 'extras'`,
	]);
	// No rows anywhere: nothing was ever mirrored, or the mirror was emptied for an empty source. The
	// tables owe no answer — the caller falls back to the blob rather than serving an empty app.
	if ([types, properties, entities, values, boards, cards, drawings].every((rows) => rows.length === 0)) return null;

	const typeIds = new Set(types.map(({ id }) => id));
	const propertyIds = new Set(properties.map(({ id }) => id));
	const entityIds = new Set(entities.map(({ id }) => id));
	const boardIds = new Set(boards.map(({ id }) => id));

	const propertiesOf = new Map<string, unknown[]>();
	for (const property of properties) {
		if (!typeIds.has(property.type_id)) continue; // a stray row, one the mirror would never write
		const list = propertiesOf.get(property.type_id) ?? [];
		list.push({
			id: property.id,
			name: property.name,
			kind: property.kind,
			options: property.options ?? [],
			reference: property.reference ?? null,
			cardDisplay: property.card_display,
		});
		propertiesOf.set(property.type_id, list);
	}

	const valuesOf = new Map<string, Record<string, unknown>>();
	for (const { entity_id, property_id, value } of values) {
		if (!entityIds.has(entity_id) || !propertyIds.has(property_id)) continue;
		const record = valuesOf.get(entity_id) ?? {};
		record[property_id] = value;
		valuesOf.set(entity_id, record);
	}

	const cardsOf = new Map<string, unknown[]>();
	for (const { id, board_id, entity_id, x, y, width, height } of cards) {
		if (!boardIds.has(board_id) || !entityIds.has(entity_id)) continue;
		const list = cardsOf.get(board_id) ?? [];
		list.push({ id, entityId: entity_id, x, y, width, height });
		cardsOf.set(board_id, list);
	}

	const drawingsOf = new Map<string, Drawing[]>();
	for (const { board_id, body } of drawings) {
		if (!boardIds.has(board_id)) continue;
		const list = drawingsOf.get(board_id) ?? [];
		list.push(body as Drawing);
		drawingsOf.set(board_id, list);
	}

	const extrasRow = extras[0] as { value: unknown } | undefined;
	const extrasValue =
		extrasRow && typeof extrasRow.value === "object" && extrasRow.value !== null
			? (extrasRow.value as Record<string, unknown>)
			: {};

	return {
		...extrasValue,
		types: types.map(({ id, name, content_template, color }) => ({
			id,
			name,
			properties: propertiesOf.get(id) ?? [],
			contentTemplate: content_template,
			color,
		})),
		entities: entities.map(({ id, type_id, name, content, description }) => ({
			id,
			typeId: type_id,
			name,
			content,
			description,
			values: valuesOf.get(id) ?? {},
		})),
		boards: boards.map(({ id, name, viewport }) => ({
			id,
			name,
			cards: cardsOf.get(id) ?? [],
			viewport,
			drawings: drawingsOf.get(id) ?? [],
		})),
	} as AppData;
}

/**
 * The mirror's rows, written within the queries given — the transaction of `syncMirror`, or that of a
 * change-set save filling the emptied mirror from the blob (all-or-nothing with its own writes). Any
 * rows of the mirror that are there don't survive: the mirror holds the source's whole truth, rebuilt.
 * Only the mirror's own tables are ever truncated — `texts` is never touched here, and neither is
 * anything else a caller writes in the same transaction.
 */
export async function writeMirrorRows(queries: Queries, data: AppData): Promise<void> {
	const json = (value: unknown) => jsonb(queries, value);
	const rows = mirrorRows(data);
	await queries`truncate entity_types, properties, entities, entity_values, boards, cards, drawings, mirror_meta`;
	// Parents before children, so the references between the mirror's tables hold while inserting.
	for (const { id, position, name, contentTemplate, color } of rows.entityTypes) {
		await queries`insert into entity_types (id, position, name, content_template, color)
			values (${id}, ${position}, ${name}, ${contentTemplate}, ${color})`;
	}
	for (const { id, typeId, position, name, kind, options, reference, cardDisplay } of rows.properties) {
		await queries`insert into properties (id, type_id, position, name, kind, options, reference, card_display)
			values (${id}, ${typeId}, ${position}, ${name}, ${kind}, ${json(options)}, ${json(reference)}, ${cardDisplay})`;
	}
	for (const { id, typeId, position, name, content, description } of rows.entities) {
		await queries`insert into entities (id, type_id, position, name, content, description)
			values (${id}, ${typeId}, ${position}, ${name}, ${content}, ${description})`;
	}
	for (const { entityId, propertyId, position, value } of rows.entityValues) {
		await queries`insert into entity_values (entity_id, property_id, position, value)
			values (${entityId}, ${propertyId}, ${position}, ${json(value)})`;
	}
	for (const { id, position, name, viewport } of rows.boards) {
		await queries`insert into boards (id, position, name, viewport)
			values (${id}, ${position}, ${name}, ${json(viewport)})`;
	}
	for (const { id, boardId, entityId, position, x, y, width, height } of rows.cards) {
		await queries`insert into cards (id, board_id, entity_id, position, x, y, width, height)
			values (${id}, ${boardId}, ${entityId}, ${position}, ${x}, ${y}, ${width}, ${height})`;
	}
	for (const { id, boardId, position, kind, body } of rows.drawings) {
		await queries`insert into drawings (id, board_id, position, kind, body)
			values (${id}, ${boardId}, ${position}, ${kind}, ${json(body)})`;
	}
	await queries`insert into mirror_meta (key, value) values
		('sync', ${json({ source_key: APP_KEY, synced_at: new Date().toISOString(), counts: rows.counts })}),
		('direction', ${json(DIRECTION)}),
		('extras', ${json(rows.extras)})`;
}

export function createMirror(sql: Sql): PostgresMirror {
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
				position int not null default 0,
				name text,
				content text,
				description text,
				updated_at timestamptz not null default now()
			)`;
			// Databases from before `position` came to the entities table keep their rows (position 0, in
			// their id order); the next sync fills the column in with each blob's own entity order.
			await sql`alter table entities add column if not exists position int not null default 0`;
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
			await sql.begin(async (tx) => writeMirrorRows(tx, data));
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

/** The saved text's top-level keys besides the data itself — `toSaved`'s `version` marker, for instance,
 * or whatever else a saved text carries around its three arrays. They travel along in `mirror_meta`, so
 * reading back out of the tables answers the whole text and not just the parts with tables of their own. */
function blobExtras(data: AppData): Record<string, unknown> {
	const extras: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (key !== "types" && key !== "entities" && key !== "boards") extras[key] = value;
	}
	return extras;
}

/** The rows of the mirror, collected before anything is written, in the order they're inserted. */
interface MirrorRows {
	entityTypes: (AppData["types"][number] & { position: number })[];
	properties: { id: string; typeId: string; position: number; name: string; kind: string; options: unknown; reference: unknown; cardDisplay: string }[];
	entities: { id: string; typeId: string; position: number; name: string; content: string; description: string }[];
	entityValues: { entityId: string; propertyId: string; position: number; value: unknown }[];
	boards: (AppData["boards"][number] & { position: number })[];
	cards: { id: string; boardId: string; entityId: string; position: number; x: number; y: number; width: number; height: number }[];
	drawings: { id: string; boardId: string; position: number; kind: string; body: unknown }[];
	/** The saved text's top-level keys besides the data itself (the `version` marker of `toSaved`, for
	 * instance), carried along in `mirror_meta` so the tables can answer the whole text — not just the
	 * parts that have tables of their own. */
	extras: Record<string, unknown>;
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
		extras: {},
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

	data.entities.forEach((entity, position) => {
		if (entityIds.has(entity.id) || !typeIds.has(entity.typeId)) return;
		entityIds.add(entity.id);
		rows.entities.push({
			id: entity.id,
			typeId: entity.typeId,
			position,
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

	rows.extras = blobExtras(data);
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


/** Assembles the app's data out of the addressable tables — the reverse of what `syncMirror` writes, in
 * one snapshot of the database, so a mirror being rebuilt alongside can't tear the picture in half.
 * Answers null when nothing was ever mirrored; see `readAppDataFrom` above for the rest. */
export async function readAppDataFromTables(sql: Sql): Promise<AppData | null> {
	return sql.begin("isolation level repeatable read", async (tx) => readAppDataFrom(tx));
}
