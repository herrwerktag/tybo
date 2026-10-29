import { byText, readSaved, settle, startApp } from "../../test-app.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION, ulid } from "../../shared/core/index.js";
import { text as dataText } from "../data/texts.js";
import { text } from "./texts.js";

test("Analyses: an analysis set up step by step lists the rows grouped, is saved, and shows the card and details of the entities it names", async () => {
	const reference = (id: string, name: string, typeId: string, inverseLabel = "") => ({
		id,
		name,
		kind: "reference",
		options: [],
		reference: { typeIds: [typeId], multiple: false, required: false, arrow: "to", lineLabel: "", inverseLabel },
		cardDisplay: "list",
	});
	// Entity ids are ULIDs (others are replaced on loading, losing the references to them).
	const ids = { Build: ulid(), Sort: ulid(), Developer: ulid(), Delivery: ulid() };
	const entity = (name: keyof typeof ids, typeId: string, values: Record<string, string> = {}) => ({
		id: ids[name],
		typeId,
		name,
		content: "",
		description: "",
		tags: [],
		values,
	});
	const root = await startApp(
		{
			version: DATA_VERSION,
			types: [
				{ id: "activity", name: "Activity", color: "#c4dafa", contentTemplate: "", properties: [reference("role", "Responsible", "role"), reference("process", "Process", "process", "includes")] },
				{ id: "role", name: "Role", color: "#f9c9c9", contentTemplate: "", properties: [] },
				{ id: "process", name: "Process", color: "#c8ebbf", contentTemplate: "", properties: [] },
			],
			entities: [
				entity("Build", "activity", { role: ids.Developer, process: ids.Delivery }),
				entity("Sort", "activity", { process: ids.Delivery }),
				entity("Developer", "role"),
				entity("Delivery", "process"),
			],
			boards: [],
		},
		"#analysis",
	);
	assert.equal(root.querySelector(".tab.current")?.textContent, text.tabAnalysis);
	assert.ok(byText(root, "p", text.analysisEmpty));

	byText<HTMLButtonElement>(root, "button", text.newAnalysis).click();
	const choose = (select: HTMLSelectElement, label: string) => {
		select.value = [...select.options].find((o) => o.textContent === label)!.value;
		select.dispatchEvent(new Event("change"));
	};
	choose(root.querySelector<HTMLSelectElement>(".analysis-meta select")!, "Activity");
	byText<HTMLButtonElement>(root, "button", `+ ${text.addGroupLevel}`).click();
	choose(root.querySelector<HTMLSelectElement>(".path-list .path-editor select")!, "Responsible → Role");
	byText<HTMLButtonElement>(root, "button", `+ ${text.addColumn}`).click();
	choose(root.querySelectorAll<HTMLSelectElement>(".path-list")[1]!.querySelector("select")!, "Process → Process");

	const headings = [...root.querySelectorAll(".analysis-result h3")].map((h) => h.textContent);
	assert.deepEqual(headings, [`Developer${text.analysisCount(1)}`, `${text.analysisNoValue("Responsible")}${text.analysisCount(1)}`]);
	const rows = [...root.querySelectorAll(".analysis-result tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
	assert.deepEqual(rows, [["Build", "Delivery"], ["Sort", "Delivery"]]);
	assert.ok(byText(root, ".analysis-result .section-header button", text.exportAnalysisMarkdown), "the result can be exported");

	const saved = await readSaved();
	assert.deepEqual(saved.analyses.map(({ name, typeId, groups, columns }) => ({ name, typeId, groups, columns })), [
		{
			name: text.defaultAnalysisName(1),
			typeId: "activity",
			groups: [[{ propertyId: "role", direction: "forward" }]],
			columns: [[{ propertyId: "process", direction: "forward" }]],
		},
	]);

	// Hovering (or focusing) an entity shows its card; clicking it, its details beside, where Edit shows its form.
	const delivery = byText<HTMLButtonElement>(root, ".analysis-result button", "Delivery");
	delivery.dispatchEvent(new Event("focus"));
	const preview = root.querySelector<HTMLElement>(".card-preview")!;
	assert.equal(preview.hidden, false);
	assert.equal(preview.querySelector(".card-title")?.textContent, "Delivery");
	delivery.click();
	const details = root.querySelector<HTMLElement>(".analysis-view .details-panel")!;
	assert.equal(details.hidden, false);
	assert.equal(details.querySelector(".details-title")?.textContent, "Delivery");
	assert.equal(root.querySelectorAll(".entity-link.selected").length, 2, "both of its links in the result are marked");
	// Its details name the activities the process includes (the other side of the references): clicking one shows that.
	byText<HTMLButtonElement>(details, ".ref-tag", "Build").click();
	assert.equal(details.querySelector(".details-title")?.textContent, "Build");
	byText<HTMLButtonElement>(details, "button", dataText.edit).click();
	const form = details.querySelector<HTMLFormElement>("#entity-form")!;
	assert.equal(details.querySelector(".card-type")?.textContent, "Activity", "below the bar of its type");
	form.querySelector<HTMLInputElement>("input")!.value = "Build it";
	form.requestSubmit();
	await settle();
	assert.equal(location.hash, "#analysis", "it stays in the analysis");
	assert.equal(details.querySelector(".details-title")?.textContent, "Build it");
	assert.ok(byText(root, ".analysis-result button", "Build it"), "the result names it anew");
});
