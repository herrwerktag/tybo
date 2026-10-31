import type { HistoryEntry } from "../../../shared/core/index.js";
import { isRecord, type HistoryField, type ReadUnit, type UnitDescriber } from "../../../shared/ui/index.js";
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

/** What one entry tells, as someone reads it. */
export interface UnitStory {
	/** The kind's name for one unit, and for `n`. */
	noun: (count: number) => string;
	name: string;
	context?: string;
	verb: string;
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
		collided: entry.collided,
	};
	const unreadable = (before !== undefined && !readBefore) || (after !== undefined && !readAfter) || (!before && !after);
	if (unreadable) return { ...base, name: shown?.name || text.unreadable, verb: !before ? text.created : !after ? text.deleted : text.changed, changes: [], fields: [], unreadable: true };
	if (!readBefore) return { ...base, verb: text.created, changes: [], fields: readAfter!.fields.filter((field) => field.text !== ""), unreadable: false };
	if (!readAfter) return { ...base, verb: text.deleted, changes: [], fields: readBefore.fields, unreadable: false };
	const changes = fieldChanges(readBefore, readAfter);
	const moved = changes.length === 0 && before!.position !== after!.position;
	const verb = moved ? text.reordered : (describer?.changeVerb?.(before!.value, after!.value) ?? text.changed);
	return { ...base, verb, changes, fields: [], unreadable: false };
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

/** The sentence of a write: of its one unit by name; of several, how many of a kind went how, each kind once —
 * “3 entities created, 1 type changed” — with where they belong when they all belong there (a board, a type). */
export function writeSentence(stories: readonly UnitStory[]): string {
	if (stories.length === 1) {
		const [story] = stories as [UnitStory];
		return text.unitSentence(story.noun(1), story.name, story.verb);
	}
	const groups: { stories: UnitStory[]; noun: (count: number) => string; verb: string }[] = [];
	for (const story of stories) {
		const group = groups.find((g) => g.noun(1) === story.noun(1) && g.verb === story.verb);
		if (group) group.stories.push(story);
		else groups.push({ stories: [story], noun: story.noun, verb: story.verb });
	}
	return groups
		.map(({ stories: of, noun, verb }) => {
			const sentence = of.length === 1 ? text.unitSentence(noun(1), of[0]!.name, verb) : text.countSentence(of.length, noun(of.length), verb);
			const context = of[0]!.context;
			return context !== undefined && of.every((story) => story.context === context) ? `${context}: ${sentence}` : sentence;
		})
		.join(", ");
}
