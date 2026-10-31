import type { HistoryEntry, StoreCore } from "../../../shared/core/index.js";

/** How many entries one read asks for (the API answers at most 1000). */
const PAGE_SIZE = 500;
/** How many weeks one look further back reads at most while none of them has anything the filters show. */
const WEEKS_PER_LOOK = 8;

export const startOfDay = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();

/** The start of the day `days` before the day starting at `dayStart` (by the calendar, whatever the clock changes). */
export function daysBefore(dayStart: number, days: number): number {
	const day = new Date(dayStart);
	return new Date(day.getFullYear(), day.getMonth(), day.getDate() - days).getTime();
}

export interface HistoryLoader {
	/** What is loaded, newest first. */
	readonly entries: readonly HistoryEntry[];
	/** Whether the oldest entry is loaded. */
	readonly complete: boolean;
	/** The start of the oldest day shown: what is loaded before it waits for the next week. Null: none yet. */
	readonly shownFrom: number | null;
	readonly loading: boolean;
	/** Whether the last look back failed (the next may be answered). */
	readonly failed: boolean;
	/** Whether the entry is in the weeks shown. */
	inWeeksShown(entry: HistoryEntry): boolean;
	/** Whether there is more before what is shown: loaded already, or still in the storage. */
	hasOlder(): boolean;
	/** Shows the week before what is shown (at first: the last seven days), reading as much as it takes; while the
	 * filters let nothing of it through, a few weeks more. */
	loadOlder(): Promise<void>;
	/** Reads what was written since the newest entry held; with a gap wider than a page, starts anew. */
	loadNewer(): Promise<void>;
	/** From now on, answers still on their way are dropped (e.g. another workspace is shown). */
	stop(): void;
}

/**
 * Reads a store's history a week at a time, only ever whole days — however many reads they take. `shown` counts the
 * entries the filters let through, to look further back while a week has none of them; `onChange` is called whenever
 * what is loaded, or whether it's loading or failed, changed.
 */
export function historyLoader(
	store: Pick<StoreCore<unknown>, "readHistory">,
	{ shown, onChange }: { shown: () => number; onChange: () => void },
): HistoryLoader {
	let entries: HistoryEntry[] = [];
	let complete = false;
	let shownFrom: number | null = null;
	let loading = false;
	let failed = false;
	let stopped = false;

	const inWeeksShown = (entry: HistoryEntry): boolean => shownFrom !== null && Date.parse(entry.at) >= shownFrom;
	const hasOlder = (): boolean => !complete || entries.some((entry) => !inWeeksShown(entry));

	/** Reads until every day from `from` on is loaded whole: until an entry from before it, or the oldest. False once stopped. */
	async function readBack(from: number): Promise<boolean> {
		while (!complete && (entries.length === 0 || Date.parse(entries.at(-1)!.at) >= from)) {
			const older = await store.readHistory({ limit: PAGE_SIZE, ...(entries.length > 0 ? { before: entries.at(-1)!.id } : {}) });
			if (stopped) return false;
			entries = [...entries, ...older];
			complete = older.length < PAGE_SIZE;
		}
		return true;
	}

	async function loadOlder(): Promise<void> {
		if (loading || !(shownFrom === null || hasOlder())) return;
		loading = true;
		failed = false;
		onChange();
		try {
			const before = shown();
			let from = shownFrom === null ? daysBefore(startOfDay(new Date()), 6) : daysBefore(shownFrom, 7);
			for (let week = 0; week < WEEKS_PER_LOOK; week++) {
				if (!(await readBack(from))) return;
				shownFrom = from;
				if (shown() > before || !hasOlder()) break;
				from = daysBefore(from, 7);
			}
		} catch {
			if (!stopped) failed = true;
		} finally {
			if (!stopped) {
				loading = false;
				onChange();
			}
		}
	}

	/** Forgets what is loaded and shows the last seven days afresh. */
	function startAgain(): Promise<void> {
		entries = [];
		complete = false;
		shownFrom = null;
		return loadOlder();
	}

	async function loadNewer(): Promise<void> {
		if (entries.length === 0) {
			if (loading) return;
			// An empty history may have its first entry by now: read it from the start.
			return startAgain();
		}
		try {
			const newest = await store.readHistory({ limit: PAGE_SIZE });
			if (stopped) return;
			const known = Number(entries[0]!.id);
			const fresh = newest.filter((entry) => Number(entry.id) > known);
			if (fresh.length === 0) return;
			// More came in than a read holds: start again from the last seven days.
			if (fresh.length === newest.length) return startAgain();
			entries = [...fresh, ...entries];
			onChange();
		} catch {
			// The next look may be answered; what is shown stays.
		}
	}

	return {
		get entries() {
			return entries;
		},
		get complete() {
			return complete;
		},
		get shownFrom() {
			return shownFrom;
		},
		get loading() {
			return loading;
		},
		get failed() {
			return failed;
		},
		inWeeksShown,
		hasOlder,
		loadOlder,
		loadNewer,
		stop() {
			stopped = true;
		},
	};
}
