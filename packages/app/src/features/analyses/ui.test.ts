import { byText, readSaved, settle, startApp } from "../../test-app.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION, ulid } from "../../shared/core/index.js";
import { text as dataText } from "../data/texts.js";
import { text as traitText } from "../traits/texts.js";
import { text } from "./texts.js";

test("Analyses: a name another analysis has is refused at the name field; a new one gets the first number free", async () => {
	const root = await startApp({ version: DATA_VERSION, types: [], entities: [], boards: [] }, "#analysis");
	byText<HTMLButtonElement>(root, "button", text.newAnalysis).click();
	byText<HTMLButtonElement>(root, "button", text.newAnalysis).click();
	const name = root.querySelector<HTMLInputElement>(".analysis-setup input")!;
	assert.equal(name.value, text.defaultAnalysisName(2));
	name.value = text.defaultAnalysisName(1).toUpperCase();
	name.dispatchEvent(new Event("change"));
	assert.equal(name.validationMessage, text.analysisNameTaken(name.value));
	await settle();
	assert.deepEqual((await readSaved()).analyses.map((a) => a.name), [text.defaultAnalysisName(1), text.defaultAnalysisName(2)]);
});

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
	const delivery = byText<HTMLElement>(root, ".analysis-result .entity-link", "Delivery");
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
	assert.ok(byText(root, ".analysis-result .entity-link", "Build it"), "the result names it anew");
});

const status = (id: string, labels: string[]) => ({
	id,
	name: "Status",
	kind: "options",
	options: labels.map((label) => ({ id: `${id}-${label}`, label })),
	reference: null,
	cardDisplay: "list",
});

test("Traits: a trait made in its form, bound to two types' statuses, gives an analysis across both types", async () => {
	// Entity ids are ULIDs (others are replaced on loading).
	const entity = (name: string, typeId: string, value: string) => ({ id: ulid(), typeId, name, content: "", description: "", tags: [], values: { [`${typeId}-status`]: `${typeId}-status-${value}` } });
	const root = await startApp(
		{
			version: DATA_VERSION,
			types: [
				{ id: "pitch", name: "Pitch", color: "#fbd9b0", contentTemplate: "", properties: [status("pitch-status", ["Entwurf", "abgeschlossen"])] },
				{ id: "question", name: "Frage", color: "#d6ccf7", contentTemplate: "", properties: [status("question-status", ["offen", "beantwortet"])] },
			],
			entities: [entity("Traits", "pitch", "Entwurf"), entity("Verlauf", "pitch", "abgeschlossen"), entity("Wie heißen sie?", "question", "offen")],
			boards: [],
		},
		"#analysis",
	);
	const choose = (select: HTMLSelectElement, label: string) => {
		select.value = [...select.options].find((o) => o.textContent === label)!.value;
		select.dispatchEvent(new Event("change"));
	};
	const form = () => root.querySelector<HTMLElement>(".trait-form")!;
	/** The controls of that accessible name in `within`, and the first of them. */
	const allLabeled = <T extends HTMLElement>(within: ParentNode, label: string) => [...within.querySelectorAll<T>("input, select")].filter((e) => e.ariaLabel === label);
	const labeled = <T extends HTMLElement>(within: ParentNode, label: string) => allLabeled<T>(within, label)[0]!;
	const type = (input: HTMLInputElement, value: string) => {
		input.value = value;
		input.dispatchEvent(new Event("change"));
	};

	byText<HTMLButtonElement>(root, "button", traitText.newTrait).click();
	type(form().querySelector("input")!, "Fortschritt");
	byText<HTMLButtonElement>(form(), "button", `+ ${traitText.addRole}`).click();
	type(form().querySelector<HTMLInputElement>(".path-list input")!, "Stand");
	choose(labeled<HTMLSelectElement>(form(), traitText.roleKind), dataText.kinds.options);
	type(labeled<HTMLInputElement>(form(), traitText.roleValues), "offen");
	byText<HTMLButtonElement>(form(), "button", `+ ${traitText.addValue}`).click();
	const values = allLabeled<HTMLInputElement>(form(), traitText.roleValues);
	type(values[1]!, "OFFEN");
	assert.equal(values[1]!.validationMessage, traitText.duplicateValue("Stand"), "a value twice is refused at its field");
	type(values[1]!, "fertig");

	for (const [typeName, own] of [["Pitch", ["Entwurf", "abgeschlossen"]], ["Frage", ["offen", "beantwortet"]]] as const) {
		choose(labeled<HTMLSelectElement>(form(), traitText.addType), typeName);
		// Every change draws the form anew.
		const section = () => byText<HTMLElement>(form(), "legend", typeName).parentElement!;
		choose(labeled<HTMLSelectElement>(section(), "Stand"), "Status");
		choose(labeled<HTMLSelectElement>(section(), traitText.standsFor(own[0])), "offen");
		choose(labeled<HTMLSelectElement>(section(), traitText.standsFor(own[1])), "fertig");
	}

	byText<HTMLButtonElement>(root, "button", text.newAnalysis).click();
	choose(root.querySelector<HTMLSelectElement>(".analysis-meta select")!, "Fortschritt");
	byText<HTMLButtonElement>(root, "button", `+ ${text.addGroupLevel}`).click();
	choose(root.querySelector<HTMLSelectElement>(".path-list .path-editor select")!, "Stand");
	const headings = [...root.querySelectorAll(".analysis-result h3")].map((h) => h.textContent);
	assert.deepEqual(headings, [`offen${text.analysisCount(2)}`, `fertig${text.analysisCount(1)}`]);
	const rows = [...root.querySelectorAll(".analysis-result tbody tr")].map((tr) => tr.textContent);
	assert.deepEqual(rows, ["Traits", "Wie heißen sie?", "Verlauf"]);

	await settle();
	const saved = await readSaved();
	assert.deepEqual(saved.types.map((t) => t.properties.length), [1, 1], "no type changed");
	const [trait] = saved.traits;
	assert.equal(trait!.name, "Fortschritt");
	assert.deepEqual(trait!.roles.map((r) => [r.name, r.kind, r.options.map((o) => o.label)]), [["Stand", "options", ["offen", "fertig"]]]);
	const [open, done] = trait!.roles[0]!.options.map((o) => o.id);
	assert.deepEqual(trait!.bindings, {
		pitch: { [trait!.roles[0]!.id]: { propertyId: "pitch-status", direction: "forward", values: { "pitch-status-Entwurf": open, "pitch-status-abgeschlossen": done } } },
		question: { [trait!.roles[0]!.id]: { propertyId: "question-status", direction: "forward", values: { "question-status-offen": open, "question-status-beantwortet": done } } },
	});
	assert.deepEqual(saved.analyses.map(({ typeId, traitId }) => [typeId, traitId]), [[null, trait!.id]]);
});

