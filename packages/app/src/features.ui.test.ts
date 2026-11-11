import { WS, byText, choose, goTo, library, memoryStorage, readSaved, rowNames, settle, startApp, storage, stub, tagSelectIn, tagged, typeInto } from "./test-app.js";
import { freshDom } from "./shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION } from "./shared/core/index.js";
import { setLanguage, activeWorkspacePreference, sharedText } from "./shared/ui/index.js";
import { text as dataText } from "./features/data/texts.js";
import { text as boardText } from "./features/boards/texts.js";
import { text as historyText } from "./features/history/texts.js";
import { text as analysisText } from "./features/analyses/texts.js";
import { text as traitText } from "./features/traits/texts.js";
import { text as exportText } from "./features/exports/texts.js";
import { createStore, createWorkspaces } from "./features.core.js";
import { render } from "./features.ui.js";

test("Data is the default page; its heading switches between entity types and entities", async () => {
	const root = await startApp(library);
	assert.equal(root.querySelector(".app-nav .current")?.textContent, dataText.tabEntities);
	assert.equal(root.querySelector(".data-switch .current")?.textContent, dataText.entities);
	assert.ok(byText(root, "td", "Dune"));
	assert.equal(root.querySelector(".type-item"), null);

	goTo("#types");
	assert.equal(root.querySelector(".app-nav .current")?.textContent, dataText.tabEntities);
	assert.equal(root.querySelector(".data-switch .current")?.textContent, dataText.entityTypes);
	assert.ok(byText(root, ".type-name", "Book"));
	assert.equal(root.querySelector("td"), null);

	goTo("#boards");
	assert.equal(root.querySelector(".app-nav .current")?.textContent, boardText.tabBoards);
	assert.equal(root.querySelector(".data-switch"), null);

	goTo("#canvas"); // the former name still leads there
	assert.equal(root.querySelector(".app-nav .current")?.textContent, boardText.tabBoards);
	goTo("#view/b"); // and so do the former read-only boards' addresses
	assert.equal(root.querySelector(".app-nav .current")?.textContent, boardText.tabBoards);
});


test("empty lists say what belongs in them and offer the next step", async () => {
	const root = await startApp({ version: DATA_VERSION, types: [], entities: [], boards: [{ id: "b", name: "Board 1", cards: [] }] }, "#entities");
	const step = (label: string) => byText<HTMLElement>(root, ".empty-state :is(a, button)", label);
	// No types: the entities first need one; the types page makes it.
	assert.equal(step(dataText.createNewType).getAttribute("href"), "#types/new");
	goTo("#types");
	assert.ok(byText(root, ".empty-state p", dataText.noTypesYet));
	step(dataText.createNewType).click();
	assert.ok(root.querySelector("#type-form"));

	// The board's side panel: without types, the way to one; with one, a new entity right there.
	goTo("#boards");
	assert.equal(step(dataText.createNewType).getAttribute("href"), "#types/new");

	goTo("#analysis");
	assert.ok(byText(root, ".empty-state p", analysisText.analysisEmpty), "New analysis is right beside it");

	goTo("#traits");
	step(traitText.newTrait).click();
	assert.ok(root.querySelector(".trait-form"));
});

test("an empty list made so by a filter offers to reset it", async () => {
	const data = structuredClone(tagged) as typeof tagged & { types: unknown[]; entities: unknown[] };
	data.types = [...data.types, { id: "person", name: "Person", color: "#c8ebbf", contentTemplate: "", description: "", guide: "", properties: [] }];
	data.entities = [...data.entities, { id: "01J00000000000000000000003", typeId: "person", name: "Ada", content: "", description: "", tags: [], values: {} }];
	const root = await startApp(data, "#entities");
	choose(tagSelectIn(root.querySelector(".section-filters"))!, "Romance");
	byText(root, ".type-chip", "Person1").click();
	assert.ok(byText(root, ".empty-state p", dataText.noEntitiesWithTag("Person", "Romance")));
	byText(root, ".empty-state button", sharedText.resetFilters).click();
	assert.deepEqual(rowNames(root), ["Ada"]);

	goTo("#boards");
	const search = () => root.querySelector<HTMLInputElement>(".panel-filters input[type=search]")!;
	search().value = "nothing like it";
	search().dispatchEvent(new Event("input"));
	byText(root, ".panel-list .empty-state button", sharedText.resetFilters).click();
	assert.equal(root.querySelectorAll(".panel-list .panel-item").length, 4);
	assert.equal(search().value, "");
});

