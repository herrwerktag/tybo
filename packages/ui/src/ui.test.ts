import { freshDom } from "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setLanguage, text } from "./i18n.js";
import type { AppData } from "@tybo/core";
import { render } from "./ui.js";
import { DATA_VERSION, createWorkspaces } from "@tybo/core";
import { memoryDataPort } from "@tybo/core/testing";
import { activeWorkspacePreference } from "./preferences.js";

/** Lets work started by a click or an event finish first (the stores open and save through the async port). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

/** The workspace the tests' saved data is in. */
const WS = "ws";

/** The storage in memory, with `saved` as the data of the workspace WS (named as the first workspace is) — or
 * no workspace at all, the way the very first start finds it. */
function memoryStorage(saved?: unknown) {
	const behind = memoryDataPort(saved === undefined ? {} : { [WS]: saved });
	if (saved !== undefined) void behind.port.renameWorkspace(WS, text.defaultWorkspaceName(1)); // done at once, in memory
	return behind;
}

/** The storage behind the app the last startApp started. */
let storage = memoryStorage();

/** Renders the app on a fresh page (at `hash`, e.g. "#boards"), with `saved` already in the storage. A different
 * storage `behind` it shows what the app does with one that answers otherwise (with collisions, for instance). */
async function startApp(saved?: unknown, hash = "", behind = memoryStorage(saved), options: { viewScript?: string } = {}): Promise<HTMLElement> {
	freshDom();
	location.hash = hash;
	storage = behind;
	const root = document.querySelector<HTMLElement>("#app")!;
	const workspaces = await createWorkspaces(behind.port, text.defaultWorkspaceName, activeWorkspacePreference);
	await render(root, workspaces, options);
	return root;
}

/** The element matching `selector` whose text is `label`. */
function byText<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string, label: string): T {
	const found = [...root.querySelectorAll<T>(selector)].find((node) => node.textContent?.trim() === label);
	assert.ok(found, `no ${selector} with text "${label}"`);
	return found;
}

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Replaces browser dialogs (alert, confirm, prompt) for the current page. */
const stub = (dialogs: Partial<Record<"alert" | "confirm" | "prompt", (message: string) => unknown>>) => Object.assign(globalThis, dialogs);

/** The data of the first workspace, as the storage holds it once the saves on their way have landed. */
async function readSaved(): Promise<AppData> {
	await settle();
	const [first] = await storage.port.listWorkspaces();
	return storage.data(first!.id) as unknown as AppData;
}

/** One type (Book, with a text property "author") and one entity (Dune), as saved data. */
const library = {
	types: [
		{ id: "book", name: "Book", color: "#c4dafa", contentTemplate: "", properties: [{ id: "author", name: "author", kind: "text", options: [], reference: null, cardDisplay: "list" }] },
	],
	entities: [{ id: "01J00000000000000000000000", typeId: "book", name: "Dune", content: "", description: "", values: { author: "Herbert" } }],
	boards: [],
};

/** Shows another page, the way a click on a nav link does. */
function goTo(hash: string): void {
	location.hash = hash;
	window.dispatchEvent(new Event("hashchange"));
}

test("a type with a property, then an entity of it, can be created through the forms and are saved", async () => {
	const root = await startApp(undefined, "#types");
	byText(root, "button", text.createNewType).click();
	const typeForm = root.querySelector<HTMLFormElement>("#type-form")!;
	typeInto(typeForm.querySelector(`input[placeholder="${text.typeNamePlaceholder}"]`)!, "Book");
	byText(typeForm, "button", text.addProperty).click();
	// The form was drawn again with the new property; the typed name is kept.
	const form = root.querySelector<HTMLFormElement>("#type-form")!;
	typeInto(form.querySelector(`input[placeholder="${text.propertyName}"]`)!, "author");
	byText(form, "button", text.createType).click();

	assert.ok(byText(root, ".type-name", "Book"));
	const [book] = (await readSaved()).types;
	assert.equal(book?.name, "Book");
	assert.deepEqual(book?.properties.map((p) => p.name), ["author"]);
	assert.equal(root.querySelector("#type-form"), null); // created: the form closes

	goTo("#entities");
	byText(root, "button", text.createNewEntity).click();
	const entityForm = root.querySelector<HTMLFormElement>("#entity-form")!;
	const [nameInput, authorInput] = entityForm.querySelectorAll<HTMLInputElement>("label.field input");
	nameInput!.value = " Dune ";
	authorInput!.value = "Herbert";
	byText(entityForm, "button", text.create).click();

	assert.ok(byText(root, "td", "Dune"));
	assert.ok(byText(root, "td", "Herbert"));
	const [dune] = (await readSaved()).entities;
	assert.equal(dune?.name, "Dune");
	assert.equal(dune?.values[book!.properties[0]!.id], "Herbert");
	assert.equal(root.querySelector("#entity-form"), null);
});

