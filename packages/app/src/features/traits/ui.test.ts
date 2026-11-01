import { byText, goTo, readSaved, settle, startApp, stub } from "../../test-app.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION } from "../../shared/core/index.js";
import { sharedText } from "../../shared/ui/index.js";
import { text as dataText } from "../data/texts.js";
import { text } from "./texts.js";

const status = (id: string, labels: string[]) => ({
	id,
	name: "Status",
	kind: "options",
	options: labels.map((label) => ({ id: `${id}-${label}`, label })),
	reference: null,
	cardDisplay: "list",
});

test("Traits: they are kept in the Data tab beside the entity types, the one the address names in its form, the first without", async () => {
	const trait = (id: string, name: string) => ({ id, name, roles: [], bindings: {} });
	const root = await startApp({ version: DATA_VERSION, types: [], entities: [], boards: [], traits: [trait("progress", "Fortschritt"), trait("blockade", "Blockade")] }, "#types");
	const tabs = [...root.querySelectorAll<HTMLAnchorElement>(".data-switch a")].map((a) => [a.textContent, a.getAttribute("href")]);
	assert.deepEqual(tabs, [[dataText.entityTypes, "#types"], [dataText.entities, "#entities"], [text.traits, "#traits"]]);
	goTo("#traits");
	const name = () => root.querySelector<HTMLInputElement>(".trait-form input")!.value;
	assert.equal(name(), "Fortschritt");
	assert.equal(root.querySelector(".data-switch .current")?.textContent, text.traits);
	assert.deepEqual([...root.querySelectorAll(".trait-entry")].map((a) => [a.textContent, a.ariaCurrent]), [["Fortschritt", "page"], ["Blockade", "false"]]);
	goTo("#traits/blockade");
	assert.equal(name(), "Blockade");
});

test("Traits: the list reads like the types': each entry shows its bearing types and roles in short, and deletes it where it stands", async () => {
	const type = (id: string, name: string) => ({ id, name, color: "#c4dafa", contentTemplate: "", properties: [] });
	const progress = {
		id: "progress",
		name: "Fortschritt",
		roles: [
			{ id: "stand", name: "Stand", kind: "options", options: [{ id: "open", label: "offen" }, { id: "done", label: "fertig" }] },
			{ id: "note", name: "Notiz", kind: "text", options: [] },
		],
		bindings: { task: {} },
	};
	const empty = { id: "blockade", name: "Blockade", roles: [], bindings: {} };
	const root = await startApp(
		{
			version: DATA_VERSION,
			types: [type("task", "Aufgabe")],
			entities: [],
			boards: [],
			traits: [progress, empty],
		},
		"#traits",
	);
	// Each entry as a type's: the name, how many types bear it, the roles in short below, the chosen one marked.
	assert.equal(root.querySelector(".trait-item")!.className, "trait-item current");
	assert.deepEqual(
		[...root.querySelectorAll(".trait-item-count")].map((s) => s.textContent),
		[`1 ${dataText.historyTypes(1)}`, `0 ${dataText.historyTypes(0)}`],
	);
	assert.deepEqual(
		[...root.querySelectorAll(".trait-item-summary li, p.trait-item-summary")].map((n) => n.textContent),
		[`Stand: offen / fertig`, `Notiz: ${dataText.kinds.text}`, text.noRoles],
	);
	// The delete of the trait the form is about now stands on its entry, as a type's does: refused, nothing changes.
	stub({ confirm: () => false });
	(root.querySelector<HTMLButtonElement>(".trait-item .actions button")!).click();
	await settle();
	assert.deepEqual((await readSaved()).traits.map((t) => t.name), ["Fortschritt", "Blockade"]);
	stub({ confirm: () => true });
	(root.querySelector<HTMLButtonElement>(".trait-item .actions button")!).click();
	await settle();
	assert.deepEqual((await readSaved()).traits.map((t) => t.name), ["Blockade"]);
	// Without the one the address named, the form shows the first still there.
	assert.equal(root.querySelector<HTMLInputElement>(".trait-form input")!.value, "Blockade");
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
		"#traits/blockade",
	);
	const form = () => root.querySelector<HTMLElement>(".trait-form")!;
	const condition = () => [...form().querySelectorAll("select")].find((s) => s.ariaLabel === text.condition)!;
	const choose = (select: HTMLSelectElement, label: string) => {
		select.value = [...select.options].find((o) => o.textContent === label)!.value;
		select.dispatchEvent(new Event("change"));
	};
	assert.equal(condition().selectedOptions[0]!.textContent, text.noCondition);

	choose(condition(), "Fortschritt › Stand");
	const boxes = () => [...form().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
	assert.deepEqual(boxes().map((b) => [b.checked, b.disabled]), [[true, true], [false, false]], "the first value to start with; the last one stays");
	boxes()[1]!.checked = true;
	boxes()[1]!.dispatchEvent(new Event("change"));
	await settle();
	assert.deepEqual((await readSaved()).traits[1]!.roles[0]!.condition, { traitId: "progress", roleId: "stand", values: ["open", "done"] });

	choose(condition(), "Blockade › blockiert durch");
	assert.equal(condition().validationMessage, text.conditionCycle("Blockade.blockiert durch › Blockade.blockiert durch"));
	await settle();
	assert.deepEqual((await readSaved()).traits[1]!.roles[0]!.condition, { traitId: "progress", roleId: "stand", values: ["open", "done"] }, "nothing saved");

	// The pitch's questions all bear Progress; once Frage no longer does, the form says such targets never count.
	goTo("#traits/progress");
	byText<HTMLButtonElement>(byText<HTMLElement>(form(), ".trait-bearer h4", "Frage").closest<HTMLElement>(".trait-bearer")!, "button", text.removeType).click();
	goTo("#traits/blockade");
	assert.ok(byText(form(), "p", text.conditionHint("Frage", "Fortschritt")));
});

