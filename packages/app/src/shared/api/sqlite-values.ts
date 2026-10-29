import type { SQLInputValue } from "node:sqlite";

/** Runs one statement with its parameters. */
export type Run = (sql: string, ...params: SQLInputValue[]) => void;

/** The rows a query answers for the workspace (its one parameter). */
export type All = (sql: string) => Record<string, any>[];

/** A JSON column's parameter: null stays SQL null, anything else its JSON text. */
export const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

/** A JSON column's value as read: its text parsed, SQL null as null. */
export const parsed = (text: unknown): unknown => (text === null || text === undefined ? null : JSON.parse(text as string));

/** A plain column's parameter: what SQLite can't bind (undefined) as null. */
export const plain = (value: unknown): SQLInputValue => (value === undefined ? null : (value as SQLInputValue));
