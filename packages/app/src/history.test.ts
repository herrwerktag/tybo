/**
 * The History tab with every feature's units in it: the page of features/history, telling of the writes the
 * other features' units went through, each with its feature's describer (see `HISTORY_DESCRIBERS`).
 */
import { WS, byText, goTo, settle, startApp, storage } from "./test-app.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "./features.core.js";
import { DATA_VERSION, ulid, type HistoryEntry } from "./shared/core/index.js";
import { text as boardText } from "./features/boards/texts.js";
import { text as dataText } from "./features/data/texts.js";
import { text } from "./features/history/texts.js";

const DUNE = ulid();
const EMMA = ulid();

/** One type (Idea: a status, a long text) and two entities of it, as saved data. */
const ideas = () => ({
	version: DATA_VERSION,
	types: [
		{
			id: "idea",
			name: "Idea",
			color: "#c4dafa",
			contentTemplate: "",
			properties: [{ id: "status", name: "Status", kind: "options", options: ["open", "pitched"], reference: null, cardDisplay: "list" }],
		},
	],
	entities: [
		{ id: DUNE, typeId: "idea", name: "Dune", content: "A desert planet", description: "The first draft", tags: [], values: { status: "open" } },
		{ id: EMMA, typeId: "idea", name: "Emma", content: "", description: "", tags: [], values: { status: "open" } },
	],
	boards: [],
});

/** Someone else on the workspace — another tab, or a model through the MCP — writing as `source`. */
async function writer(source: string | null) {
	storage.writer.source = source;
	return createStore(storage.port, WS);
}

/** Shows the History tab (at `hash`) and lets its reads come in. */
async function openHistory(hash = "#history"): Promise<HTMLElement> {
	goTo(hash);
	await settle();
	await settle();
	return document.querySelector<HTMLElement>(".history-view")!;
}

/** The lines of the writes shown, newest first: source and sentence. */
const writeLines = (view: HTMLElement) =>
	[...view.querySelectorAll(".history-write > summary")].map((s) => [s.querySelector(".history-source")!.textContent, s.querySelector(".history-sentence")!.textContent]);

/** The fields a unit's line lists, label by label. */
const labels = (node: ParentNode) => [...node.querySelectorAll(".history-changes > dt")].map((dt) => dt.textContent);

/** An entry put into the history as the storage would have kept it. */
function keep(entry: Partial<HistoryEntry>): void {
	const id = String(storage.history.length + 1);
	storage.history.push({
		id,
		workspaceId: WS,
		revision: id,
		at: new Date().toISOString(),
		source: "web",
		operation: "change",
		dataVersion: DATA_VERSION,
		kind: "entity",
		unitId: DUNE,
		boardId: null,
		before: null,
		after: null,
		collided: false,
		...entry,
	});
}

test("History: every write, newest first, one line each with who wrote it; a write of several units opens to each", async () => {
	const root = await startApp(ideas());
	const agent = await writer("mcp");
	agent.addEntities(["One", "Two", "Three"].map((name) => ({ typeId: "idea", name, content: "", values: { status: "open" } })));
	await agent.saved();
	const web = await writer("web");
	web.updateEntity(DUNE, "Dune", "A desert planet", { status: "pitched" });
	await web.saved();

	const view = await openHistory();
	assert.equal(root.querySelector(".tab.current")?.textContent, text.tabHistory);
	assert.deepEqual(writeLines(view), [
		[text.sourceWeb, text.unitSentence(dataText.historyEntities(1), "Dune", text.changed)],
		[text.sourceMcp, `Idea: ${text.countSentence(3, dataText.historyEntities(3), text.created)}`],
	]);
	const created = view.querySelectorAll<HTMLDetailsElement>(".history-write")[1]!;
	assert.deepEqual(
		[...created.querySelectorAll(".history-unit")].map((p) => p.firstChild!.textContent),
		["One", "Two", "Three"].map((name) => text.unitSentence(dataText.historyEntities(1), name, text.created)),
	);
	assert.deepEqual(labels(created.querySelector("li")!), ["Status"]); // what it was made with, the empty fields left out
});

