import { freshDom, localStoragePort } from "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { text } from "./i18n.js";
import type { AppData } from "@bekbon/core";
import { render } from "./ui.js";
import { createStore } from "@bekbon/core";
import { createWorkspaces, dataKey } from "@bekbon/core";

/** Renders the app on a fresh page (at `hash`, e.g. "#canvas"), with `saved` already in the browser storage. */
async function startApp(saved: Record<string, string> = {}, hash = ""): Promise<HTMLElement> {
	freshDom();
	location.hash = hash;
	for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
	const root = document.querySelector<HTMLElement>("#app")!;
	const workspaces = await createWorkspaces(localStoragePort(), text.defaultWorkspaceName);
	await render(root, workspaces);
	return root;
}

/** Lets work started by a click or an event finish first (the stores open through the async storage port). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

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

const savedData = (key = "entities-app"): AppData => JSON.parse(localStorage.getItem(key) ?? "null");

/** One type (Book, with a text property "author") and one entity (Dune), as saved data. */
const library = JSON.stringify({
	types: [
		{ id: "book", name: "Book", color: "#c4dafa", contentTemplate: "", properties: [{ id: "author", name: "author", kind: "text", options: [], reference: null, cardDisplay: "list" }] },
	],
	entities: [{ id: "01J00000000000000000000000", typeId: "book", name: "Dune", content: "", description: "", values: { author: "Herbert" } }],
	boards: [],
});

test("a type with a property, then an entity of it, can be created through the forms and are saved", async () => {
	const root = await startApp();
	const typeForm = root.querySelector<HTMLFormElement>("#type-form")!;
	typeInto(typeForm.querySelector(`input[placeholder="${text.typeNamePlaceholder}"]`)!, "Book");
	byText(typeForm, "button", text.addProperty).click();
	// The form was drawn again with the new property; the typed name is kept.
	const form = root.querySelector<HTMLFormElement>("#type-form")!;
	typeInto(form.querySelector(`input[placeholder="${text.propertyName}"]`)!, "author");
	byText(form, "button", text.createType).click();

	assert.ok(byText(root, ".type-name", "Book"));
	const [book] = savedData().types;
	assert.equal(book?.name, "Book");
	assert.deepEqual(book?.properties.map((p) => p.name), ["author"]);

	const entityForm = root.querySelector<HTMLFormElement>("#entity-form")!;
	const [nameInput, authorInput] = entityForm.querySelectorAll<HTMLInputElement>("label.field input");
	nameInput!.value = " Dune ";
	authorInput!.value = "Herbert";
	byText(entityForm, "button", text.create).click();

	assert.ok(byText(root, "td", "Dune"));
	assert.ok(byText(root, "td", "Herbert"));
	const [dune] = savedData().entities;
	assert.equal(dune?.name, "Dune");
	assert.equal(dune?.values[book!.properties[0]!.id], "Herbert");
});

test("an invalid type shows its problems and isn't saved", async () => {
	const root = await startApp();
	byText(root.querySelector("#type-form")!, "button", text.createType).click();
	assert.equal(root.querySelector("#type-form .error")?.textContent, text.validation({ code: "typeNameRequired" }));
	assert.equal(localStorage.getItem("entities-app"), null);
});

test("deleting an entity asks first; cancelling keeps it", async () => {
	const root = await startApp({ "entities-app": library });
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
	assert.equal(savedData().entities.length, 1);

	answer = true;
	deleteDune();
	assert.equal(savedData().entities.length, 0);
	assert.ok(byText(root, "p", text.noEntitiesOfType("Book")));
});

test("a type other types refer to can't be deleted", async () => {
	const data = JSON.parse(library);
	data.types.push({ id: "review", name: "Review", properties: [{ id: "of", name: "of", kind: "reference", options: [], reference: { typeId: "book", multiple: false }, cardDisplay: "list" }] });
	const root = await startApp({ "entities-app": JSON.stringify(data) });
	const alerts: string[] = [];
	stub({ alert: (message: string) => void alerts.push(message), confirm: () => assert.fail("shouldn't ask to confirm") });

	const bookItem = root.querySelector(".type-item")!;
	byText(bookItem, "button", text.delete).click();
	assert.deepEqual(alerts, [text.cannotDeleteType("Book", "Review.of")]);
	assert.equal(savedData().types.length, 2);
});