test("a new workspace from the menu starts empty and becomes active; switching back shows the first one again", async () => {
	const root = await startApp(library, "#types");
	const newForm = root.querySelector<HTMLFormElement>(".workspace-new")!;
	newForm.querySelector<HTMLInputElement>("input:not([type])")!.value = "Second";
	byText(newForm, "button", sharedText.create).click();
	await settle();

	assert.equal(root.querySelector(".workspace-name")?.textContent, "Second");
	assert.ok(byText(root, "p", dataText.noTypesYet));

	byText(root, ".workspace-option", sharedText.defaultWorkspaceName(1)).click();
	await settle();
	assert.equal(root.querySelector(".workspace-name")?.textContent, sharedText.defaultWorkspaceName(1));
	assert.ok(byText(root, ".type-name", "Book"));
});

test("a new or renamed workspace may not have the name of another one; the new one is offered the first number free", async () => {
	const alerts: string[] = [];
	const root = await startApp(library, "#types");
	await settle(); // the hashchange of the start draws the page anew
	const newForm = root.querySelector<HTMLFormElement>(".workspace-new")!;
	const name = newForm.querySelector<HTMLInputElement>("input:not([type])")!;
	assert.equal(name.value, sharedText.defaultWorkspaceName(2));
	name.value = sharedText.defaultWorkspaceName(1).toUpperCase();
	byText(newForm, "button", sharedText.create).click();
	assert.equal(name.validationMessage, sharedText.workspaceNameTaken(name.value));
	assert.equal((await storage.port.listWorkspaces()).length, 1);

	name.value = "Second";
	name.dispatchEvent(new Event("input"));
	byText(newForm, "button", sharedText.create).click();
	await settle();
	stub({ prompt: () => ` ${sharedText.defaultWorkspaceName(1)} `, alert: (message: string) => void alerts.push(message) });
	byText(root, "button", sharedText.renameButton).click();
	assert.deepEqual(alerts, [sharedText.workspaceNameTaken(sharedText.defaultWorkspaceName(1))]);
	await settle();
	assert.deepEqual((await storage.port.listWorkspaces()).map((w) => w.name), [sharedText.defaultWorkspaceName(1), "Second"]);
});

