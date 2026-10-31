import type { HistoryEntry } from "../../../shared/core/index.js";
import { isRecord, type HistoryArea, type HistoryField, type ReadUnit, type UnitDescriber } from "../../../shared/ui/index.js";
import { text } from "../texts.js";

/** One write, as the history page shows it: the entries of one save (they share its revision), or one write of
 * the workspace itself. `key` names it across reads (its newest entry's id, or the revision). */
export interface Write {
	key: string;
	at: string;
	source: string | null;
	entries: HistoryEntry[];
}

/** The entries (newest first) put together write by write, newest first; within a write, in the order written. */
export function groupWrites(entries: readonly HistoryEntry[]): Write[] {
	const writes: Write[] = [];
	for (const entry of entries) {
		const last = writes.at(-1);
		if (entry.operation === "change" && entry.revision !== null && last?.entries[0]?.operation === "change" && last.entries[0].revision === entry.revision) {
			last.entries.unshift(entry);
			continue;
		}
		writes.push({ key: entry.revision !== null && entry.operation === "change" ? `r${entry.revision}` : `e${entry.id}`, at: entry.at, source: entry.source, entries: [entry] });
	}
	return writes;
}

/** A field whose text differs between the two stands; `before` or `after` empty where the field wasn't there. */
export interface FieldChange {
	label: string;
	before: string;
	after: string;
	long: boolean;
}

/** What happened to a unit, as the page marks it: made, changed, gone — or only moved (on a board, in its list). */
export type UnitAction = "created" | "changed" | "deleted" | "moved";

/** What one entry tells, as someone reads it. */
export interface UnitStory {
	/** The kind's name for one unit, and for `n`. */
	noun: (count: number) => string;
	name: string;
	context?: string;
	/** The color it is known by (an entity's type's). */
	color?: string;
	/** The data, or a view of it (see `HistoryArea`); an entry of an unknown kind counts as data. */
	area: HistoryArea;
	/** The entity type it belongs to, if any. */
	type?: { id: string; name: string };
	action: UnitAction;
	verb: string;
	/** Whether it changed nothing anyone reads (a card moved, a list reordered): shown faint. */
	minor: boolean;
	/** For a change: the fields that changed, the name first. */
	changes: FieldChange[];
	/** For a unit made: its fields; for one gone: its last stand. */
	fields: HistoryField[];
	/** Whether the stands couldn't be read: the entry tells only that something changed. */
	unreadable: boolean;
	collided: boolean;
}

/** The `value` of a stand as the history keeps it (`{ value, position }`), or undefined when there's none. */
function standOf(raw: unknown): { value: unknown; position: number | null } | undefined {
	if (!isRecord(raw) || !("value" in raw)) return undefined;
	return { value: raw.value, position: typeof raw.position === "number" ? raw.position : null };
}

/** What the describer reads of a value; null when it can't — a shape it doesn't know never breaks the page. */
function readSafely<S>(describer: UnitDescriber<S> | undefined, value: unknown, store: S, boardId: string | null): ReadUnit | null {
	if (!describer) return null;
	try {
		return describer.read(value, store, boardId);
	} catch {
		return null;
	}
}

/** The fields in which two read stands differ, the name first. */
function fieldChanges(before: ReadUnit, after: ReadUnit): FieldChange[] {
	const changes: FieldChange[] = [];
	if (before.name !== after.name) changes.push({ label: text.name, before: before.name, after: after.name, long: false });
	const labels = [...new Set([...before.fields, ...after.fields].map((field) => field.label))];
	for (const label of labels) {
		const was = before.fields.find((field) => field.label === label);
		const now = after.fields.find((field) => field.label === label);
		if ((was?.text ?? "") === (now?.text ?? "")) continue;
		changes.push({ label, before: was?.text ?? "", after: now?.text ?? "", long: Boolean(was?.long || now?.long) });
	}
	return changes;
}