test("History: a change lists only the fields that changed; a long text by name, its old text on request", async () => {
	await startApp(ideas());
	const web = await writer("web");
	web.updateEntity(DUNE, "Dune", "A desert planet", { status: "pitched" }, "The second draft");
	await web.saved();

	const view = await openHistory();
	const unit = view.querySelector(".history-units > li")!;
	assert.deepEqual(labels(unit), ["Status", text.longChanged(dataText.description)]);
	assert.equal(unit.querySelector("del")!.textContent, "open");
	assert.equal(unit.querySelector("ins")!.textContent, "pitched");
	const old = byText(unit, "summary", text.oldText).closest("details")!;
	assert.equal(old.open, false);
	assert.equal(old.querySelector(".history-text")!.textContent, "The first draft");
});

test("History: an entity deleted can be read as it was last, and entities only moved in their list are reordered", async () => {
	await startApp(ideas());
	const web = await writer("web");
	web.moveEntity(EMMA, 0);
	await web.saved();
	web.deleteEntity(DUNE);
	await web.saved();

	const view = await openHistory();
	assert.deepEqual(
		writeLines(view).map(([, sentence]) => sentence),
		[text.unitSentence(dataText.historyEntities(1), "Dune", text.deleted), `Idea: ${text.countSentence(2, dataText.historyEntities(2), text.reordered)}`], // Emma and Dune swapped places
	);
	const last = byText(view, "summary", text.lastStand).closest("details")!;
	assert.deepEqual(labels(last), [dataText.tags, "Status", dataText.content, dataText.description]);
	assert.ok(last.textContent!.includes("open"));
	assert.equal(last.querySelectorAll(".history-text")[0]!.textContent, "A desert planet");
});

test("History: the filter shows only the agent's writes; a write naming nobody is by someone unknown", async () => {
	await startApp(ideas());
	for (const [source, name] of [["mcp", "By the agent"], ["web", "By hand"], [null, "By nobody"]] as const) {
		const someone = await writer(source);
		someone.addEntity("idea", name, "", {});
		await someone.saved();
	}
	const view = await openHistory();
	assert.deepEqual(writeLines(view).map(([source]) => source), [text.sourceUnknown, text.sourceWeb, text.sourceMcp]);

	const select = view.querySelector<HTMLSelectElement>("select")!;
	select.value = "mcp";
	select.dispatchEvent(new Event("change"));
	assert.deepEqual(writeLines(view), [[text.sourceMcp, text.unitSentence(dataText.historyEntities(1), "By the agent", text.created)]]);
});

test("History: an entity's form links to its history, which shows only the writes of it", async () => {
	const root = await startApp(ideas(), "#entities");
	const web = await writer("web");
	web.updateEntity(DUNE, "Dune", "", { status: "pitched" });
	web.updateEntity(EMMA, "Emma", "", { status: "pitched" });
	await web.saved();
	await settle();

	byText(byText(root, "td", "Dune").closest("tr")!, "button", dataText.edit).click();
	const link = byText<HTMLAnchorElement>(root.querySelector("#entity-form")!, "a", text.historyLink);
	assert.equal(link.getAttribute("href"), `#history/entity/${DUNE}`);

	const view = await openHistory(link.getAttribute("href")!);
	assert.deepEqual(writeLines(view).map(([, sentence]) => sentence), [text.unitSentence(dataText.historyEntities(1), "Dune", text.changed)]);
	const chip = view.querySelector<HTMLAnchorElement>(".history-entity-filter")!;
	assert.equal(chip.textContent, `${text.onlyEntity("Dune")} ×`);
	assert.equal(chip.getAttribute("href"), "#history");
});

test("History: cards moved together are one line, named with their board, folded", async () => {
	await startApp(ideas());
	const web = await writer("web");
	const board = web.addBoard("Plans");
	const cards = web.placeCards(board.id, [DUNE, EMMA].map((entityId, i) => ({ entityId, x: i * 300, y: 0 })));
	await web.saved();
	web.moveItems(board.id, { cards: cards.map((c) => c.id) }, 40, 0);
	await web.saved();
	window.dispatchEvent(new Event("focus")); // the page takes the new board over, and names it
	await settle();

	const view = await openHistory();
	const [moved] = view.querySelectorAll<HTMLDetailsElement>(".history-write");
	assert.equal(
		moved!.querySelector(".history-sentence")!.textContent,
		`${boardText.historyOnBoard("Plans")}: ${text.countSentence(2, boardText.historyCards(2), boardText.historyMoved)}`,
	);
	assert.equal(moved!.open, false);
	assert.deepEqual(labels(moved!.querySelector("li")!), [boardText.historyPosition]);
});

