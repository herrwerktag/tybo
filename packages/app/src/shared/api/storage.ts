import type postgres from "postgres";
import type { AppData, UnitKind, UnitStand } from "../core/index.js";
import type { All, Run } from "./sqlite-values.js";

/** The driver's query function, a connection's or a transaction's — everything here runs on either. */
export type Queries = postgres.ISql<{}>;

/** Rows as a query answers them. */
export type Rows = readonly Record<string, any>[];

/**
 * How one kind of unit is kept in the tables, in Postgres and in SQLite alike: the rows it is read from and
 * put together of, and how one unit's rows are written. Deleting a unit is its one row going (`table`); the
 * tables' references cascade what hung below it.
 *
 * `R` is what its reading answers — its rows, the JSON columns already parsed, whichever database answered.
 */
export interface UnitStorage<T extends { id: string } = any, R = any, D = any> {
	unit: UnitKind<D, T>;
	/** The table holding one row per unit. */
	table: string;
	readPostgres(queries: Queries, ws: string): Promise<R>;
	readSqlite(all: All): R;
	/** The app's data with its units put in, from the rows read. Kinds are put in parents first. */
	assemble(data: D, rows: R): D;
	/** Writes the unit's rows (an upsert of its own, and of what belongs to it alone). */
	writePostgres(tx: Queries, ws: string, after: UnitStand<T>, boardId: string | undefined): Promise<void>;
	writeSqlite(run: Run, ws: string, after: UnitStand<T>, boardId: string | undefined): void;
	/** Whether a change between the two stands is no news for the history (it's saved, but leaves no entry). */
	quiet?(before: UnitStand<T> | null, after: UnitStand<T> | null): boolean;
}

/** The kinds of unit a storage keeps — the app's, given by the features (see features.api.ts) — with what is asked
 * of them by kind. */
export interface StoredUnits {
	/** Parents before the children naming them: the order they are read, put together and written in. */
	storages: readonly UnitStorage<any, any, AppData>[];
	/** The kinds of unit, in the storages' order. */
	kinds: readonly UnitKind<AppData, any>[];
	/** How the kind named is kept, or undefined for a kind there is none of. */
	storageOf(kind: string): UnitStorage | undefined;
	/** The app's data put together of every kind's rows (in the storages' order), parents first. */
	assemble(rows: readonly unknown[]): AppData;
}

/** The kinds of unit kept by `storages`, parents before the children naming them (see `StoredUnits`). */
export function storedUnits(storages: readonly UnitStorage<any, any, AppData>[]): StoredUnits {
	return {
		storages,
		kinds: storages.map(({ unit }) => unit),
		storageOf: (kind) => storages.find((storage) => storage.unit.kind === kind),
		assemble: (rows) => storages.reduce((data, storage, index) => storage.assemble(data, rows[index]), {} as AppData),
	};
}

/** The jsonb parameter the driver makes, in the transaction at hand (`null` stays SQL null, not jsonb `null`). */
export function jsonbParameter(queries: Queries, value: unknown) {
	return value === null || value === undefined ? null : queries.json(value as never);
}

/** The rows by the parent their `column` names, each turned into what the app holds, in the rows' order. */
export function groupBy<R extends Record<string, unknown>, T>(rows: readonly R[], column: keyof R, make: (row: R) => T): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const parent = row[column] as string;
		const list = groups.get(parent) ?? [];
		list.push(make(row));
		groups.set(parent, list);
	}
	return groups;
}

