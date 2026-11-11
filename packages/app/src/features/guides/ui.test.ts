import { byText, goTo, library, readSaved, settle, startApp, storage, typeInto } from "../../test-app.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION } from "../../shared/core/index.js";
import { sharedText } from "../../shared/ui/index.js";
import { text } from "./texts.js";

const view = (root: HTMLElement) => root.querySelector<HTMLElement>(".guide-view")!;

test("the Guide tab shows the workspace's guide, formatted and whole", async () => {
	const guide = "# Spark to Spec\n\nErst die **Idee**, dann der Pitch.\n\n## Beispiel\n\n- Idee „Modellhilfe“\n- Pitch „Modellhilfe im Arbeitsbereich“";
	const root = await startApp({ version: DATA_VERSION, ...library, guide }, "#guide");
	assert.equal(root.querySelector(".tab.current")?.textContent, text.tabGuide);
	const shown = view(root).querySelector(".guide-text .markdown")!;
	assert.equal(shown.querySelector("strong")?.textContent, "Idee");
	assert.deepEqual([...shown.querySelectorAll("li")].map((li) => li.textContent), ["Idee „Modellhilfe“", "Pitch „Modellhilfe im Arbeitsbereich“"]);
	assert.equal(view(root).querySelector("form"), null, "read first; Edit opens the form");
	assert.equal(view(root).querySelector(".empty-state"), null);
});

test("without a guide the page says what belongs there; written and saved, it is the workspace's guide — also after loading anew", async () => {
	const root = await startApp({ version: DATA_VERSION, ...library }, "#guide");
	assert.equal(view(root).querySelector(".empty-state p")?.textContent, text.noGuideYet);
	assert.equal(view(root).querySelectorAll("button").length, 1, "one step: writing it");
	byText(view(root), "button", text.writeGuide).click();
	const area = view(root).querySelector<HTMLTextAreaElement>("#guide-form textarea")!;
	assert.equal(document.activeElement, area);
	typeInto(area, "# Methode\n\nErst die Idee.");
	byText(view(root), "button", sharedText.save).click();

	assert.equal(view(root).querySelector("form"), null);
	assert.equal(view(root).querySelector(".guide-text p")?.textContent, "Erst die Idee.");
	assert.equal((await readSaved()).guide, "# Methode\n\nErst die Idee.");
	const behind = storage;
	const again = await startApp(undefined, "#guide", behind);
	assert.equal(view(again).querySelector(".guide-text p")?.textContent, "Erst die Idee.");
});

test("Edit changes the guide in place; Cancel keeps it; emptied, the page says again what belongs there", async () => {
	const root = await startApp({ version: DATA_VERSION, ...library, guide: "Alt." }, "#guide");
	byText(view(root), "button", text.editGuide).click();
	const area = () => view(root).querySelector<HTMLTextAreaElement>("#guide-form textarea")!;
	assert.equal(area().value, "Alt.");
	typeInto(area(), "Verworfen.");
	byText(view(root), "button", sharedText.cancel).click();
	assert.equal(view(root).querySelector(".guide-text")?.textContent, "Alt.");
	assert.equal((await readSaved()).guide, "Alt.");

	byText(view(root), "button", text.editGuide).click();
	assert.equal(area().value, "Alt.", "a cancelled draft is gone");
	typeInto(area(), "Neu.");
	byText(view(root), "button", sharedText.save).click();
	assert.equal(view(root).querySelector(".guide-text")?.textContent, "Neu.");
	assert.equal((await readSaved()).guide, "Neu.");

	// Emptied, the page is back to saying what belongs here.
	byText(view(root), "button", text.editGuide).click();
	typeInto(area(), "");
	byText(view(root), "button", sharedText.save).click();
	assert.ok(view(root).querySelector(".empty-state"));
	await settle();
	goTo("#types");
	assert.equal(root.querySelector(".guide-view"), null);
});
