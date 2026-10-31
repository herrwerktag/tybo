import type { HistoryEntry, StoreCore } from "../../shared/core/index.js";
import { el, language, type EntityLink, type HistoryArea, type HistoryField, type PageMaker, type UnitDescriber } from "../../shared/ui/index.js";
import { text } from "./texts.js";
import { groupWrites, storyGroups, unitStory, workspaceStory, writeSentence, writeToken, type FieldChange, type UnitAction, type UnitStory, type Write, type WriteToken } from "./ui/writes.js";

/** How many entries one read asks for. */
const PAGE_SIZE = 100;
/** How many pages one “Load older” reads at most while none of them has anything the filter shows. */
const PAGES_PER_LOOK = 10;

/** Who wrote, as the filter offers it: the browser app, a model through the MCP, nobody said. */
type SourceFilter = "all" | "web" | "mcp" | "unknown";

/** Which writes the filter shows: to the data, to its views, or all. */
type AreaFilter = HistoryArea | "all";

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
 * The History tab: the workspace's history, read page by page, newest first — a table per day, folded to what the
 * day changed, a block of rows per write, a row per unit. It only reads: nothing here writes. Each feature tells of
 * its own units (`describers`). Filters keep to who wrote, to the data or its views (the data at first), and to one
 * entity type; `#history/entity/<id>` shows only the writes of one entity. Someone else's writes come in as they
 * happen (see `Page.refresh`), and what is open stays open.
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
		let area: AreaFilter = "data";
		/** The entity type filtered for; null: all. */
		let typeId: string | null = null;
		/** What is opened (by key), kept while new writes come in. */
		const open = new Set<string>();
		/** The days opened or folded by hand; the others: the newest open, the rest folded. */
		const dayOpen = new Map<number, boolean>();
		/** The page drawn last, filled anew in place. */
		let view: HTMLElement | null = null;
		/** Counts the stores shown, so an answer for one shown before is dropped. */
		let generation = 0;

		/** The entries the filters let through: a unit's by what it is part of and its type; a write of the workspace
		 * itself counts as data, of no type. */
		function shown(): HistoryEntry[] {
			const entityId = entityOfRoute(location.hash);
			return entries.filter((entry) => {
				if (!matchesSource(entry.source, source)) return false;
				if (entry.operation !== "change") return area !== "view" && typeId === null && entityId === null;
				if (entityId !== null && (entry.kind !== "entity" || entry.unitId !== entityId)) return false;
				const story = unitStory(entry, describers, shownStore!);
				return (area === "all" || story.area === area) && (typeId === null || story.type?.id === typeId);
			});
		}

		/** The entity types the loaded entries belong to, by name — what the type filter offers. */
		function typesLoaded(): { id: string; name: string }[] {
			const types = new Map<string, string>();
			for (const entry of entries) {
				if (entry.operation !== "change") continue;
				const type = unitStory(entry, describers, shownStore!).type;
				if (type && !types.has(type.id)) types.set(type.id, type.name);
			}
			return [...types].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, language));
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
			const filter = <V extends string>(label: string, value: V, options: readonly (readonly [V, string])[], set: (value: V) => void) => {
				const select = el(
					"select",
					{
						onchange: () => {
							set(select.value as V);
							draw(store);
						},
					},
					...options.map(([v, name]) => el("option", { value: v, selected: v === value }, name)),
				);
				return el("label", { className: "history-filter" }, el("span", {}, label), select);
			};
			const types = typesLoaded();
			if (typeId !== null && !types.some((t) => t.id === typeId)) typeId = null; // nothing loaded is of it any more
			const filters = el(
				"div",
				{ className: "section-filters" },
				filter<AreaFilter>(
					text.areaFilter,
					area,
					[
						["data", text.areaData],
						["view", text.areaView],
						["all", text.areaAll],
					],
					(v) => (area = v),
				),
				filter(text.typeFilter, typeId ?? "", [["", text.typeAll], ...types.map((t) => [t.id, t.name] as const)], (v) => (typeId = v === "" ? null : v)),
				filter<SourceFilter>(
					text.sourceFilter,
					source,
					[
						["all", text.sourceAll],
						["web", text.sourceWeb],
						["mcp", text.sourceMcp],
						["unknown", text.sourceUnknown],
					],
					(v) => (source = v),
				),
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

		/** The writes under the day they were made on — today, yesterday, or its date — each day a table, folded to
		 * what it changed: the newest day open, the others folded, unless opened or folded by hand. */
		function days(writes: readonly Write[], store: S): HTMLElement[] {
			const byDay: { day: number; writes: Write[] }[] = [];
			for (const write of writes) {
				const day = startOfDay(new Date(write.at));
				const last = byDay.at(-1);
				if (last?.day === day) last.writes.push(write);
				else byDay.push({ day, writes: [write] });
			}
			return byDay.map(({ day, writes: ofDay }, i) => {
				const details = el(
					"details",
					{ className: "history-day", open: dayOpen.get(day) ?? i === 0 },
					el("summary", {}, el("h3", {}, dayName(new Date(day))), daySummary(ofDay, store)),
					el(
						"table",
						{ className: "history-table" },
						el(
							"thead",
							{},
							el("tr", {}, ...[text.columnTime, text.columnSource, "", text.columnWhat, text.columnWhere, text.columnChange].map((label) => el("th", { scope: "col" }, label))),
						),
						...ofDay.map((write) => writeBody(write, store)),
					),
				);
				details.addEventListener("toggle", () => dayOpen.set(day, details.open));
				return details;
			});
		}

		/** What a day changed, in short: how many of a kind went how, and how many writes each source made, most first. */
		function daySummary(writes: readonly Write[], store: S): HTMLElement {
			const stories = writes.flatMap((write) => write.entries.filter((entry) => entry.operation === "change").map((entry) => unitStory(entry, describers, store)));
			const counts = new Map<string, { action: UnitAction; count: number; noun: (count: number) => string }>();
			for (const story of stories) {
				const key = `${story.action}:${story.noun(1)}`;
				const counted = counts.get(key);
				if (counted) counted.count++;
				else counts.set(key, { action: story.action, count: 1, noun: story.noun });
			}
			const order: UnitAction[] = ["created", "changed", "deleted", "moved"];
			const units = [...counts.values()].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
			const sources = new Map<string, number>();
			for (const write of writes) sources.set(sourceLabel(write.source), (sources.get(sourceLabel(write.source)) ?? 0) + 1);
			return el(
				"span",
				{ className: "history-day-summary" },
				...units.map(({ action, count, noun }) => el("span", { className: `history-count${action === "moved" ? " minor" : ""}` }, actionMark(action), `${count} ${noun(count)}`)),
				el(
					"span",
					{ className: "history-day-sources" },
					[...sources]
						.sort((a, b) => b[1] - a[1])
						.map(([label, count]) => `${label} ${count}`)
						.join(" · "),
				),
			);
		}

		/** A `<details>` whose being open is kept across drawings, under `key`. */
		function kept(key: string, className: string, summary: string, ...content: Node[]): HTMLDetailsElement {
			const details = el("details", { className, open: open.has(key) }, el("summary", {}, summary), ...content);
			details.addEventListener("toggle", () => (details.open ? open.add(key) : open.delete(key)));
			return details;
		}

		/** A write as a block of rows, one per unit — what moved only in one faint row per kind — with when and who
		 * once, beside them all, and a stripe in the color of who wrote. A long write shows its first units, the rest
		 * on request. */
		function writeBody(write: Write, store: S): HTMLElement {
			const at = new Date(write.at);
			const stories = write.entries.filter((entry) => entry.operation === "change").map((entry) => unitStory(entry, describers, store));
			const own = write.entries.find((entry) => entry.operation !== "change");
			const told = own ? workspaceStory(own) : null;
			const source = write.source === "web" || write.source === "mcp" ? write.source : "unknown";
			const rows: HTMLTableRowElement[] = [];
			if (told) {
				rows.push(row(workspaceAction(own!.operation), [el("span", {}, told.sentence)], [], told.changes.length > 0 ? [changeList(told.changes)] : []));
			} else {
				const major = stories.filter((story) => !story.minor);
				const shownMajor = open.has(`${write.key}:all`) ? major : major.slice(0, UNITS_SHOWN);
				rows.push(...shownMajor.map((story) => storyRow(story, write.key)));
				if (shownMajor.length < major.length) {
					const more = el(
						"button",
						{
							type: "button",
							className: "history-more",
							onclick: () => {
								open.add(`${write.key}:all`);
								draw(store);
							},
						},
						text.moreUnits(major.length - shownMajor.length),
					);
					rows.push(el("tr", {}, el("td", {}), el("td", { colSpan: 3 }, more)));
				}
				storyGroups(stories.filter((story) => story.minor)).forEach((group, i) => {
					rows.push(group.length === 1 ? storyRow(group[0]!, write.key) : minorRow(writeToken(group), group, `${write.key}:minor:${i}`));
				});
			}
			const first = rows[0];
			first?.prepend(
				el("td", { className: "history-time", rowSpan: rows.length, title: at.toLocaleString(language) }, at.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })),
				el("td", { className: "history-source-cell", rowSpan: rows.length }, el("span", { className: "history-source" }, sourceLabel(write.source))),
			);
			const minorOnly = !told && stories.every((story) => story.minor);
			const body = el("tbody", { className: `history-write source-${source}${minorOnly ? " minor" : ""}` }, ...rows);
			body.dataset.sentence = told ? told.sentence : writeSentence(stories);
			return body;
		}

		/** One unit's row: what happened, its kind and tag, where it belongs, and what changed. */
		function storyRow(story: UnitStory, writeKey: string): HTMLTableRowElement {
			const what = [el("span", { className: "history-noun" }, story.noun(1)), unitTag(story.name, story.color), ...(story.collided ? [collisionMark()] : [])];
			const where = story.context && story.context !== story.name ? [el("span", {}, story.context)] : [];
			const change: Node[] = [];
			if (story.unreadable) change.push(el("span", { className: "muted" }, text.unreadable));
			else if (story.action === "deleted") change.push(kept(`${writeKey}:last:${story.name}`, "history-last", text.lastStand, fieldList(story.fields)));
			else if (story.action === "created") change.push(fieldList(story.fields.filter((field) => !field.long)));
			else if (story.changes.length > 0) change.push(changeList(story.changes));
			else change.push(el("span", { className: "muted" }, story.action === "moved" ? story.verb : text.nothingVisible));
			const tr = row(story.action, what, where, change);
			tr.title = text.unitSentence(story.noun(1), story.name, story.verb);
			tr.classList.add("history-unit");
			if (story.minor) tr.classList.add("minor");
			return tr;
		}

		/** Several units that only moved, as one faint row: their count and where; each of them on request. */
		function minorRow(token: WriteToken, stories: readonly UnitStory[], key: string): HTMLTableRowElement {
			const where = token.label !== undefined ? [el("span", {}, token.label)] : [];
			const each = el(
				"dl",
				{ className: "history-changes" },
				...stories.flatMap((story) => [el("dt", {}, story.name), el("dd", {}, ...story.changes.map((change) => el("div", {}, ...changeLine(change))))]),
			);
			const tr = row(token.action, [el("span", { className: "history-noun" }, `${token.count} ${token.noun}`)], where, [kept(key, "history-each", text.eachOne, each)]);
			tr.classList.add("minor");
			return tr;
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

/** The day as the history heads its writes: today, yesterday, or its date. */
function dayName(day: Date): string {
	const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(day)) / 86_400_000);
	if (daysAgo === 0) return text.today;
	if (daysAgo === 1) return text.yesterday;
	return day.toLocaleDateString(language, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

const startOfDay = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();

/** How many units of a write show before “more”. */
const UNITS_SHOWN = 5;

/** What a write of the workspace itself did, marked like a unit's. */
function workspaceAction(operation: string): UnitAction {
	return operation === "create" || operation === "baseline" ? "created" : operation === "delete" ? "deleted" : operation === "move" ? "moved" : "changed";
}

const ACTION_MARKS: Record<UnitAction, string> = { created: "+", changed: "✎", deleted: "−", moved: "↔" };

/** The mark of what happened: + made, ✎ changed, − deleted, ↔ moved. */
function actionMark(action: UnitAction): HTMLElement {
	return el("span", { className: `history-action action-${action}`, title: text[action === "moved" ? "reordered" : action] }, ACTION_MARKS[action]);
}

/** A row of a write: its mark, what, where, and what changed (when and who come first, on the write's first row). */
function row(action: UnitAction, what: Node[], where: Node[], change: Node[]): HTMLTableRowElement {
	return el(
		"tr",
		{},
		el("td", { className: "history-mark" }, actionMark(action)),
		el("td", { className: "history-what" }, ...what),
		el("td", { className: "history-where" }, ...where),
		el("td", { className: "history-change" }, ...change),
	);
}

/** A unit's name, or the type several share, as a tag in its color — the way a reference shows on a card. */
function unitTag(label: string, color: string | undefined): HTMLElement {
	const tag = el("span", { className: "ref-tag history-tag" }, label);
	if (color) tag.style.background = color;
	return tag;
}

/** A field changed: `old → new`. */
function changeLine(change: FieldChange): Node[] {
	return [value(change.before, "old"), el("span", { className: "history-arrow", ariaHidden: "true" }, "→"), value(change.after, "new")];
}

/** A field's value in a box of its own, set off from the field's name: as it was (struck through), as it became
 * (stressed), or as it is; none, a dash. */
function value(content: string, as: "old" | "new" | "plain"): HTMLElement {
	if (content === "") return el("span", { className: "history-empty" }, text.empty);
	return el(as === "old" ? "del" : as === "new" ? "ins" : "span", { className: `history-value ${as}` }, content);
}

/** The fields that changed, the field's name beside what became of it: `old → new`; a long text only as changed,
 * its old text on request. */
function changeList(changes: readonly FieldChange[]): HTMLElement {
	return el(
		"dl",
		{ className: "history-changes" },
		...changes.flatMap((change) => [
			el("dt", {}, change.label),
			el(
				"dd",
				{},
				...(change.long
					? [el("span", { className: "history-value changed" }, text.changed), el("details", {}, el("summary", {}, text.oldText), el("p", { className: "history-text" }, change.before || text.empty))]
					: changeLine(change)),
			),
		]),
	);
}

/** The fields of a stand, each name beside its value; long ones on request. */
function fieldList(fields: readonly HistoryField[]): HTMLElement {
	return el(
		"dl",
		{ className: "history-changes" },
		...fields.flatMap((field) => [
			el("dt", {}, field.label),
			el(
				"dd",
				{},
				field.long && field.text !== "" ? el("details", {}, el("summary", {}, text.newText), el("p", { className: "history-text" }, field.text)) : value(field.text, "plain"),
			),
		]),
	);
}

function collisionMark(): HTMLElement {
	return el("span", { className: "history-collision", title: text.collidedHint }, "⚠ ", text.collided);
}
