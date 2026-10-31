import type { HistoryEntry, StoreCore } from "../../shared/core/index.js";
import { el, language, type EntityLink, type HistoryField, type PageMaker, type UnitDescriber } from "../../shared/ui/index.js";
import { text } from "./texts.js";
import { groupWrites, unitStory, workspaceStory, writeSentence, writeTokens, type FieldChange, type UnitAction, type UnitStory, type Write, type WriteToken } from "./ui/writes.js";

/** How many entries one read asks for. */
const PAGE_SIZE = 100;
/** How many pages one “Load older” reads at most while none of them has anything the filter shows. */
const PAGES_PER_LOOK = 10;

/** Who wrote, as the filter offers it: the browser app, a model through the MCP, nobody said. */
type SourceFilter = "all" | "web" | "mcp" | "unknown";

/** The address of the history of one entity. */
const entityRoute = (entityId: string) => `#history/entity/${encodeURIComponent(entityId)}`;

/** The entity the address filters for, if it does (`#history/entity/<id>`). */
function entityOfRoute(hash: string): string | null {
	const [route, what, id] = hash.slice(1).split("/");
	return route === "history" && what === "entity" && id ? decodeURIComponent(id) : null;
}

/** From an entity to its history (see `dataPage`). */
export const HISTORY_LINK: EntityLink = { label: () => text.historyLink, href: entityRoute };

/** The source of a write as the page names it. */
function sourceLabel(source: string | null): string {
	return source === "web" ? text.sourceWeb : source === "mcp" ? text.sourceMcp : (source ?? text.sourceUnknown);
}

function matchesSource(source: string | null, filter: SourceFilter): boolean {
	if (filter === "all") return true;
	if (filter === "unknown") return source !== "web" && source !== "mcp";
	return source === filter;
}

/**
 * The History tab: the workspace's history, read page by page, newest first — one line per write, opened to show
 * what it did unit by unit. It only reads: nothing here writes. Each feature tells of its own units (`describers`);
 * `#history/entity/<id>` shows only the writes of one entity. Someone else's writes come in as they happen
 * (see `Page.refresh`), and what is open stays open.
 */
