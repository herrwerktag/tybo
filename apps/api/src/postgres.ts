import postgres from "postgres";
import type { StoragePort } from "@bekbon/core";

/** How long to try connecting before giving up — the test run's database is nearby, not worth waiting longer. */
const CONNECT_TIMEOUT_SECONDS = 5;

/** The storage port, plus what running the server against its database takes. */
export interface PostgresStorage extends StoragePort {
	/** Creates the table if it doesn't exist yet; calling it again changes nothing. */
	init(): Promise<void>;
	/** True once the database answers. */
	healthy(): Promise<boolean>;
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

	return {
		async init() {
			await sql`create table if not exists texts (
				key text primary key,
				value text not null,
				updated_at timestamptz not null default now()
			)`;
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
	};
}
