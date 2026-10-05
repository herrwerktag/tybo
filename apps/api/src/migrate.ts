import {
	createMirror,
	DERIVED_TABLES,
	EMPTY_TABLE_COUNTS,
	expectedMirrorCounts,
	readAppData,
	type Sql,
	type TableCounts,
} from "./mirror.js";

/** One of the two ways a migration ends without writing: the blob was never saved, or it doesn't read
 * as app data. Neither one is stored anywhere — only status and result say which one it was. */
export type MigrationStatus = "migrated" | "empty" | "invalid";

/** What a migration run answers: how the blob read, the Soll-Zahlen it brought along, the Ist-Zahlen the
 * tables hold afterwards, and whether the two match — the whole completeness check, repeatable at any time. */
export interface MigrationResult {
	/** `"migrated"`: the blob's rows are in the tables now. `"empty"`: there is no blob yet, so the derived
	 * copy is empty too. `"invalid"`: the blob doesn't read as app data — nothing was written. */
	status: MigrationStatus;
	/** The Soll-Zahlen: how many rows each table gets from the blob. Zero everywhere when the blob gave
	 * nothing readable to derive from. */
	expected: TableCounts;
	/** Die Ist-Zahlen: the rows the tables hold after the run, as the database counts them. */
	actual: TableCounts;
	/** True when the tables hold exactly what the blob says: every table row for row. False after an
	 * invalid blob — then nobody can say the tables describe anything. */
	complete: boolean;
}

/** App data with nothing in it: the empty form of the blob's shape. It empties the derived copy through
 * `syncMirror`'s all-or-nothing transaction, instead of the migration clearing the tables its own way. */
const EMPTY_APP_DATA = { types: [], entities: [], boards: [] };

/** How many rows each derived table holds — the honest Ist-Zahlen, straight from the database. */
export async function tableCounts(sql: Sql): Promise<TableCounts> {
	const counts: TableCounts = { ...EMPTY_TABLE_COUNTS };
	for (const table of DERIVED_TABLES) {
		const [row] = await sql`select count(*)::int as count from ${sql(table)}`;
		counts[table] = row?.count ?? 0;
	}
	return counts;
}

/** The Soll/Ist-Abgleich as its own step, apart from any migration run: reading the blob's counts from the
 * given text, the tables' counts from the database, and comparing them. Call it again whenever the
 * question comes up again — the answer isn't stored anywhere, not even in a log line. */
export async function compareCounts(blobText: string | null, sql: Sql): Promise<{ expected: TableCounts; actual: TableCounts; matches: boolean }> {
	const data = blobText === null ? null : readAppData(blobText);
	const expected = data === null ? { ...EMPTY_TABLE_COUNTS } : expectedMirrorCounts(data);
	const actual = await tableCounts(sql);
	const matches = DERIVED_TABLES.every((table) => expected[table] === actual[table]);
	return { expected, actual, matches };
}

/** Moves the app's data from the blob into the addressable tables, in one all-or-nothing transaction — the
 * database-shaped half of the move, while the blob stays the only source of truth. Reads nothing back out
 * of the new tables into the app, and never touches `texts`: its rows are the app's own.
 *
 * A blob of `null` (never saved) is a valid state: the tables end up empty and the migration is complete.
 * A blob that doesn't read as app data writes nothing — the tables stay as they were, and the result says so. */
export async function migrateBlob(blobText: string | null, sql: Sql): Promise<MigrationResult> {
	// The target tables come from the mirror's schema code — one shape, one place. Creating them again
	// when they exist already changes nothing.
	const mirror = createMirror(sql);
	await mirror.init();

	if (blobText !== null) {
		const data = readAppData(blobText);
		if (data) {
			// The same transaction the mirror uses: truncate the derived tables, then write the blob's rows.
			await mirror.syncMirror(data);
			const comparison = await compareCounts(blobText, sql);
			return { status: "migrated", expected: comparison.expected, actual: comparison.actual, complete: comparison.matches };
		}
		// A broken blob: don't throw, but don't call the result complete either — the tables describe
		// something else now, or nothing at all, and nobody may mistake them for this blob's copy.
		return { status: "invalid", expected: { ...EMPTY_TABLE_COUNTS }, actual: await tableCounts(sql), complete: false };
	}

	// No blob was ever saved: the derived copy owes an empty source its empty shape.
	await mirror.syncMirror(EMPTY_APP_DATA);
	const comparison = await compareCounts(null, sql);
	return { status: "empty", expected: comparison.expected, actual: comparison.actual, complete: comparison.matches };
}

/** The migration as one line for the log: every table with its Ist/Soll-Zahlen, then the verdict. */
export function describeMigration(result: MigrationResult): string {
	const counts = DERIVED_TABLES.map((table) => `${table} ${result.actual[table]}/${result.expected[table]}`).join(", ");
	return `${result.status} — ${result.complete ? "complete" : "incomplete"} (${counts})`;
}