test("Traits: a reference role's condition is set in the form, refused when it would lead round in a circle, and pointed out where targets never meet it", async () => {
	const progress = {
		id: "progress",
		name: "Fortschritt",
		roles: [{ id: "stand", name: "Stand", kind: "options", options: [{ id: "open", label: "offen" }, { id: "done", label: "fertig" }] }],
		bindings: { question: { stand: { propertyId: "question-status", direction: "forward", values: { "question-status-offen": "open", "question-status-beantwortet": "done" } } } },
	};
	const blockade = {
		id: "blockade",
		name: "Blockade",
		roles: [{ id: "blocked", name: "blockiert durch", kind: "reference", options: [] }],
		bindings: { pitch: { blocked: { propertyId: "question-pitch", direction: "inverse", values: {} } } },
	};
	const root = await startApp(
		{
			version: DATA_VERSION,
			types: [
				{ id: "pitch", name: "Pitch", color: "#fbd9b0", contentTemplate: "", properties: [] },
				{
					id: "question",
					name: "Frage",
					color: "#d6ccf7",
					contentTemplate: "",
					properties: [
						status("question-status", ["offen", "beantwortet"]),
						{ id: "question-pitch", name: "Pitch", kind: "reference", options: [], reference: { typeIds: ["pitch"], multiple: false, required: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
					],
				},
			],
			entities: [],
			boards: [],
			traits: [progress, blockade],
		},
		"#analysis",
	);
	byText<HTMLButtonElement>(root, ".analysis-entry", "Blockade").click();
	const form = () => root.querySelector<HTMLElement>(".trait-form")!;
	const condition = () => [...form().querySelectorAll("select")].find((s) => s.ariaLabel === traitText.condition)!;
	const choose = (select: HTMLSelectElement, label: string) => {
		select.value = [...select.options].find((o) => o.textContent === label)!.value;
		select.dispatchEvent(new Event("change"));
	};
	assert.equal(condition().selectedOptions[0]!.textContent, traitText.noCondition);

	choose(condition(), "Fortschritt › Stand");
	const boxes = () => [...form().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
	assert.deepEqual(boxes().map((b) => [b.checked, b.disabled]), [[true, true], [false, false]], "the first value to start with; the last one stays");
	boxes()[1]!.checked = true;
	boxes()[1]!.dispatchEvent(new Event("change"));
	await settle();
	assert.deepEqual((await readSaved()).traits[1]!.roles[0]!.condition, { traitId: "progress", roleId: "stand", values: ["open", "done"] });

	choose(condition(), "Blockade › blockiert durch");
	assert.equal(condition().validationMessage, traitText.conditionCycle("Blockade.blockiert durch › Blockade.blockiert durch"));
	await settle();
	assert.deepEqual((await readSaved()).traits[1]!.roles[0]!.condition, { traitId: "progress", roleId: "stand", values: ["open", "done"] }, "nothing saved");

	// The pitch's questions all bear Progress; once Frage no longer does, the form says such targets never count.
	byText<HTMLButtonElement>(root, ".analysis-entry", "Fortschritt").click();
	byText<HTMLButtonElement>(byText<HTMLElement>(form(), "legend", "Frage").parentElement!, "button", traitText.removeType).click();
	byText<HTMLButtonElement>(root, ".analysis-entry", "Blockade").click();
	assert.ok(byText(form(), "p", traitText.conditionHint("Frage", "Fortschritt")));
});

test("Analyses: a new analysis starts with its setup unfolded; Done folds it to a line telling it in short, Set up unfolds it again", async () => {
	const root = await startApp({ version: DATA_VERSION, types: [], entities: [], boards: [] }, "#analysis");
	byText<HTMLButtonElement>(root, "button", text.newAnalysis).click();
	const body = () => root.querySelector<HTMLElement>(".analysis-setup-body")!;
	assert.equal(body().hidden, false);
	assert.equal(root.querySelector(".analysis-summary"), null);

	byText<HTMLButtonElement>(root, ".analysis-setup-head button", text.hideSetup).click();
	assert.equal(body().hidden, true);
	assert.match(root.querySelector(".analysis-summary")?.textContent ?? "", new RegExp(text.analysisRowType));

	byText<HTMLButtonElement>(root, ".analysis-setup-head button", text.showSetup).click();
	assert.equal(body().hidden, false);
});