test("a new workspace from the menu starts empty and becomes active; switching back shows the first one again", async () => {
	const root = await startApp({ "entities-app": library });
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

test("the banner warns about unreadable saved data until dismissed", async () => {
	const root = await startApp({ "entities-app": "{not json" });
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.match(banner.textContent ?? "", /entities-app:backup:/);
	assert.ok(byText(banner, "button", text.downloadOriginal));

	byText(banner, "button", text.dismiss).click();
	assert.equal(banner.hidden, true);
});

test("a page that can't be drawn shows the error screen, which can still export", async (t) => {
	const logged = t.mock.method(console, "error", () => {});
	const root = await startApp({ "entities-app": library });
	const createElement = document.createElement.bind(document);
	document.createElement = ((tag: string) => {
		if (tag === "table") throw new Error("table failed");
		return createElement(tag);
	}) as typeof document.createElement;

	byText(root.querySelector(".type-item")!, "button", text.edit).click(); // draws the page again

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

/** What a browser does in this tab when another tab saved under `key`. */
const otherTabSaved = (key: string) =>
	window.dispatchEvent(new StorageEvent("storage", { key, newValue: localStorage.getItem(key), storageArea: localStorage }));

test("changes saved in another tab show up here, and saving here keeps them", async () => {
	const root = await startApp({ "entities-app": library });
	(await createStore(localStoragePort())).addType("Film", [], ""); // in the other tab
	otherTabSaved("entities-app");
	await settle();
	assert.ok(byText(root, ".type-name", "Film"));

	// Saving here (deleting Dune) mustn't drop the other tab's type.
	stub({ confirm: () => true });
	byText(byText(root, "td", "Dune").closest("tr")!, "button", text.delete).click();
	assert.deepEqual(savedData().types.map((t) => t.name), ["Book", "Film"]);
	assert.equal(savedData().entities.length, 0);
});

test("when another tab deletes the workspace open here, this tab switches to one that's left", async () => {
	const root = await startApp();
	const newForm = root.querySelector<HTMLFormElement>(".workspace-new")!;
	newForm.querySelector<HTMLInputElement>("input:not([type])")!.value = "Second";
	byText(newForm, "button", text.create).click();
	await settle();
	const secondId = (await createWorkspaces(localStoragePort(), text.defaultWorkspaceName)).active.id;

	const otherTab = await createWorkspaces(localStoragePort(), text.defaultWorkspaceName);
	otherTab.remove(secondId);
	otherTabSaved(dataKey(secondId));
	otherTabSaved("workspaces");
	await settle();

	assert.equal(root.querySelector(".workspace-name")?.textContent, text.defaultWorkspaceName(1));
	assert.equal(localStorage.getItem(dataKey(secondId)), null); // not written back
});

const press = (target: Element, key: string, modifiers: KeyboardEventInit = {}) =>
	target.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...modifiers }));

test("a deleted entity comes back with the Undo button, and goes again with Ctrl+Y", async () => {
	const root = await startApp({ "entities-app": library });
	const [undo, redo] = root.querySelectorAll<HTMLButtonElement>(".history-button") as unknown as [HTMLButtonElement, HTMLButtonElement];
	assert.equal(undo.disabled, true);

	stub({ confirm: () => true });
	byText(byText(root, "td", "Dune").closest("tr")!, "button", text.delete).click();
	assert.equal(undo.disabled, false);

	undo.click();
	assert.ok(byText(root, "td", "Dune"));
	assert.equal(savedData().entities.length, 1);
	assert.equal(redo.disabled, false);

	press(document.body, "y");
	assert.equal(savedData().entities.length, 0);
	assert.equal(root.querySelector("td"), null);
});

test("Ctrl+Z undoes outside text fields; inside one it's left to the browser's text undo", async () => {
	const root = await startApp({ "entities-app": library });
	stub({ confirm: () => true });
	byText(byText(root, "td", "Dune").closest("tr")!, "button", text.delete).click();

	const nameInput = root.querySelector<HTMLInputElement>("#entity-form input")!;
	assert.equal(press(nameInput, "z"), true); // not handled: the default (text undo) isn't prevented
	assert.equal(savedData().entities.length, 0);

	assert.equal(press(document.body, "z"), false);
	assert.equal(savedData().entities.length, 1);
	press(document.body, "z", { shiftKey: true });
	assert.equal(savedData().entities.length, 0);
});

test("canvas changes can be undone too: the Undo button follows them without the page being drawn again", async () => {
	const data = JSON.parse(library);
	data.boards = [{ id: "b", name: "Board 1", cards: [{ id: "c", entityId: "01J00000000000000000000000", x: 0, y: 0, width: 240, height: 160 }], viewport: { x: 0, y: 0, zoom: 1 }, drawings: [] }];
	const root = await startApp({ "entities-app": JSON.stringify(data) }, "#canvas");
	const [undo] = root.querySelectorAll<HTMLButtonElement>(".history-button");

	root.querySelector<HTMLButtonElement>(".canvas-board .card-remove")!.click();
	assert.equal(root.querySelector(".canvas-board .canvas-card"), null);
	assert.equal(undo!.disabled, false);

	undo!.click();
	assert.ok(root.querySelector('.canvas-board .canvas-card[data-card-id="c"]'));
});

test("a workspace saved by a newer version warns that changes aren't saved, and offers a reload", async () => {
	const root = await startApp({ "entities-app": JSON.stringify({ version: 999, types: [], entities: [] }) });
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.match(banner.textContent ?? "", new RegExp(text.loadNewerVersion.slice(0, 20)));
	assert.ok(byText(banner, "button", text.reload));
	assert.equal(banner.querySelector(`button`)?.textContent, text.reload); // nothing to dismiss
});