test("Traits: the roles, and an options role's values, keep their order by the handle's arrow keys, as a type's properties do", async () => {
	const progress = {
		id: "progress",
		name: "Fortschritt",
		roles: [
			{ id: "stand", name: "Stand", kind: "options", options: [{ id: "open", label: "offen" }, { id: "done", label: "fertig" }] },
			{ id: "note", name: "Notiz", kind: "text", options: [] },
		],
		bindings: {},
	};
	const root = await startApp({ version: DATA_VERSION, types: [], entities: [], boards: [], traits: [progress] }, "#traits/progress");
	const form = () => root.querySelector<HTMLElement>(".trait-form")!;
	const handle = (key: string) => form().querySelector<HTMLElement>(`.drag-handle[data-focus-key="${key}"]`)!;
	const press = (element: HTMLElement, key: string) => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

	press(handle("role:note"), "ArrowUp");
	await settle();
	assert.deepEqual((await readSaved()).traits[0]!.roles.map((r) => r.name), ["Notiz", "Stand"]);
	press(handle("role:stand:value:done"), "ArrowUp");
	await settle();
	const [notiz, stand] = (await readSaved()).traits[0]!.roles;
	assert.equal(notiz!.name, "Notiz");
	assert.deepEqual(stand!.options.map((o) => o.label), ["fertig", "offen"]);
});

test("Traits: a type's form shows the traits it bears as links to them", async () => {
	const type = (id: string, name: string) => ({ id, name, color: "#c4dafa", contentTemplate: "", properties: [] });
	const root = await startApp(
		{
			version: DATA_VERSION,
			types: [type("task", "Aufgabe"), type("note", "Notiz")],
			entities: [],
			boards: [],
			traits: [
				{ id: "progress", name: "Fortschritt", roles: [], bindings: { task: {} } },
				{ id: "blockade", name: "Blockade", roles: [], bindings: { task: {} } },
			],
		},
		"#types",
	);
	const edit = (name: string) => byText(byText(root, ".type-name", name).closest(".type-item")!, "button", dataText.edit).click();
	const chips = () => [...root.querySelectorAll<HTMLAnchorElement>("#type-form .type-traits a")].map((a) => [a.textContent, a.getAttribute("href")]);
	edit("Aufgabe");
	assert.deepEqual(chips(), [["Fortschritt", "#traits/progress"], ["Blockade", "#traits/blockade"]]);
	byText(root, "button", sharedText.cancel).click();
	edit("Notiz");
	assert.deepEqual(chips(), []);
});