test("workspaces are reordered in the menu with their drag handles' arrow keys; the order is saved", async () => {
	const behind = memoryStorage(library);
	const root = await startApp(library, "#types", behind);
	const newForm = root.querySelector<HTMLFormElement>(".workspace-new")!;
	newForm.querySelector<HTMLInputElement>("input:not([type])")!.value = "Second";
	byText(newForm, "button", sharedText.create).click();
	await settle();

	root.querySelectorAll<HTMLElement>(".workspace-list .drag-handle")[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
	assert.deepEqual([...root.querySelectorAll(".workspace-option")].map((b) => b.textContent), ["Second", sharedText.defaultWorkspaceName(1)]);
	assert.ok((document.activeElement as HTMLElement).dataset.focusKey?.startsWith("workspace:"));
	await settle();
	assert.deepEqual((await behind.port.listWorkspaces()).map((w) => w.name), ["Second", sharedText.defaultWorkspaceName(1)]);
	assert.equal(root.querySelector(".workspace-name")?.textContent, "Second", "the active workspace stays");
});

test("a workspace whose data can't be loaded warns that changes aren't saved, and offers a reload", async () => {
	const behind = memoryStorage(library);
	behind.failing.loads = true;
	const root = await startApp(undefined, "", behind);
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.ok(banner.textContent!.includes(sharedText.loadUnavailable));
	assert.ok(byText(banner, "button", sharedText.reload));
});

test("a page that can't be drawn shows the error screen, which can still export", async (t) => {
	const logged = t.mock.method(console, "error", () => {});
	const root = await startApp(library);
	const createElement = document.createElement.bind(document);
	document.createElement = ((tag: string) => {
		if (tag === "table") throw new Error("table failed");
		return createElement(tag);
	}) as typeof document.createElement;

	byText(root, ".name-link", "Dune").click(); // draws the page again

	const screen = root.querySelector(".error-screen");
	assert.ok(screen);
	assert.equal(screen.querySelector(".error-detail")?.textContent, "table failed");
	assert.ok(byText(screen, "button", sharedText.reload));
	assert.ok(byText(screen, "button", boardText.exportButton));
	assert.equal(logged.mock.callCount(), 1);
});

test("errors thrown outside rendering show in the banner", async () => {
	const root = await startApp();
	window.dispatchEvent(new ErrorEvent("error", { error: new Error("handler failed") }));
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.match(banner.textContent ?? "", /handler failed/);
});

const press = (target: Element, key: string, modifiers: KeyboardEventInit = {}) =>
	target.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...modifiers }));

test("a deleted entity comes back with the Undo button, and goes again with Ctrl+Y", async () => {
	const root = await startApp(library);
	const [undo, redo] = root.querySelectorAll<HTMLButtonElement>(".history-button") as unknown as [HTMLButtonElement, HTMLButtonElement];
	assert.equal(undo.disabled, true);

	stub({ confirm: () => true });
	byText(byText(root, "td", "Dune").closest("tr")!, "button", sharedText.delete).click();
	assert.equal(undo.disabled, false);

	undo.click();
	assert.ok(byText(root, "td", "Dune"));
	assert.equal((await readSaved()).entities.length, 1);
	assert.equal(redo.disabled, false);

	press(document.body, "y");
	assert.equal((await readSaved()).entities.length, 0);
	assert.equal(root.querySelector("td"), null);
});

test("Ctrl+Z undoes outside text fields; inside one it's left to the browser's text undo", async () => {
	const root = await startApp(library);
	stub({ confirm: () => true });
	byText(byText(root, "td", "Dune").closest("tr")!, "button", sharedText.delete).click();

	byText(root, "button", dataText.createNewEntity).click();
	const nameInput = root.querySelector<HTMLInputElement>("#entity-form input")!;
	assert.equal(press(nameInput, "z"), true); // not handled: the default (text undo) isn't prevented
	assert.equal((await readSaved()).entities.length, 0);

	assert.equal(press(document.body, "z"), false);
	assert.equal((await readSaved()).entities.length, 1);
	press(document.body, "z", { shiftKey: true });
	assert.equal((await readSaved()).entities.length, 0);
});

test("canvas changes can be undone too: the Undo button follows them without the page being drawn again", async () => {
	const data = structuredClone(library) as { types: unknown[]; boards: unknown[] };
	data.boards = [{ id: "b", name: "Board 1", cards: [{ id: "c", entityId: "01J00000000000000000000000", x: 0, y: 0, width: 240, height: 160 }], viewport: { x: 0, y: 0, zoom: 1 }, drawings: [] }];
	const root = await startApp(data, "#boards");
	const [undo] = root.querySelectorAll<HTMLButtonElement>(".history-button");

	root.querySelector<HTMLButtonElement>(".canvas-board .card-remove")!.click();
	assert.equal(root.querySelector(".canvas-board .canvas-card"), null);
	assert.equal(undo!.disabled, false);

	undo!.click();
	assert.ok(root.querySelector('.canvas-board .canvas-card[data-card-id="c"]'));
});