export function historyPage<S extends Pick<StoreCore<unknown>, "readHistory">>({ describers }: { describers: readonly UnitDescriber<S>[] }): PageMaker<S> {
	return () => {
		/** The store whose history is held; another one starts afresh. */
		let shownStore: S | null = null;
		let entries: HistoryEntry[] = [];
		/** Whether the oldest entry is loaded. */
		let complete = false;
		let loading = false;
		let failed = false;
		let source: SourceFilter = "all";
		/** The writes opened (their keys), kept while new ones come in. */
		const open = new Set<string>();
		/** The page drawn last, filled anew in place. */
		let view: HTMLElement | null = null;
		/** Counts the stores shown, so an answer for one shown before is dropped. */
		let generation = 0;

		/** The entries the filters let through. */
		function shown(): HistoryEntry[] {
			const entityId = entityOfRoute(location.hash);
			return entries.filter((entry) => matchesSource(entry.source, source) && (entityId === null || (entry.kind === "entity" && entry.unitId === entityId)));
		}

		/** Reads older entries: one page, or — while none of them passes the filters — a few more. */
		async function loadOlder(store: S): Promise<void> {
			if (loading || complete) return;
			const mine = generation;
			loading = true;
			failed = false;
			draw(store);
			try {
				const before = shown().length;
				for (let page = 0; page < PAGES_PER_LOOK && !complete; page++) {
					const older = await store.readHistory({ limit: PAGE_SIZE, ...(entries.length > 0 ? { before: entries.at(-1)!.id } : {}) });
					if (mine !== generation) return;
					entries = [...entries, ...older];
					complete = older.length < PAGE_SIZE;
					if (shown().length > before) break;
				}
			} catch {
				if (mine === generation) failed = true;
			} finally {
				if (mine === generation) {
					loading = false;
					draw(store);
				}
			}
		}

		/** Reads what was written since the newest entry held; with a gap wider than a page, starts anew. */
		async function loadNewer(store: S): Promise<void> {
			if (entries.length === 0) {
				if (!loading) complete = false; // an empty history may have its first entry by now
				return loadOlder(store);
			}
			const mine = generation;
			try {
				const newest = await store.readHistory({ limit: PAGE_SIZE });
				if (mine !== generation) return;
				const known = Number(entries[0]!.id);
				const fresh = newest.filter((entry) => Number(entry.id) > known);
				if (fresh.length === 0) return;
				if (fresh.length === newest.length) {
					entries = newest;
					complete = newest.length < PAGE_SIZE;
				} else entries = [...fresh, ...entries];
				draw(store);
			} catch {
				// The next look may be answered; what is shown stays.
			}
		}

		function draw(store: S): void {
			if (!view) return;
			const entityId = entityOfRoute(location.hash);
			const writes = groupWrites(shown());
			const select = el(
				"select",
				{
					ariaLabel: text.sourceFilter,
					onchange: () => {
						source = select.value as SourceFilter;
						draw(store);
					},
				},
				...(
					[
						["all", text.sourceAll],
						["web", text.sourceWeb],
						["mcp", text.sourceMcp],
						["unknown", text.sourceUnknown],
					] as const
				).map(([value, label]) => el("option", { value, selected: value === source }, label)),
			);
			const filters = el(
				"div",
				{ className: "section-filters" },
				el("label", { className: "history-filter" }, el("span", {}, text.sourceFilter), select),
				...(entityId !== null ? [el("a", { className: "ref-tag history-entity-filter", href: "#history", title: text.showAll }, text.onlyEntity(entityName(entityId)), " ×")] : []),
			);
			const status: Node[] = [];
			if (failed) status.push(el("p", { role: "alert" }, text.historyFailed, " ", el("button", { type: "button", onclick: () => void loadOlder(store) }, text.retry)));
			else if (writes.length === 0 && !loading) status.push(el("p", { className: "muted" }, entries.length === 0 && complete ? text.historyEmpty : text.historyNoneShown));
			if (loading) status.push(el("p", { className: "muted" }, text.loading));
			view.replaceChildren(
				el(
					"section",
					{},
					el("div", { className: "section-header" }, el("h2", {}, text.history), filters),
					el("p", { className: "muted" }, text.historyIntro),
					...days(writes, store),
					...status,
					...(!complete && !loading && !failed ? [el("div", { className: "row" }, el("button", { type: "button", onclick: () => void loadOlder(store) }, text.loadOlder))] : []),
				),
			);
		}

		/** The name of the entity filtered for, as its newest entry read tells it. */
		function entityName(entityId: string): string {
			for (const entry of entries) {
				if (entry.unitId !== entityId) continue;
				const story = unitStory(entry, describers, shownStore!);
				if (!story.unreadable) return story.name;
			}
			return entityId;
		}

		/** The writes under the day they were made on: today, yesterday, or its date. */
		function days(writes: readonly Write[], store: S): HTMLElement[] {
			const byDay: { day: string; writes: Write[] }[] = [];
			for (const write of writes) {
				const day = dayName(new Date(write.at));
				const last = byDay.at(-1);
				if (last?.day === day) last.writes.push(write);
				else byDay.push({ day, writes: [write] });
			}
			return byDay.map(({ day, writes: ofDay }) =>
				el("div", { className: "history-day" }, el("h3", {}, day), el("ol", { className: "history-writes" }, ...ofDay.map((write) => writeItem(write, store)))),
			);
		}

		/** A write as one line — when, who, and what in marks: the units by what happened to them, in their colors —
		 * opened to each unit. A write that only moved things is faint. */
		function writeItem(write: Write, store: S): HTMLElement {
			const at = new Date(write.at);
			const time = at.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" });
			const stories = write.entries.filter((entry) => entry.operation === "change").map((entry) => unitStory(entry, describers, store));
			const own = write.entries.find((entry) => entry.operation !== "change");
			const told = own ? workspaceStory(own) : null;
			const sentence = told ? told.sentence : writeSentence(stories);
			const tokens = told ? [actionMark(workspaceAction(own!.operation)), el("span", {}, told.sentence)] : writeTokens(stories).map(tokenElement);
			const minor = !told && stories.every((story) => story.minor);
			const source = write.source === "web" || write.source === "mcp" ? write.source : "unknown";
			const summary = el(
				"summary",
				{ ariaLabel: `${time}, ${sourceLabel(write.source)}: ${sentence}` },
				el("time", { className: "history-time", dateTime: write.at, title: at.toLocaleString(language) }, time),
				el("span", { className: "history-source" }, sourceLabel(write.source)),
				el("span", { className: "history-sentence", title: sentence }, ...tokens),
				...(stories.some((story) => story.collided) ? [collisionMark()] : []),
			);
			const details = el(
				"details",
				{ className: `history-write source-${source}${minor ? " minor" : ""}`, open: open.has(write.key) },
				summary,
				told ? changeList(told.changes) : el("ul", { className: "history-units" }, ...stories.map(storyItem)),
			);
			details.addEventListener("toggle", () => (details.open ? open.add(write.key) : open.delete(write.key)));
			return el("li", {}, details);
		}

		return {
			routes: ["history"],
			label: () => text.tabHistory,
			render(store) {
				if (store !== shownStore) {
					shownStore = store;
					generation++;
					entries = [];
					complete = false;
					loading = false;
					failed = false;
					open.clear();
				}
				view = el("div", { className: "history-view" });
				draw(store);
				void loadNewer(store);
				return view;
			},
			refresh() {
				if (!view?.isConnected || !shownStore) return false;
				void loadNewer(shownStore);
				return true;
			},
		};
	};
}