test("Entities is the default page; its subnav switches between entity types and entities", async () => {
	const root = await startApp(library);
	assert.equal(root.querySelector(".app-nav .current")?.textContent, text.tabEntities);
	assert.equal(root.querySelector(".sub-nav .current")?.textContent, text.entities);
	assert.ok(byText(root, "td", "Dune"));
	assert.equal(root.querySelector(".type-item"), null);

	goTo("#types");
	assert.equal(root.querySelector(".app-nav .current")?.textContent, text.tabEntities);
	assert.equal(root.querySelector(".sub-nav .current")?.textContent, text.entityTypes);
	assert.ok(byText(root, ".type-name", "Book"));
	assert.equal(root.querySelector("td"), null);

	goTo("#boards");
	assert.equal(root.querySelector(".app-nav .current")?.textContent, text.tabBoards);
	assert.equal(root.querySelector(".sub-nav"), null);

	goTo("#canvas"); // the former name still leads there
	assert.equal(root.querySelector(".app-nav .current")?.textContent, text.tabBoards);
});


test("types and entities are reordered with their drag handles' arrow keys; focus stays on the moved one", async () => {
	const root = await startApp({
		...library,
		types: [...library.types, { id: "film", name: "Film", color: "#c8ebbf", contentTemplate: "", properties: [] }],
		entities: [
			...library.entities,
			{ id: "01J00000000000000000000001", typeId: "book", name: "Emma", content: "", description: "", values: {} },
		],
	}, "#types");
	const press = (handle: HTMLElement, key: string) => handle.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

	press(root.querySelectorAll<HTMLElement>(".type-item .drag-handle")[1]!, "ArrowUp");
	assert.deepEqual([...root.querySelectorAll(".type-name")].map((n) => n.textContent), ["Film", "Book"]);
	assert.equal((document.activeElement as HTMLElement).dataset.focusKey, "type:film");
	press(document.activeElement as HTMLElement, "ArrowUp"); // already first: nothing changes
	assert.deepEqual((await readSaved()).types.map((t) => t.id), ["film", "book"]);

	goTo("#entities");
	const select = root.querySelector<HTMLSelectElement>(".section-header select")!;
	select.value = "book";
	select.dispatchEvent(new Event("change"));
	press(root.querySelector<HTMLElement>("tbody .drag-handle")!, "ArrowDown");
	assert.deepEqual([...root.querySelectorAll("tbody tr")].map((tr) => tr.children[2]?.textContent), ["Emma", "Dune"]);
	assert.equal((document.activeElement as HTMLElement).dataset.focusKey, "entity:01J00000000000000000000000");
	assert.deepEqual((await readSaved()).entities.map((e) => e.name), ["Emma", "Dune"]);

	// Dropped on Dune's row (its lower half: the test page has no layout), the dragged Emma goes after it.
	const dataTransfer = new DataTransfer();
	dataTransfer.setData("application/x-entity-index", "0");
	const drop = new DragEvent("drop", { bubbles: true, cancelable: true });
	Object.defineProperty(drop, "dataTransfer", { value: dataTransfer }); // happy-dom leaves it out of the init
	root.querySelectorAll("tbody tr")[1]!.dispatchEvent(drop);
	assert.deepEqual((await readSaved()).entities.map((e) => e.name), ["Dune", "Emma"]);
});
test("the forms for a new type and a new entity are hidden until asked for, and Cancel hides them again", async () => {
	const root = await startApp(library, "#types");
	assert.equal(root.querySelector("#type-form"), null);
	byText(root, "button", text.createNewType).click();
	byText(root.querySelector("#type-form")!, "button", text.cancel).click();
	assert.equal(root.querySelector("#type-form"), null);

	goTo("#entities");
	assert.equal(root.querySelector("#entity-form"), null);
	byText(root, "button", text.createNewEntity).click();
	byText(root.querySelector("#entity-form")!, "button", text.cancel).click();
	assert.equal(root.querySelector("#entity-form"), null);

	// Edit opens the form too.
	byText(byText(root, "td", "Dune").closest("tr")!, "button", text.edit).click();
	assert.equal(root.querySelector<HTMLInputElement>("#entity-form input")?.value, "Dune");
});