test("a workspace saved by a newer version warns that changes aren't saved, and offers a reload", async () => {
	const root = await startApp({ version: 999, types: [], entities: [] });
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.match(banner.textContent ?? "", new RegExp(sharedText.loadNewerVersion.slice(0, 20)));
	assert.ok(byText(banner, "button", sharedText.reload));
	assert.equal(banner.querySelector(`button`)?.textContent, sharedText.reload); // nothing to dismiss
});

test("a save that collided warns of the conflict, not of a failing storage, and offers a reload", async () => {
	// A storage that answers every unit as collided — the way the API's does when someone else saved it first.
	const behind = memoryStorage();
	behind.port.saveChanges = async (_id, changes) => ({ version: "9", collided: changes.map((c) => c.id) });
	const root = await startApp(undefined, "#types", behind);
	byText(root, "button", dataText.createNewType).click();
	const typeForm = root.querySelector<HTMLFormElement>("#type-form")!;
	typeInto(typeForm.querySelector(`input[placeholder="${dataText.typeNamePlaceholder}"]`)!, "Book");
	byText(typeForm, "button", dataText.createType).click();
	await settle();

	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.ok(banner.textContent!.includes(sharedText.saveConflict));
	assert.equal(banner.textContent!.includes(sharedText.saveFailed), false); // honestly: not a storage problem
	assert.ok(byText(banner, "button", sharedText.reload));
});

/** What the page does when the tab takes the front again: it looks for a newer stand at once. */
const lookNow = () => window.dispatchEvent(new Event("focus"));

/** Another tab on the workspace the app shows: a store of its own on the same storage. */
const otherTab = () => createStore(storage.port, WS);

test("what another tab saves shows up on its own — no hint, no reload, the data saved over nothing", async () => {
	const root = await startApp(library);
	await settle();
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, true); // nobody else changed anything: no hint

	const other = await otherTab();
	other.addEntity("book", "Emma", "", {});
	await settle();
	lookNow();
	await settle();
	assert.ok(byText(root, "td", "Emma"));
	assert.ok(byText(root, "td", "Dune"));
	assert.equal(banner.hidden, true);
	assert.deepEqual((await readSaved()).entities.map((e) => e.name), ["Dune", "Emma"]);
});