/** Tells one entry of a unit, with the describer of its kind. */
export function unitStory<S>(entry: HistoryEntry, describers: readonly UnitDescriber<S>[], store: S): UnitStory {
	const describer = describers.find((d) => d.kind === entry.kind);
	const noun = describer ? (count: number) => describer.noun(count) : () => entry.kind ?? "?";
	const before = standOf(entry.before);
	const after = standOf(entry.after);
	const readBefore = before && readSafely(describer, before.value, store, entry.boardId);
	const readAfter = after && readSafely(describer, after.value, store, entry.boardId);
	const shown = readAfter ?? readBefore;
	const base = {
		noun,
		name: shown?.name || text.unnamed,
		...(shown?.context ? { context: shown.context } : {}),
		...(shown?.color ? { color: shown.color } : {}),
		...(shown?.type ? { type: shown.type } : {}),
		area: describer?.area ?? "data",
		collided: entry.collided,
	};
	const unreadable = (before !== undefined && !readBefore) || (after !== undefined && !readAfter) || (!before && !after);
	if (unreadable) {
		const action = !before ? "created" : !after ? "deleted" : "changed";
		return { ...base, name: shown?.name || text.unreadable, action, verb: text[action], minor: false, changes: [], fields: [], unreadable: true };
	}
	if (!readBefore) return { ...base, action: "created", verb: text.created, minor: false, changes: [], fields: readAfter!.fields.filter((field) => field.text !== ""), unreadable: false };
	if (!readAfter) return { ...base, action: "deleted", verb: text.deleted, minor: false, changes: [], fields: readBefore.fields, unreadable: false };
	const changes = fieldChanges(readBefore, readAfter);
	if (changes.length === 0 && before!.position !== after!.position) {
		return { ...base, action: "moved", verb: text.reordered, minor: true, changes, fields: [], unreadable: false };
	}
	const minor = changes.length === 0 || Boolean(describer?.minor?.(before!.value, after!.value));
	const verb = describer?.changeVerb?.(before!.value, after!.value) ?? text.changed;
	return { ...base, action: minor && changes.length > 0 ? "moved" : "changed", verb, minor, changes, fields: [], unreadable: false };
}

/** What a write of the workspace itself (made, renamed, moved, deleted, its starting point) tells. */
export function workspaceStory(entry: HistoryEntry): { sentence: string; changes: FieldChange[] } {
	switch (entry.operation) {
		case "create":
			return { sentence: text.workspaceCreated, changes: [] };
		case "rename": {
			const name = (raw: unknown) => (isRecord(raw) && typeof raw.name === "string" ? raw.name : "");
			return { sentence: text.workspaceRenamed, changes: [{ label: text.name, before: name(entry.before), after: name(entry.after), long: false }] };
		}
		case "move":
			return { sentence: text.workspaceMoved, changes: [] };
		case "delete":
			return { sentence: text.workspaceDeleted, changes: [] };
		default:
			return { sentence: text.workspaceBaseline, changes: [] };
	}
}

/** A part of a write's line: units of one kind that went one way — one by its name, several by their count —
 * with the color and the place they share, if they share one. */
export interface WriteToken {
	action: UnitAction;
	count: number;
	noun: string;
	/** The unit's name (one), or what they all belong to (several: their type, their board). */
	label?: string;
	color?: string;
	minor: boolean;
	collided: boolean;
}

/** The units of a write put together by kind, what happened to them and where they belong (their type, their
 * board), in the order written. */
export function storyGroups(stories: readonly UnitStory[]): UnitStory[][] {
	const groups: UnitStory[][] = [];
	for (const story of stories) {
		const group = groups.find(
			([first]) => first!.noun(1) === story.noun(1) && first!.action === story.action && first!.verb === story.verb && first!.context === story.context,
		);
		if (group) group.push(story);
		else groups.push([story]);
	}
	return groups;
}

/** What a group of units (see `storyGroups`) shows as one. */
export function writeToken(group: readonly UnitStory[]): WriteToken {
	const [first] = group as [UnitStory, ...UnitStory[]];
	const shared = <K extends "context" | "color">(key: K) => (group.every((story) => story[key] === first[key]) ? first[key] : undefined);
	const label = group.length === 1 ? first.name : shared("context");
	const color = shared("color");
	return {
		action: first.action,
		count: group.length,
		noun: first.noun(group.length),
		...(label !== undefined ? { label } : {}),
		...(color !== undefined ? { color } : {}),
		minor: group.every((story) => story.minor),
		collided: group.some((story) => story.collided),
	};
}

/** The sentence of a write: of its one unit by name; of several, how many of a kind went how, each kind once —
 * “3 entities created, 1 type changed” — with where they belong when they all belong there (a board, a type). */
export function writeSentence(stories: readonly UnitStory[]): string {
	if (stories.length === 1) {
		const [story] = stories as [UnitStory];
		return text.unitSentence(story.noun(1), story.name, story.verb);
	}
	return storyGroups(stories)
		.map((group) => {
			const [first] = group as [UnitStory, ...UnitStory[]];
			const sentence = group.length === 1 ? text.unitSentence(first.noun(1), first.name, first.verb) : text.countSentence(group.length, first.noun(group.length), first.verb);
			return first.context !== undefined ? `${first.context}: ${sentence}` : sentence;
		})
		.join(", ");
}