function collisionMark(): HTMLElement {
	return el("span", { className: "history-collision", title: text.collidedHint }, "⚠ ", text.collided);
}

/** The day as the history heads its writes: today, yesterday, or its date. */
function dayName(day: Date): string {
	const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(day)) / 86_400_000);
	if (daysAgo === 0) return text.today;
	if (daysAgo === 1) return text.yesterday;
	return day.toLocaleDateString(language, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

const startOfDay = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();

/** What a write of the workspace itself did, marked like a unit's. */
function workspaceAction(operation: string): UnitAction {
	return operation === "create" || operation === "baseline" ? "created" : operation === "delete" ? "deleted" : operation === "move" ? "moved" : "changed";
}

const ACTION_MARKS: Record<UnitAction, string> = { created: "+", changed: "✎", deleted: "−", moved: "↔" };

/** The mark of what happened: + made, ✎ changed, − deleted, ↔ moved. */
function actionMark(action: UnitAction): HTMLElement {
	return el("span", { className: `history-action action-${action}`, ariaHidden: "true" }, ACTION_MARKS[action]);
}

/** A unit's name, or the type several share, as a tag in its color — the way a reference shows on a card. */
function unitTag(label: string, color: string | undefined): HTMLElement {
	const tag = el("span", { className: "ref-tag history-tag" }, label);
	if (color) tag.style.background = color;
	return tag;
}

/** One part of a write's line: the mark, then one unit by name, or several by count and what they share. */
function tokenElement(token: WriteToken): HTMLElement {
	return el(
		"span",
		{ className: `history-token${token.minor ? " minor" : ""}` },
		actionMark(token.action),
		el("span", { className: "history-noun" }, token.count === 1 ? token.noun : `${token.count} ${token.noun}`),
		...(token.label !== undefined ? [token.count === 1 || token.color ? unitTag(token.label, token.color) : el("span", { className: "muted" }, token.label)] : []),
	);
}

/** One unit of a write: its mark and tag, and what it changed — or, made, its fields; gone, its last stand. */
function storyItem(story: UnitStory): HTMLElement {
	const line = el(
		"p",
		{ className: "history-unit", title: text.unitSentence(story.noun(1), story.name, story.verb) },
		actionMark(story.action),
		el("span", { className: "history-noun" }, story.noun(1)),
		unitTag(story.name, story.color),
		el("span", { className: "history-verb" }, story.verb),
		...(story.context && story.context !== story.name ? [el("span", { className: "muted" }, `· ${story.context}`)] : []),
		...(story.collided ? [collisionMark()] : []),
	);
	const more: HTMLElement[] = [];
	if (story.changes.length > 0) more.push(changeList(story.changes));
	else if (story.action === "changed" && !story.unreadable) line.append(el("span", { className: "muted" }, `· ${text.nothingVisible}`));
	if (story.fields.length > 0) {
		const fields = fieldList(story.fields);
		more.push(story.action === "deleted" ? el("details", { className: "history-last" }, el("summary", {}, text.lastStand), fields) : fields);
	}
	return el("li", { className: story.minor ? "minor" : "" }, line, ...more);
}

/** The fields that changed: `old → new`; a long text by name only, its old text on request. */
function changeList(changes: readonly FieldChange[]): HTMLElement {
	return el(
		"dl",
		{ className: "history-changes" },
		...changes.flatMap((change) =>
			change.long
				? [
						el("dt", {}, text.longChanged(change.label)),
						el("dd", {}, el("details", {}, el("summary", {}, text.oldText), el("p", { className: "history-text" }, change.before || text.empty))),
					]
				: [
						el("dt", {}, change.label),
						el(
							"dd",
							{},
							el("del", {}, change.before || text.empty),
							el("span", { className: "history-arrow", ariaHidden: "true" }, " → "),
							el("ins", {}, change.after || text.empty),
						),
					],
		),
	);
}

/** The fields of a stand, each with its text; long ones on request. */
function fieldList(fields: readonly HistoryField[]): HTMLElement {
	return el(
		"dl",
		{ className: "history-changes" },
		...fields.flatMap((field) => [
			el("dt", {}, field.label),
			el("dd", {}, field.long ? el("details", {}, el("summary", {}, text.newText), el("p", { className: "history-text" }, field.text || text.empty)) : field.text || text.empty),
		]),
	);
}
