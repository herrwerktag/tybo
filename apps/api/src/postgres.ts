import postgres from "postgres";
import type { StoragePort } from "@bekbon/core";
import { migrateBlob as runMigration, type MigrationResult } from "./migrate.js";
import { APP_KEY, createMirror, type PostgresMirror } from "./mirror.js";

/** How long to try connecting before giving up — the test run's database is nearby, not worth waiting longer. */
const CONNECT_TIMEOUT_SECONDS = 5;

/** The storage port, plus what running the server against its database takes. */
export interface PostgresStorage extends StoragePort {
	/** Creates the texts table and the mirror tables if they don't exist yet; calling it again changes nothing.
	 * The mirror is filled once from the blob under the app's key — empty when there is none. */
	init(): Promise<void>;
	/** True once the database answers. */
	healthy(): Promise<boolean>;
	/** Keeps the Postgres mirror in step with a saved text: one that reads as app data is mirrored, one that
	 * doesn't leaves the mirror alone. Derived from the blob only — there is no way back into the app. */
	syncFromText(text: string): Promise<void>;
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
			await sql`create table if not exists texts (
				key text primary key,
				value text not null,
				updated_at timestamptz not null default now()
			)`;
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
			await sql`insert into texts (key, value)
				values (${key}, ${value})
				on conflict (key) do update set value = excluded.value, updated_at = now()`;
		},

		async removeItem(key) {
			await sql`delete from texts where key = ${key}`;
		},

		syncFromText(text) {
			return mirror.syncFromText(text);
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
