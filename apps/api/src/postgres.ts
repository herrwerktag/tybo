import postgres from "postgres";
import { applyChanges } from "./changes.js";
import {
	createWorkspace,
	deleteWorkspace,
	listWorkspaces,
	moveWorkspace,
	readWorkspace,
	recordBaselines,
	renameWorkspace,
	workspaceRevision,
} from "./data.js";
import { readHistory } from "./history.js";
import type { Api } from "./http.js";
import { migrateSchema } from "./schema.js";

/** How long to try connecting before giving up — the test run's database is nearby, not worth waiting longer. */
const CONNECT_TIMEOUT_SECONDS = 5;

/** The API's storage, plus what running the server against its database takes. */
export interface PostgresStorage extends Api {
	/** Brings the schema up to date (see `migrateSchema`); calling it again changes nothing. Answers the
	 * versions of the steps it ran. */
	init(): Promise<number[]>;
	/** Gives each workspace made before the history its starting point (see `recordBaselines`); answers how many. */
	recordBaselines(): Promise<number>;
	/** Closes the connections; the data stays. */
	close(): Promise<void>;
}

/** The app's data in Postgres: workspaces, and the rows of each one's data in the tables `schema.ts` makes.
 *
 * Everything that comes in becomes statement parameters through the tagged templates, so nothing saved can
 * turn into SQL. The connection URL is only ever passed to the driver — it is never logged, and neither are
 * the errors it can quote parts of.
 */
export function postgresStorage(url: string): PostgresStorage {
	// The schema's statements are written not to raise notices; whatever the server still says on its own
	// is nothing the API's log needs.
	const sql = postgres(url, { connect_timeout: CONNECT_TIMEOUT_SECONDS, onnotice: () => {} });

	return {
		init: () => migrateSchema(sql),
		recordBaselines: () => recordBaselines(sql),
		listWorkspaces: () => listWorkspaces(sql),
		createWorkspace: (info, dataVersion, source = null) => createWorkspace(sql, info, dataVersion, source),
		renameWorkspace: (id, name, source = null) => renameWorkspace(sql, id, name, source),
		moveWorkspace: (id, to, source = null) => moveWorkspace(sql, id, to, source),
		deleteWorkspace: (id, source = null) => deleteWorkspace(sql, id, source),
		readWorkspace: (id) => readWorkspace(sql, id),
		workspaceRevision: (id) => workspaceRevision(sql, id),
		writeChanges: (id, changes, source = null) => applyChanges(sql, id, changes, source),
		readHistory: (id, page) => readHistory(sql, id, page),

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