test("while a field is being edited, what another tab saved waits; details shown don't hold it up", async () => {
	const root = await startApp(library);
	// The details beside the table hold nothing up.
	byText(root, ".name-link", "Dune").click();
	const other = await otherTab();
	other.addEntity("book", "Emma", "", {});
	await settle();
	lookNow();
	await settle();
	assert.ok(byText(root, ".name-link", "Emma"));
	assert.equal(root.querySelector(".entities-view .details-title")?.textContent, "Dune", "the details stay");

	// A field being edited does.
	byText<HTMLElement>(root, "tbody .editable", "Herbert").click();
	other.addEntity("book", "Clara", "", {});
	await settle();
	lookNow();
	await settle();
	assert.equal([...root.querySelectorAll(".name-link")].some((b) => b.textContent === "Clara"), false);
	assert.ok(root.querySelector("tbody form"));

	root.querySelector("tbody form input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	(document.activeElement as HTMLElement | null)?.blur();
	lookNow();
	await settle();
	assert.ok(byText(root, ".name-link", "Clara"));
});

test("on the board, another tab's changes are drawn in place: the selected card and its details stay", async () => {
	const data = structuredClone(library) as { boards: unknown[] };
	data.boards = [{ id: "b", name: "Board 1", cards: [{ id: "c", entityId: "01J00000000000000000000000", x: 0, y: 0, width: 240, height: 160 }], viewport: { x: 0, y: 0, zoom: 1 }, drawings: [] }];
	const root = await startApp(data, "#boards");
	await settle(); // the page drawn for the address first
	root.querySelector<HTMLElement>('.canvas-card[data-card-id="c"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	const details = root.querySelector<HTMLElement>(".details-panel")!;
	assert.equal(details.hidden, false);

	const other = await otherTab();
	const dune = other.data.entities[0]!;
	other.updateEntity(dune.id, "Dune Messiah", dune.content, dune.values);
	await settle();
	lookNow();
	await settle();
	const card = root.querySelector<HTMLElement>('.canvas-card[data-card-id="c"]')!;
	assert.match(card.textContent ?? "", /Dune Messiah/);
	assert.ok(card.classList.contains("selected"));
	assert.equal(root.querySelector(".details-panel"), details); // the same panel, not a page drawn anew
	assert.match(details.textContent ?? "", /Dune Messiah/);
});

test("a stand saved elsewhere that can't be taken over is offered with the reload button — nothing loads it on its own", async () => {
	const root = await startApp(library);
	await settle();
	const newer = { ...library, version: 999 };
	storage.saveElsewhere(WS, newer); // saved by a newer version of the app
	lookNow();
	await settle();
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.match(banner.textContent ?? "", new RegExp(sharedText.changedElsewhere.slice(0, 20)));
	assert.ok(byText(banner, "button", sharedText.reload));
	assert.ok(byText(root, "td", "Dune"));
	assert.deepEqual(storage.data(WS), newer);
});

test("the tab hidden asks nothing: no eyes on it, nothing on the wire; visible again, it looks", async () => {
	const root = await startApp(library);
	const looks = storage.looks;
	await settle();
	const asked = looks();

	// Nobody can see the tab: focus (whatever brought it there) may come and go, nothing is asked.
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
	try {
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("focus"));
		await settle();
		assert.equal(looks(), asked);

		// Back in the front — the moment the user looks — the look goes out at once.
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		window.dispatchEvent(new Event("focus"));
		await settle();
		assert.equal(looks(), asked + 1);
		assert.equal(root.querySelector<HTMLElement>(".problem-banner")!.hidden, true);
	} finally {
		Reflect.deleteProperty(document, "visibilityState");
	}
});

test("drawing the page again and again starts no further timers: one watch for the page's whole life", async (t) => {
	freshDom();
	const started = t.mock.method(window, "setInterval");
	const root = document.querySelector<HTMLElement>("#app")!;
	await render(root, await createWorkspaces(memoryStorage(library).port, sharedText.defaultWorkspaceName, activeWorkspacePreference));
	assert.equal(started.mock.callCount(), 1);

	// Whatever draws the page anew, none of it may start a watch of its own (or the page would ask faster and
	// faster with every re-draw): a route switch, a form opening, a language change from the menu.
	window.dispatchEvent(new Event("hashchange"));
	assert.equal(started.mock.callCount(), 1);
	byText(root, ".name-link", "Dune").click();
	assert.equal(started.mock.callCount(), 1);
	setLanguage("de"); // a language change draws the page again, every label of it
	window.dispatchEvent(new Event("hashchange"));
	assert.equal(started.mock.callCount(), 1);
	setLanguage("en");
});

test("following references: a reference in the table leads to its row; the details name the boards with a card of the entity, each a link to it", async () => {
	const ref = (id: string, typeId: string) => ({ id, name: "Author", kind: "reference", options: [], reference: { typeIds: [typeId], multiple: false, required: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list", description: "" });
	const frank = "01J00000000000000000000001";
	const dune = "01J00000000000000000000002";
	const data = {
		version: DATA_VERSION,
		types: [
			{ id: "book", name: "Book", color: "#c4dafa", contentTemplate: "", description: "", guide: "", properties: [ref("author", "person")] },
			{ id: "person", name: "Person", color: "#c8ebbf", contentTemplate: "", description: "", guide: "", properties: [] },
		],
		entities: [
			{ id: dune, typeId: "book", name: "Dune", content: "", description: "", tags: [], values: { author: frank } },
			{ id: frank, typeId: "person", name: "Frank", content: "", description: "", tags: [], values: {} },
		],
		boards: [
			{ id: "b1", name: "Bücher", cards: [{ id: "c1", entityId: dune, x: 0, y: 0, width: 200, height: 80 }] },
			{ id: "b2", name: "Leute", cards: [{ id: "c2", entityId: frank, x: 0, y: 0, width: 200, height: 80 }] },
		],
		analyses: [{ id: "a", name: "Bücher", typeId: "book", traitId: null, groups: [], columns: [] }],
	};
	const root = await startApp(data, "#entities");
	const link = byText<HTMLAnchorElement>(root, ".entity-table a.ref-tag", "Frank");
	assert.equal(link.getAttribute("href"), `#entities/${frank}`);
	goTo(link.getAttribute("href")!);
	assert.deepEqual(rowNames(root), ["Frank"], "the type of the entity it leads to");
	assert.equal(root.querySelector(".entity-table tr.target .name-cell")?.textContent, "Frank");
	byText(root, ".type-chip", "Book1").click();
	assert.deepEqual(rowNames(root), ["Dune"], "the address doesn't hold the page on its type");

	goTo("#analysis");
	byText(root, ".analysis-result .entity-link", "Dune").click();
	const panel = root.querySelector<HTMLElement>(".analysis-view .details-panel")!;
	assert.deepEqual([...panel.querySelectorAll(".details-places a")].map((a) => [a.textContent, a.getAttribute("href")]), [["Bücher", `#boards/b1/${dune}`]]);
	assert.ok(byText(panel, ".details-id a", historyText.historyLink));
	byText(panel, ".ref-tag", "Frank").click();
	assert.deepEqual([...panel.querySelectorAll(".details-places a")].map((a) => a.textContent), ["Leute"]);

	goTo(`#boards/b2/${frank}`);
	assert.equal(root.querySelector(".canvas-card.selected .card-title")?.textContent, "Frank", "the board opened, the card selected");
	assert.equal(root.querySelector(".details-panel .details-title")?.textContent, "Frank");
});

test("the search (⌘K) finds entities, types, boards, analyses and traits by name, goes there with Enter, and offers what to make", async () => {
	const dune = "01J00000000000000000000002";
	const data = {
		version: DATA_VERSION,
		types: [{ id: "book", name: "Book", color: "#c4dafa", contentTemplate: "", description: "", guide: "", properties: [] }],
		entities: [
			{ id: "01J00000000000000000000001", typeId: "book", name: "Emma", content: "", description: "", tags: [], values: {} },
			{ id: dune, typeId: "book", name: "Düne", content: "", description: "", tags: [], values: {} },
		],
		boards: [{ id: "b1", name: "Bücher", cards: [] }],
		analyses: [{ id: "a1", name: "Alle Bücher", typeId: "book", traitId: null, groups: [], columns: [] }],
		traits: [{ id: "t1", name: "Fortschritt", roles: [], bindings: {} }],
	};
	const root = await startApp(data, "#types");
	const dialog = () => root.querySelector<HTMLDialogElement>(".search-dialog")!;
	const input = () => dialog().querySelector("input")!;
	const options = () => [...dialog().querySelectorAll(".search-option")].map((o) => o.textContent);
	const press = (key: string, more: KeyboardEventInit = {}) => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...more }));
	const typeQuery = (value: string) => {
		input().value = value;
		input().dispatchEvent(new Event("input"));
	};

	press("k", { metaKey: true });
	assert.equal(dialog().open, true);
	assert.equal(document.activeElement, input());
	assert.deepEqual(options(), [dataText.createNewEntity, dataText.createNewType, boardText.newBoard, analysisText.newAnalysis, traitText.newTrait, exportText.exportTextButton], "empty, it offers what to make");

	typeQuery("DUN");
	assert.deepEqual(options(), ["DüneBook"], "found by name, without case and accents, with its type");
	typeQuery("bü");
	assert.deepEqual(options(), [`Bücher${boardText.board}`, `Alle Bücher${analysisText.analysis}`], "a name starting with it first");
	press("ArrowDown");
	press("Enter");
	assert.equal(dialog().open, false);
	assert.equal(location.hash, "#analysis/a1");
	window.dispatchEvent(new Event("hashchange"));
	assert.equal(root.querySelector(".analysis-setup h2")?.textContent, "Alle Bücher");

	press("k", { ctrlKey: true });
	typeQuery("düne");
	press("Enter");
	window.dispatchEvent(new Event("hashchange"));
	assert.equal(location.hash, `#entities/${dune}`);
	assert.equal(root.querySelector(".entity-table tr.target .name-cell")?.textContent, "Düne");

	// A type opens its form; "New type" the form for a new one.
	press("k", { ctrlKey: true });
	typeQuery("book");
	press("Enter");
	window.dispatchEvent(new Event("hashchange"));
	assert.equal(root.querySelector("#type-form h3")?.textContent, dataText.editNamed("Book"));
	byText(root, "#type-form button", sharedText.cancel).click();
	press("k", { ctrlKey: true });
	typeQuery(dataText.createNewType);
	press("Enter");
	window.dispatchEvent(new Event("hashchange"));
	assert.equal(root.querySelector("#type-form h3")?.textContent, dataText.newType);

	press("k", { ctrlKey: true });
	typeQuery(dataText.createNewEntity);
	press("Enter");
	window.dispatchEvent(new Event("hashchange"));
	assert.ok(root.querySelector("#entity-form"), "the form for a new entity");

	// "New board" makes one and opens it.
	press("k", { ctrlKey: true });
	typeQuery(boardText.newBoard);
	press("Enter");
	window.dispatchEvent(new Event("hashchange"));
	await settle();
	assert.deepEqual((await readSaved()).boards.map((b) => b.name), ["Bücher", boardText.defaultBoardName(1)]);
});

test("the board's side panel filters entities by tag", async () => {
	const root = await startApp(tagged, "#boards");
	const panelNames = () => [...root.querySelectorAll(".panel-list .panel-item > :first-child")].map((n) => n.textContent?.trim());
	assert.equal(panelNames().length, 3);
	choose(tagSelectIn(root.querySelector(".panel-filters"))!, "Romance");
	assert.deepEqual(panelNames(), ["Emma"]);
});

test("without tags in use there's no tag filter", async () => {
	const root = await startApp(library, "#entities");
	assert.equal(tagSelectIn(root), null);
	goTo("#boards");
	assert.equal(tagSelectIn(root), null);
});

test("the settings switch the theme: dark or light on <html>, or none to follow the system, remembered in this browser", async () => {
	const root = await startApp();
	const select = byText(root, "#settings-menu label > span", sharedText.theme).closest("label")!.querySelector("select")!;
	assert.equal(select.value, "system");
	assert.equal(document.documentElement.dataset.theme, undefined);

	select.value = "dark";
	select.dispatchEvent(new Event("change"));
	assert.equal(document.documentElement.dataset.theme, "dark");
	assert.equal(localStorage.getItem("ui-theme"), "dark");

	select.value = "system";
	select.dispatchEvent(new Event("change"));
	assert.equal(document.documentElement.dataset.theme, undefined);
	assert.equal(localStorage.getItem("ui-theme"), "system");
});

test("the settings let references on cards wrap instead of being cut off, remembered in this browser", async () => {
	const root = await startApp();
	const checkbox = () => byText(root, "#settings-menu label", dataText.wrapReferences).querySelector("input")!;
	assert.equal(checkbox().checked, false);
	assert.equal(document.documentElement.dataset.wrapReferences, undefined);

	checkbox().click();
	assert.equal(document.documentElement.dataset.wrapReferences, "");
	assert.equal(localStorage.getItem("wrap-references"), "true");
	assert.equal(checkbox().checked, true, "still checked once drawn anew");

	checkbox().click();
	assert.equal(document.documentElement.dataset.wrapReferences, undefined);
	assert.equal(localStorage.getItem("wrap-references"), "false");
});