test("an invalid type shows its problems and isn't saved", async () => {
	const root = await startApp(undefined, "#types");
	byText(root, "button", text.createNewType).click();
	byText(root.querySelector("#type-form")!, "button", text.createType).click();
	assert.equal(root.querySelector("#type-form .error")?.textContent, text.validation({ code: "typeNameRequired" }));
	assert.deepEqual((await readSaved()).types, []);
	assert.equal(storage.saves.length, 0);
});

test("deleting an entity asks first; cancelling keeps it", async () => {
	const root = await startApp(library);
	const questions: string[] = [];
	let answer = false;
	stub({
		confirm: (message: string) => {
			questions.push(message);
			return answer;
		},
	});
	const deleteDune = () => byText(byText(root, "td", "Dune").closest("tr")!, "button", text.delete).click();

	deleteDune();
	assert.deepEqual(questions, [text.confirmDeleteEntity("Dune", 0)]);
	assert.equal((await readSaved()).entities.length, 1);

	answer = true;
	deleteDune();
	assert.equal((await readSaved()).entities.length, 0);
	assert.ok(byText(root, "p", text.noEntitiesOfType("Book")));
});

test("a type other types refer to can't be deleted", async () => {
	const data = structuredClone(library) as { types: unknown[]; boards: unknown[] };
	data.types.push({ id: "review", name: "Review", properties: [{ id: "of", name: "of", kind: "reference", options: [], reference: { typeId: "book", multiple: false }, cardDisplay: "list" }] });
	const root = await startApp(data, "#types");
	const alerts: string[] = [];
	stub({ alert: (message: string) => void alerts.push(message), confirm: () => assert.fail("shouldn't ask to confirm") });

	const bookItem = root.querySelector(".type-item")!;
	byText(bookItem, "button", text.delete).click();
	assert.deepEqual(alerts, [text.cannotDeleteType("Book", "Review.of")]);
	assert.equal((await readSaved()).types.length, 2);
});

test("a new workspace from the menu starts empty and becomes active; switching back shows the first one again", async () => {
	const root = await startApp(library, "#types");
	const newForm = root.querySelector<HTMLFormElement>(".workspace-new")!;
	newForm.querySelector<HTMLInputElement>("input:not([type])")!.value = "Second";
	byText(newForm, "button", text.create).click();
	await settle();

	assert.equal(root.querySelector(".workspace-name")?.textContent, "Second");
	assert.ok(byText(root, "p", text.noTypesYet));

	byText(root, ".workspace-option", text.defaultWorkspaceName(1)).click();
	await settle();
	assert.equal(root.querySelector(".workspace-name")?.textContent, text.defaultWorkspaceName(1));
	assert.ok(byText(root, ".type-name", "Book"));
});

test("a workspace whose data can't be loaded warns that changes aren't saved, and offers a reload", async () => {
	const behind = memoryStorage(library);
	behind.failing.loads = true;
	const root = await startApp(undefined, "", behind);
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.ok(banner.textContent!.includes(text.loadUnavailable));
	assert.ok(byText(banner, "button", text.reload));
});

