import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryEntry, HistoryPage } from "../../../shared/core/index.js";
import { historyLoader } from "./loader.js";

/** An entry `days` days ago at noon; ids grow with time, as in the storage. */
function entry(id: number, days: number): HistoryEntry {
	const at = new Date();
	at.setDate(at.getDate() - days);
	at.setHours(12, 0, 0, 0);
	return { id: String(id), workspaceId: "ws", revision: null, at: at.toISOString(), source: null, operation: "change", dataVersion: 1, kind: null, unitId: null, boardId: null, before: null, after: null, collided: false };
}

/** A store reading from `all` (newest first) the way the storage pages; each read waits until `answer` is called. */
function slowStore(all: HistoryEntry[]) {
	const waiting: (() => void)[] = [];
	return {
		readHistory: (page: HistoryPage) =>
			new Promise<HistoryEntry[]>((resolve) =>
				waiting.push(() => resolve(all.filter((e) => page.before === undefined || Number(e.id) < Number(page.before)).slice(0, page.limit))),
			),
		answer: () => waiting.shift()?.(),
	};
}

test("the loader shows the last seven days first, then the week before, and tells when it's done", async () => {
	const store = slowStore([entry(3, 0), entry(2, 9), entry(1, 30)]);
	let changes = 0;
	const loader = historyLoader(store, { shown: () => loader.entries.filter(loader.inWeeksShown).length, onChange: () => changes++ });
	const loading = loader.loadOlder();
	assert.equal(loader.loading, true);
	store.answer();
	await loading;
	assert.deepEqual(loader.entries.filter(loader.inWeeksShown).map((e) => e.id), ["3"]);
	assert.equal(loader.complete, true); // one read held it all
	assert.equal(loader.hasOlder(), true); // loaded, not shown yet
	await loader.loadOlder();
	assert.deepEqual(loader.entries.filter(loader.inWeeksShown).map((e) => e.id), ["3", "2"]);
	assert.equal(loader.loading, false);
	assert.ok(changes >= 4); // loading and loaded, twice
});

test("once stopped, answers still on their way are dropped and nothing is reported", async () => {
	const store = slowStore([entry(1, 0)]);
	let changes = 0;
	const loader = historyLoader(store, { shown: () => 0, onChange: () => changes++ });
	const loading = loader.loadOlder();
	const reported = changes;
	loader.stop(); // e.g. another workspace is shown meanwhile
	store.answer();
	await loading;
	assert.deepEqual(loader.entries, []);
	assert.equal(changes, reported);
});
