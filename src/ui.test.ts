import { freshDom } from "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { text } from "./i18n.js";
import type { AppData } from "./model.js";
import { render } from "./ui.js";
import { createStore } from "./store.js";
import { createWorkspaces, dataKey } from "./workspaces.js";

/** Renders the app on a fresh page, with `saved` already in the browser storage. */
function startApp(saved: Record<string, string> = {}): HTMLElement {
	freshDom();
	for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
	const root = document.querySelector<HTMLElement>("#app")!;
	render(root, createWorkspaces(localStorage, text.defaultWorkspaceName));
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

const savedData = (key = "entities-app"): AppData => JSON.parse(localStorage.getItem(key) ?? "null");

/** One type (Book, with a text property "author") and one entity (Dune), as saved data. */
const library = JSON.stringify({
	types: [
		{ id: "book", name: "Book", color: "#c4dafa", contentTemplate: "", properties: [{ id: "author", name: "author", kind: "text", options: [], reference: null, cardDisplay: "list" }] },
	],
	entities: [{ id: "01J00000000000000000000000", typeId: "book", name: "Dune", content: "", description: "", values: { author: "Herbert" } }],
	boards: [],
});

test("a type with a property, then an entity of it, can be created through the forms and are saved", () => {
	const root = startApp();
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

test("an invalid type shows its problems and isn't saved", () => {
	const root = startApp();
	byText(root.querySelector("#type-form")!, "button", text.createType).click();
	assert.equal(root.querySelector("#type-form .error")?.textContent, text.validation({ code: "typeNameRequired" }));
	assert.equal(localStorage.getItem("entities-app"), null);
});

test("deleting an entity asks first; cancelling keeps it", () => {
	const root = startApp({ "entities-app": library });
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

test("a type other types refer to can't be deleted", () => {
	const data = JSON.parse(library);
	data.types.push({ id: "review", name: "Review", properties: [{ id: "of", name: "of", kind: "reference", options: [], reference: { typeId: "book", multiple: false }, cardDisplay: "list" }] });
	const root = startApp({ "entities-app": JSON.stringify(data) });
	const alerts: string[] = [];
	stub({ alert: (message: string) => void alerts.push(message), confirm: () => assert.fail("shouldn't ask to confirm") });

	const bookItem = root.querySelector(".type-item")!;
	byText(bookItem, "button", text.delete).click();
	assert.deepEqual(alerts, [text.cannotDeleteType("Book", "Review.of")]);
	assert.equal(savedData().types.length, 2);
});

test("a new workspace from the menu starts empty and becomes active; switching back shows the first one again", () => {
	const root = startApp({ "entities-app": library });
	const newForm = root.querySelector<HTMLFormElement>(".workspace-new")!;
	newForm.querySelector<HTMLInputElement>("input:not([type])")!.value = "Second";
	byText(newForm, "button", text.create).click();

	assert.equal(root.querySelector(".workspace-name")?.textContent, "Second");
	assert.ok(byText(root, "p", text.noTypesYet));

	byText(root, ".workspace-option", text.defaultWorkspaceName(1)).click();
	assert.equal(root.querySelector(".workspace-name")?.textContent, text.defaultWorkspaceName(1));
	assert.ok(byText(root, ".type-name", "Book"));
});

test("the banner warns about unreadable saved data until dismissed", () => {
	const root = startApp({ "entities-app": "{not json" });
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.match(banner.textContent ?? "", /entities-app:backup:/);
	assert.ok(byText(banner, "button", text.downloadOriginal));

	byText(banner, "button", text.dismiss).click();
	assert.equal(banner.hidden, true);
});

test("a page that can't be drawn shows the error screen, which can still export", (t) => {
	const logged = t.mock.method(console, "error", () => {});
	const root = startApp({ "entities-app": library });
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

test("errors thrown outside rendering show in the banner", () => {
	const root = startApp();
	window.dispatchEvent(new ErrorEvent("error", { error: new Error("handler failed") }));
	const banner = root.querySelector<HTMLElement>(".problem-banner")!;
	assert.equal(banner.hidden, false);
	assert.match(banner.textContent ?? "", /handler failed/);
});

/** What a browser does in this tab when another tab saved under `key`. */
const otherTabSaved = (key: string) =>
	window.dispatchEvent(new StorageEvent("storage", { key, newValue: localStorage.getItem(key), storageArea: localStorage }));

test("changes saved in another tab show up here, and saving here keeps them", () => {
	const root = startApp({ "entities-app": library });
	createStore(localStorage).addType("Film", [], ""); // in the other tab
	otherTabSaved("entities-app");
	assert.ok(byText(root, ".type-name", "Film"));

	// Saving here (deleting Dune) mustn't drop the other tab's type.
	stub({ confirm: () => true });
	byText(byText(root, "td", "Dune").closest("tr")!, "button", text.delete).click();
	assert.deepEqual(savedData().types.map((t) => t.name), ["Book", "Film"]);
	assert.equal(savedData().entities.length, 0);
});

test("when another tab deletes the workspace open here, this tab switches to one that's left", () => {
	const root = startApp();
	const newForm = root.querySelector<HTMLFormElement>(".workspace-new")!;
	newForm.querySelector<HTMLInputElement>("input:not([type])")!.value = "Second";
	byText(newForm, "button", text.create).click();
	const secondId = createWorkspaces(localStorage, text.defaultWorkspaceName).active.id;

	const otherTab = createWorkspaces(localStorage, text.defaultWorkspaceName);
	otherTab.remove(secondId);
	otherTabSaved(dataKey(secondId));
	otherTabSaved("workspaces");

	assert.equal(root.querySelector(".workspace-name")?.textContent, text.defaultWorkspaceName(1));
	assert.equal(localStorage.getItem(dataKey(secondId)), null); // not written back
});