test("a page that can't be drawn shows the error screen, which can still export", async (t) => {
	const logged = t.mock.method(console, "error", () => {});
	const root = await startApp(library);
	const createElement = document.createElement.bind(document);
	document.createElement = ((tag: string) => {
		if (tag === "table") throw new Error("table failed");
		return createElement(tag);
	}) as typeof document.createElement;

	byText(byText(root, "td", "Dune").closest("tr")!, "button", text.edit).click(); // draws the page again

	const screen = root.querySelector(".error-screen");
	assert.ok(screen);
	assert.equal(screen.querySelector(".error-detail")?.textContent, "table failed");
	assert.ok(byText(screen, "button", text.reload));
	assert.ok(byText(screen, "button", text.exportButton));
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
	byText(byText(root, "td", "Dune").closest("tr")!, "button", text.delete).click();
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
	byText(byText(root, "td", "Dune").closest("tr")!, "button", text.delete).click();

	byText(root, "button", text.createNewEntity).click();
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

test("the View tab exports the current board as an HTML file with the viewer inside", async () => {
	const data = structuredClone(library) as { boards: unknown[] };
	data.boards = [{ id: "b", name: "Shelf", cards: [{ id: "c", entityId: "01J00000000000000000000000", x: 0, y: 0, width: 240, height: 160 }], viewport: { x: 0, y: 0, zoom: 1 }, drawings: [] }];
	// Without the viewer's script there's nothing to export with.
	assert.equal((await startApp(data, "#view")).querySelector(`button[title="${text.exportView}"]`), null);

	const app = await startApp(data, "#view", memoryStorage(data), { viewScript: "viewer();" });
	const downloads: Blob[] = [];
	const createObjectURL = URL.createObjectURL;
	URL.createObjectURL = (blob: Blob) => (downloads.push(blob), "blob:export");
	try {
		app.querySelector<HTMLButtonElement>(`button[title="${text.exportView}"]`)!.click();
	} finally {
		URL.createObjectURL = createObjectURL;
	}
	assert.equal(downloads[0]?.type, "text/html");
	const html = await downloads[0]!.text();
	assert.match(html, /<title>Shelf<\/title>/);
	assert.match(html, /<script>viewer\(\);<\/script>/);
	assert.match(html, /"name":"Dune"/);
});

test("a workspace saved by a newer version warns that changes aren't saved, and offers a reload", async () => {
	const root = await startApp({ version: 999, types: [], entities: [] });
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.match(banner.textContent ?? "", new RegExp(text.loadNewerVersion.slice(0, 20)));
	assert.ok(byText(banner, "button", text.reload));
	assert.equal(banner.querySelector(`button`)?.textContent, text.reload); // nothing to dismiss
});

test("a save that collided warns of the conflict, not of a failing storage, and offers a reload", async () => {
	// A storage that answers every unit as collided — the way the API's does when someone else saved it first.
	const behind = memoryStorage();
	behind.port.saveChanges = async (_id, changes) => ({ version: "9", collided: changes.map((c) => c.id) });
	const root = await startApp(undefined, "#types", behind);
	byText(root, "button", text.createNewType).click();
	const typeForm = root.querySelector<HTMLFormElement>("#type-form")!;
	typeInto(typeForm.querySelector(`input[placeholder="${text.typeNamePlaceholder}"]`)!, "Book");
	byText(typeForm, "button", text.createType).click();
	await settle();

	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.ok(banner.textContent!.includes(text.saveConflict));
	assert.equal(banner.textContent!.includes(text.saveFailed), false); // honestly: not a storage problem
	assert.ok(byText(banner, "button", text.reload));
});

/** What the page does when the tab takes the front again: it looks for a newer stand at once. */
const lookNow = () => window.dispatchEvent(new Event("focus"));

test("a stand saved elsewhere in between is noticed and offered with the reload button — nothing loads it on its own", async () => {
	const root = await startApp(library);
	await settle();
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, true); // nobody else changed anything: no hint

	storage.saveElsewhere(WS); // another tab saved this workspace in between
	lookNow();
	await settle();
	assert.equal(banner.hidden, false);
	assert.match(banner.textContent ?? "", new RegExp(text.changedElsewhere.slice(0, 20)));
	assert.ok(byText(banner, "button", text.reload));

	// The look didn't load anything: the page shows the stand it read, and the saved data wasn't run over.
	assert.ok(byText(root, "td", "Dune"));
	assert.deepEqual(storage.data(WS), library);
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
	await render(root, await createWorkspaces(memoryStorage(library).port, text.defaultWorkspaceName, activeWorkspacePreference));
	assert.equal(started.mock.callCount(), 1);

	// Whatever draws the page anew, none of it may start a watch of its own (or the page would ask faster and
	// faster with every re-draw): a route switch, a form opening, a language change from the menu.
	window.dispatchEvent(new Event("hashchange"));
	assert.equal(started.mock.callCount(), 1);
	byText(byText(root, "td", "Dune").closest("tr")!, "button", text.edit).click();
	assert.equal(started.mock.callCount(), 1);
	setLanguage("de"); // a language change draws the page again, every label of it
	window.dispatchEvent(new Event("hashchange"));
	assert.equal(started.mock.callCount(), 1);
	setLanguage("en");
});

test("the Library tab: drawings are made, named, tagged, found, drawn with the board's tools, and deleted with their places", async () => {
	const board = {
		id: "board",
		name: "Board 1",
		cards: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		drawings: [{ id: "placed", kind: "symbol", libraryId: "star", x: 0, y: 0, width: 50, height: 50 }],
		story: false,
		pages: [],
	};
	const star = { id: "star", name: "Star", tags: [], drawings: [] };
	const root = await startApp({ version: DATA_VERSION, types: [], entities: [], boards: [board], library: [star] }, "#library");
	assert.equal(byText(root, ".app-nav .tab", "Library").getAttribute("aria-current"), "page");
	assert.equal(byText(root, ".library-entry", "Star").ariaCurrent, "true");
	assert.match(root.querySelector(".library-uses")!.textContent!, /Placed 1× on 1 board/);

	byText<HTMLButtonElement>(root, "button", "New drawing").click();
	const [name, tags] = root.querySelectorAll<HTMLInputElement>(".library-meta input");
	assert.equal(name!.value, "Drawing 2");
	name!.value = "Moon";
	name!.dispatchEvent(new Event("change"));
	tags!.value = "night, Night, sky";
	tags!.dispatchEvent(new Event("change"));
	assert.equal(tags!.value, "night, sky");

	// The board's drawing tools: a click with the rectangle tool makes one in the library drawing.
	byText<HTMLButtonElement>(root, ".library-canvas .drawing-tools button", "▭").click();
	const surface = root.querySelector<HTMLElement>(".library-canvas .canvas-surface")!;
	const at = (type: string) =>
		surface.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 10, clientY: 10 }));
	at("pointerdown");
	at("pointerup");

	let saved = await readSaved();
	assert.deepEqual(saved.library.map(({ name, tags }) => ({ name, tags })), [{ name: "Star", tags: [] }, { name: "Moon", tags: ["night", "sky"] }]);
	assert.deepEqual(saved.library[1]!.drawings.map((d) => d.kind), ["rect"]);
	assert.equal(root.querySelectorAll(".library-entry")[1]!.querySelectorAll(".library-picture rect.drawing-shape").length, 1, "the thumbnail follows");

	const search = root.querySelector<HTMLInputElement>(".library-panel input[type=search]")!;
	typeInto(search, "SKY");
	assert.deepEqual([...root.querySelectorAll(".library-entry")].map((e) => e.textContent), ["Moonnight, sky"]);
	typeInto(search, "");

	// Deleting asks first, saying where it's placed; its places on boards go with it.
	const asked: string[] = [];
	stub({ confirm: (message) => (asked.push(message), true) });
	byText(root, ".library-entry", "Star").click();
	byText<HTMLButtonElement>(root, "button", "Delete from library").click();
	assert.match(asked[0]!, /"Star".*placed 1× on 1 board/);
	saved = await readSaved();
	assert.deepEqual(saved.library.map((item) => item.name), ["Moon"]);
	assert.deepEqual(saved.boards[0]!.drawings, []);
});