test("History: a stand the app can't read says only that something changed, the rest reads as usual; a collision is marked; nothing writes", async () => {
	await startApp(ideas());
	keep({ kind: "entity", before: { value: { name: "Dune", typeId: "idea" }, position: 0 }, after: { value: { name: "Dune", typeId: "idea", tags: ["a"] }, position: 0 } });
	keep({ kind: "entity", before: { value: 42, position: 0 }, after: { value: "not an entity", position: 0 } });
	keep({ kind: "unknown-kind", unitId: "x", before: null, after: { value: {}, position: 0 } });
	keep({ operation: "rename", kind: null, unitId: null, revision: "3", before: { name: "Old" }, after: { name: "New" } });
	keep({ kind: "entity", before: null, after: { value: { name: "Lost", typeId: "idea" }, position: 1 }, collided: true });
	const saves = storage.saves.length;

	const view = await openHistory();
	assert.deepEqual(
		writeLines(view).map(([, sentence]) => sentence),
		[
			text.unitSentence(dataText.historyEntities(1), "Lost", text.created),
			text.workspaceRenamed,
			text.unitSentence("unknown-kind", text.unreadable, text.created),
			text.unitSentence(dataText.historyEntities(1), text.unreadable, text.changed),
			text.unitSentence(dataText.historyEntities(1), "Dune", text.changed),
		],
	);
	assert.ok(view.querySelector(".history-write")!.querySelector(".history-collision"));
	const rename = view.querySelectorAll(".history-write")[1]!;
	assert.equal(rename.querySelector("del")!.textContent, "Old");
	assert.equal(rename.querySelector("ins")!.textContent, "New");

	for (const details of view.querySelectorAll("details")) details.open = true;
	assert.equal(view.querySelectorAll("button").length, 0); // all is loaded, and nothing here writes
	await settle();
	assert.equal(storage.saves.length, saves);
});

test("History: older entries come on request", async () => {
	await startApp(ideas());
	for (let i = 0; i < 150; i++) keep({ after: { value: { name: `Entity ${i}`, typeId: "idea" }, position: i } });

	const view = await openHistory();
	assert.equal(view.querySelectorAll(".history-write").length, 100);
	assert.equal(writeLines(view)[0]![1], text.unitSentence(dataText.historyEntities(1), "Entity 149", text.created));
	byText(view, "button", text.loadOlder).click();
	await settle();
	await settle();
	const now = document.querySelector<HTMLElement>(".history-view")!;
	assert.equal(now.querySelectorAll(".history-write").length, 150);
	assert.equal(writeLines(now).at(-1)![1], text.unitSentence(dataText.historyEntities(1), "Entity 0", text.created));
	assert.equal([...now.querySelectorAll("button")].some((b) => b.textContent === text.loadOlder), false);
});

test("History: someone else's write comes in on its own, and what is open stays open", async () => {
	await startApp(ideas());
	assert.ok(byText(await openHistory(), "p", text.historyEmpty));
	const agent = await writer("mcp");
	agent.addEntity("idea", "First", "", {});
	await agent.saved();
	window.dispatchEvent(new Event("focus")); // the first write comes into an empty history too
	await settle();
	await settle();
	await settle();
	const view = document.querySelector<HTMLElement>(".history-view")!;
	const first = view.querySelector<HTMLDetailsElement>(".history-write")!;
	first.open = true;
	first.dispatchEvent(new Event("toggle"));

	agent.addEntity("idea", "Second", "", {});
	await agent.saved();
	window.dispatchEvent(new Event("focus")); // the page looks for a newer stand when it gets the focus
	await settle();
	await settle();
	await settle();
	const now = document.querySelector<HTMLElement>(".history-view")!;
	assert.deepEqual(
		writeLines(now).map(([, sentence]) => sentence),
		["Second", "First"].map((name) => text.unitSentence(dataText.historyEntities(1), name, text.created)),
	);
	const [second, firstAgain] = now.querySelectorAll<HTMLDetailsElement>(".history-write");
	assert.equal(second!.open, false);
	assert.equal(firstAgain!.open, true);
});
