import postgres from "postgres";
import type { Change, SavedChanges, StoragePort } from "@bekbon/core";
import { applyChanges } from "./changes.js";
import { migrateBlob as runMigration, type MigrationResult } from "./migrate.js";
import { APP_KEY, createMirror, readAppDataFromTables, type PostgresMirror } from "./mirror.js";

/** How long to try connecting before giving up — the test run's database is nearby, not worth waiting longer. */
const CONNECT_TIMEOUT_SECONDS = 5;

/** The storage port, plus what running the server against its database takes. */
export interface PostgresStorage extends StoragePort {
	/** Creates the texts table and the mirror tables if they don't exist yet; calling it again changes nothing.
	 * The mirror is filled once from the blob under the app's key — empty when there is none. */
	init(): Promise<void>;
	/** True once the database answers. */
	healthy(): Promise<boolean>;
	/** Reads the text under `key` together with its version, in one look (so the two can't disagree), or
	 * null if none is stored. Under the app's key the text is assembled from the addressable tables: they
	 * carry the data completely, rebuilt from the blob on every save. The blob remains the fallback —
	 * without table rows to read (or when reading them fails) it answers instead, so the read path never
	 * leaves the app empty or with an error. */
	read(key: string): Promise<{ text: string; version: string } | null>;
	/** Saves the text only for the version the reader saw (null: only under a key nothing is stored yet).
	 * Answers the row's new version, or null when the save was refused — then nothing was written at all. */
	write(key: string, value: string, version: string | null): Promise<string | null>;
	/** Keeps the Postgres mirror in step with a saved text: one that reads as app data is mirrored, one that
	 * doesn't leaves the mirror alone. Derived from the blob only — there is no way back into the app. */
	syncFromText(text: string): Promise<void>;
	/** Writes a change set of the app's data per unit — only the rows of the units it names, in one
	 * transaction that also rebuilds the blob out of the tables (the read path's fallback) and raises the
	 * revision — answering the new version and the units that collided (written anyway, last one wins).
	 * Refused (thrown) only when it couldn't be written honestly; then nothing was written at all. */
	writeChanges(key: string, changes: Change[]): Promise<SavedChanges>;
	/** The mirror itself: the derived, read-only tables queries look at. */
	mirror: PostgresMirror;
	/** Moves the blob's data into the addressable tables once, on this storage's connection, and answers
	 * the completeness result — for the start-up run and its log. The blob stays the source of truth. */
	migrateBlob(blobText: string | null): Promise<MigrationResult>;
	/** Closes the connections; the texts stay. */
	close(): Promise<void>;
}

/** The storage port on Postgres: the saved texts, each under its key in the one table this creates.
 *
 * Keys and texts become statement parameters through the tagged templates, so nothing saved can turn
 * into SQL. The connection URL is only ever passed to the driver — it is never logged, and neither are
 * the errors it can quote parts of.
 */
export function postgresStorage(url: string): PostgresStorage {
	const sql = postgres(url, { connect_timeout: CONNECT_TIMEOUT_SECONDS });
	const mirror = createMirror(sql);

	return {
		async init() {
			// The revision column carries each text's version: a per-row number that grows by one on every
			// write, so no two writes to a row ever share a version. updated_at alone can't do that — now()
			// is the moment a transaction started, and two writes can land on the same microsecond, so an
			// update in between could go by unnoticed. Noticing exactly that is this column's only job.
			await sql`create table if not exists texts (
				key text primary key,
				value text not null,
				revision bigint not null default 0,
				updated_at timestamptz not null default now()
			)`;
			// Tables created before versions existed have no revision column yet; their rows keep their data
			// and read and write under version 0 like any other — no data has to move.
			await sql`alter table texts add column if not exists revision bigint not null default 0`;
			await mirror.init();
			// The start-up fill: whatever blob is already there becomes visible in the mirror, right away.
			// No blob means an empty mirror — that's a valid state, not a failure.
			const rows = await sql`select value from texts where key = ${APP_KEY}`;
			const blob = (rows[0] as { value: string } | undefined)?.value ?? null;
			if (blob !== null) await mirror.syncFromText(blob);
		},

		async getItem(key) {
			const rows = await sql`select value from texts where key = ${key}`;
			const row = rows[0] as { value: string } | undefined;
			return row?.value ?? null;
		},

		async setItem(key, value) {
			// The unconditional write of the port's contract: every write of it grows the revision too, so the
			// version stays honest (a save never ran over a write it didn't see).
			await sql`insert into texts (key, value, revision)
				values (${key}, ${value}, 1)
				on conflict (key) do update set value = excluded.value, updated_at = now(), revision = texts.revision + 1`;
		},

		async removeItem(key) {
			await sql`delete from texts where key = ${key}`;
		},

		async read(key) {
			// The app's key is answered from the addressable tables now — they carry the data as completely
			// as the blob does, because every save rebuilds them from it. The blob stays what the answer
			// falls back on: no table holds a row yet (a database before its first sync), or reading them
			// failed — then it answers instead, so the app is never left empty or with an error. Either
			// way only its version travels: saves keep comparing stands on the row in `texts`.
			if (key === APP_KEY) {
				const rows = await sql`select value, revision::text as version from texts where key = ${APP_KEY}`;
				const row = rows[0] as { value: string; version: string } | undefined;
				if (!row) return null;
				try {
					const fromTables = await readAppDataFromTables(sql);
					if (fromTables !== null) return { text: JSON.stringify(fromTables), version: row.version };
				} catch {
					// The tables couldn't be read (gone, unreadable, mid-upgrade): the blob answers instead.
				}
				return { text: row.value, version: row.version };
			}
			const rows = await sql`select value, revision::text as version from texts where key = ${key}`;
			const row = rows[0] as { value: string; version: string } | undefined;
			return row ? { text: row.value, version: row.version } : null;
		},

		async write(key, value, version) {
			// The first write goes in without a stand to name; anything already stored under the key refuses it.
			if (version === null) {
				const inserted = await sql`insert into texts (key, value, revision)
					values (${key}, ${value}, 1)
					on conflict (key) do nothing
					returning revision::text`;
				return (inserted[0] as { revision?: string } | undefined)?.revision ?? null;
			}
			if (!/^\d+$/.test(version)) return null; // never a version this storage answered
			// One statement, so a refused save never leaves part of the text written; it answers the new revision
			// or nothing, and whatever is stored stays exactly as it was.
			const updated = await sql`update texts
				set value = ${value}, updated_at = now(), revision = revision + 1
				where key = ${key} and revision = ${version}::bigint
				returning revision::text`;
			return (updated[0] as { revision?: string } | undefined)?.revision ?? null;
		},

		syncFromText(text) {
			return mirror.syncFromText(text);
		},

		writeChanges(_key, changes) {
			// The route named the app's key — only its data lives in addressable units.
			return applyChanges(sql, changes);
		},

		async healthy() {
			try {
				await sql`select 1`;
				return true;
			} catch {
				return false;
			}
		},

		async close() {
			await sql.end({ timeout: CONNECT_TIMEOUT_SECONDS });
		},

		mirror,

		migrateBlob(blobText) {
			return runMigration(blobText, sql);
		},
	};
}
