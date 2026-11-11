import { byText, choose, goTo, library, readSaved, rowNames, settle, startApp, storage, stub, tagSelectIn, tagged, typeInto } from "../../test-app.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION } from "../../shared/core/index.js";
import { sharedText } from "../../shared/ui/index.js";
import { text as dataText } from "./texts.js";

test("a type with a property, then an entity of it, can be created through the forms and are saved", async () => {
	const root = await startApp(undefined, "#types");
	byText(root, "button", dataText.createNewType).click();
	const typeForm = root.querySelector<HTMLFormElement>("#type-form")!;
	typeInto(typeForm.querySelector(`input[placeholder="${dataText.typeNamePlaceholder}"]`)!, "Book");
	byText(typeForm, "button", `+ ${dataText.addProperty}`).click();
	// The form was drawn again with the new property; the typed name is kept.
	const form = root.querySelector<HTMLFormElement>("#type-form")!;
	typeInto(form.querySelector(`input[placeholder="${dataText.propertyName}"]`)!, "author");
	byText(form, "button", dataText.createType).click();

	assert.ok(byText(root, ".type-name", "Book"));
	const [book] = (await readSaved()).types;
	assert.equal(book?.name, "Book");
	assert.deepEqual(book?.properties.map((p) => p.name), ["author"]);
	assert.equal(root.querySelector("#type-form"), null); // created: the form closes

	goTo("#entities");
	byText(root, "button", dataText.createNewEntity).click();
	const entityForm = root.querySelector<HTMLFormElement>("#entity-form")!;
	const [nameInput, authorInput, tagsInput] = entityForm.querySelectorAll<HTMLInputElement>("label.field input");
	nameInput!.value = " Dune ";
	authorInput!.value = "Herbert";
	tagsInput!.value = "Classic, sci-fi, classic,";
	byText(entityForm, "button", sharedText.create).click();

	assert.ok(byText(root, "td", "Dune"));
	assert.ok(byText(root, "td", "Herbert"));
	assert.ok(byText(root, "td .chip", "Classic"));
	assert.ok(byText(root, "td .chip", "sci-fi"));
	const [dune] = (await readSaved()).entities;
	assert.equal(dune?.name, "Dune");
	assert.equal(dune?.values[book!.properties[0]!.id], "Herbert");
	assert.deepEqual(dune?.tags, ["Classic", "sci-fi"]);
	assert.equal(root.querySelector("#entity-form"), null);
});

test("types and entities are reordered with their drag handles' arrow keys; focus stays on the moved one", async () => {
	const root = await startApp({
		...library,
		types: [...library.types, { id: "film", name: "Film", color: "#c8ebbf", contentTemplate: "", description: "", guide: "", properties: [] }],
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
	byText(root, ".type-chip span", "Book").closest("button")!.click();
	press(root.querySelector<HTMLElement>("tbody .drag-handle")!, "ArrowDown");
	assert.deepEqual(rowNames(root), ["Emma", "Dune"]);
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

test("the type form refuses the name of another type, saying so", async () => {
	const root = await startApp(library, "#types");
	byText(root, "button", dataText.createNewType).click();
	const form = root.querySelector<HTMLFormElement>("#type-form")!;
	typeInto(form.querySelector(`input[placeholder="${dataText.typeNamePlaceholder}"]`)!, " book ");
	byText(form, "button", dataText.createType).click();
	assert.ok(byText(root, "#type-form p.error", dataText.validation({ code: "typeNameTaken", label: "book" })));
	assert.deepEqual((await readSaved()).types.map((t) => t.name), ["Book"]);
});

test("the forms for a new type and a new entity are hidden until asked for, and Cancel hides them again", async () => {
	const root = await startApp(library, "#types");
	assert.equal(root.querySelector("#type-form"), null);
	byText(root, "button", dataText.createNewType).click();
	byText(root.querySelector("#type-form")!, "button", sharedText.cancel).click();
	assert.equal(root.querySelector("#type-form"), null);

	goTo("#entities");
	assert.equal(root.querySelector("#entity-form"), null);
	byText(root, "button", dataText.createNewEntity).click();
	byText(root.querySelector("#entity-form")!, "button", sharedText.cancel).click();
	assert.equal(root.querySelector("#entity-form"), null);

	// An entity there is isn't edited in a form: its name shows its details beside the table.
	byText(root, ".name-link", "Dune").click();
	assert.equal(root.querySelector("#entity-form"), null);
	assert.equal(root.querySelector(".entities-view .details-title")?.textContent, "Dune");
});

test("a reference allowing several values shows them as tags: × removes one, the select adds another", async () => {
	const members = { id: "members", name: "members", kind: "reference", options: [], reference: { typeIds: ["person"], multiple: true }, cardDisplay: "list", description: "" };
	const root = await startApp({
		types: [
			{ id: "team", name: "Team", color: "#c8ebbf", contentTemplate: "", description: "", guide: "", properties: [members] },
			{ id: "person", name: "Person", color: "#c4dafa", contentTemplate: "", description: "", guide: "", properties: [] },
		],
		entities: [
			{ id: "01J00000000000000000000000", typeId: "team", name: "Core", content: "", description: "", values: { members: ["01J00000000000000000000001"] } },
			{ id: "01J00000000000000000000001", typeId: "person", name: "Ada", content: "", description: "", values: {} },
			{ id: "01J00000000000000000000002", typeId: "person", name: "Bob", content: "", description: "", values: {} },
		],
		boards: [],
	});
	// In the table, its pencil opens the field; each tag added or taken out is saved, and the field stays open.
	const cell = () => byText(root, "td", "Core").closest("tr")!.querySelectorAll("td")[2]!;
	cell().querySelector<HTMLButtonElement>(".field-edit")!.click();
	const tags = () => [...cell().querySelectorAll(".reference-type")].map((t) => t.firstChild?.textContent);
	assert.deepEqual(tags(), ["Ada"]);

	const add = cell().querySelector<HTMLSelectElement>(".reference-values select")!;
	add.value = "01J00000000000000000000002";
	add.dispatchEvent(new Event("change"));
	assert.deepEqual(tags(), ["Ada", "Bob"]);
	assert.equal(cell().querySelector(".reference-values select"), null); // nobody left to add
	byText(cell(), "button", "×").click();
	assert.deepEqual(tags(), ["Bob"]);
	await settle();
	assert.deepEqual((await readSaved()).entities[0]?.values.members, ["01J00000000000000000000002"]);

	cell().querySelector("form")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal(cell().querySelector("form"), null);
	assert.deepEqual([...cell().querySelectorAll(".ref-tag")].map((t) => t.textContent), ["Bob"]);
});

test("an invalid type shows its problems and isn't saved", async () => {
	const root = await startApp(undefined, "#types");
	byText(root, "button", dataText.createNewType).click();
	byText(root.querySelector("#type-form")!, "button", dataText.createType).click();
	assert.equal(root.querySelector("#type-form .error")?.textContent, dataText.validation({ code: "typeNameRequired" }));
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
	const deleteDune = () => byText(byText(root, "td", "Dune").closest("tr")!, "button", sharedText.delete).click();

	deleteDune();
	assert.deepEqual(questions, [dataText.confirmDeleteEntity("Dune", 0)]);
	assert.equal((await readSaved()).entities.length, 1);

	answer = true;
	deleteDune();
	assert.equal((await readSaved()).entities.length, 0);
	assert.ok(byText(root, "p", dataText.noEntitiesOfType("Book")));
});

test("an entity converts from its details, with like-named fields assigned and the target type shown", async () => {
	const root = await startApp({
		version: DATA_VERSION,
		types: [
			{
				id: "idea", name: "Idea", color: "#c4dafa", contentTemplate: "", description: "", guide: "",
				properties: [
					{ id: "title", name: "title", kind: "text", options: [], reference: null, cardDisplay: "list", description: "" },
					{ id: "status", name: "status", kind: "options", options: [{ id: "old-open", label: "open" }], reference: null, cardDisplay: "list", description: "" },
				],
			},
			{
				id: "project", name: "Project", color: "#c8ebbf", contentTemplate: "", description: "", guide: "",
				properties: [
					{ id: "title", name: "title", kind: "text", options: [], reference: null, cardDisplay: "list", description: "" },
					{ id: "phase", name: "phase", kind: "options", options: [{ id: "new-open", label: "open" }, { id: "done", label: "done" }], reference: null, cardDisplay: "list", description: "" },
				],
			},
		],
		entities: [{ id: "01J00000000000000000000000", typeId: "idea", name: "Conversion", content: "short", description: "details", tags: ["keep"], values: { title: "Ship it", status: "old-open" } }],
		boards: [],
	}, "#entities");
	stub({ confirm: () => assert.fail("a lossless conversion does not ask again") });
	byText(root, ".name-link", "Conversion").click();
	byText(root, ".details-actions button", dataText.convertEntity).click();
	const dialog = root.querySelector<HTMLDialogElement>(".conversion-dialog")!;
	assert.ok(dialog.open);
	choose(dialog.querySelector<HTMLSelectElement>(".conversion-target-type")!, "project");
	assert.equal(dialog.querySelector<HTMLSelectElement>(`.conversion-property-target[data-source-property="title"]`)!.value, "title");
	choose(dialog.querySelector<HTMLSelectElement>(`.conversion-property-target[data-source-property="status"]`)!, "phase");
	assert.equal(dialog.querySelector<HTMLSelectElement>(`.conversion-option-target[data-source-property="status"]`)!.value, "new-open", "the like-labelled option is preselected");
	dialog.querySelector<HTMLFormElement>(".conversion-form")!.requestSubmit();

	const saved = await readSaved();
	assert.equal(saved.entities[0]?.typeId, "project");
	assert.deepEqual(saved.entities[0]?.values, { title: "Ship it", phase: "new-open" });
	assert.deepEqual(
		{ content: saved.entities[0]?.content, description: saved.entities[0]?.description, tags: saved.entities[0]?.tags },
		{ content: "short", description: "details", tags: ["keep"] },
	);
	assert.equal(dialog.open, false);
	assert.ok(byText(root, ".type-chip", "Project1"));
	assert.equal(root.querySelector(".details-title")?.textContent, "Conversion");
});

test("conversion lists every loss and cancelling its confirmation changes nothing", async () => {
	const reference = { typeIds: ["idea"], multiple: false, required: false, arrow: "to", lineLabel: "", inverseLabel: "" };
	const root = await startApp({
		version: DATA_VERSION,
		types: [
			{ id: "idea", name: "Idea", color: "#c4dafa", contentTemplate: "", description: "", guide: "", properties: [{ id: "note", name: "note", kind: "text", options: [], reference: null, cardDisplay: "list", description: "" }] },
			{ id: "empty", name: "Empty", color: "#c8ebbf", contentTemplate: "", description: "", guide: "", properties: [] },
			{ id: "review", name: "Review", color: "#f6e8a6", contentTemplate: "", description: "", guide: "", properties: [{ id: "subject", name: "subject", kind: "reference", options: [], reference, cardDisplay: "list", description: "" }] },
		],
		entities: [
			{ id: "01J00000000000000000000000", typeId: "idea", name: "Conversion", content: "", description: "", tags: [], values: { note: "Keep me?" } },
			{ id: "01J00000000000000000000001", typeId: "review", name: "Review", content: "", description: "", tags: [], values: { subject: "01J00000000000000000000000" } },
		],
		boards: [],
	}, "#entities");
	let answer = false;
	const questions: string[] = [];
	stub({ confirm: (message: string) => (questions.push(message), answer) });
	byText(root, ".name-link", "Conversion").click();
	byText(root, ".details-actions button", dataText.convertEntity).click();
	const dialog = root.querySelector<HTMLDialogElement>(".conversion-dialog")!;
	choose(dialog.querySelector<HTMLSelectElement>(".conversion-target-type")!, "empty");
	assert.match(dialog.querySelector(".conversion-lost-values")!.textContent!, /note: Keep me\?/);
	assert.match(dialog.querySelector(".conversion-lost-references")!.textContent!, /Review → subject/);

	dialog.querySelector<HTMLFormElement>(".conversion-form")!.requestSubmit();
	assert.deepEqual(questions, [dataText.confirmConversion(1, 1)]);
	assert.ok(dialog.open, "cancelling keeps the mapping open");
	assert.equal((await readSaved()).entities[0]?.typeId, "idea");
	assert.equal((await readSaved()).entities[1]?.values.subject, "01J00000000000000000000000");

	answer = true;
	dialog.querySelector<HTMLFormElement>(".conversion-form")!.requestSubmit();
	const saved = await readSaved();
	assert.equal(saved.entities[0]?.typeId, "empty");
	assert.deepEqual(saved.entities[0]?.values, {});
	assert.equal(saved.entities[1]?.values.subject, null);
	assert.equal(dialog.open, false);
});

test("a type other types refer to can't be deleted", async () => {
	const data = structuredClone(library) as { types: unknown[]; boards: unknown[] };
	data.types.push({ id: "review", name: "Review", properties: [{ id: "of", name: "of", kind: "reference", options: [], reference: { typeId: "book", multiple: false }, cardDisplay: "list", description: "" }] });
	const root = await startApp(data, "#types");
	const alerts: string[] = [];
	stub({ alert: (message: string) => void alerts.push(message), confirm: () => assert.fail("shouldn't ask to confirm") });

	const bookItem = root.querySelector(".type-item")!;
	byText(bookItem, "button", sharedText.delete).click();
	assert.deepEqual(alerts, [dataText.cannotDeleteType("Book", "Review.of")]);
	assert.equal((await readSaved()).types.length, 2);
});

test("the Entities page shows the types as chips with their counts; a value clicked is changed in its cell, saved on Enter", async () => {
	const root = await startApp(library, "#entities");
	assert.deepEqual([...root.querySelectorAll(".type-chip")].map((c) => c.textContent), ["Book1"]);
	assert.equal(root.querySelector<HTMLElement>(".type-chip")?.ariaPressed, "true");
	assert.equal([...root.querySelectorAll("th")].some((th) => th.textContent === dataText.id), false, "no ID column: the details have it");

	byText<HTMLElement>(root, "tbody .editable", "Herbert").click();
	assert.equal(root.querySelector("#entity-form"), null, "no form for the whole entity");
	const input = root.querySelector<HTMLInputElement>("tbody form input")!;
	assert.equal(input.value, "Herbert");
	input.value = "Frank Herbert";
	input.form!.requestSubmit();
	assert.equal(root.querySelector("tbody form"), null);
	assert.ok(byText(root, "tbody .editable", "Frank Herbert"));
	await settle();
	assert.equal((await readSaved()).entities[0]!.values.author, "Frank Herbert");

	stub({ confirm: () => false });
	byText(root, "tbody button", sharedText.delete).click();
	assert.equal(root.querySelector<HTMLElement>(".entities-view .details-panel")!.hidden, true, "Delete isn't a click on the row");
});

test("the Entities page filters by tag, remembers it, tags new entities with it, and reorders among all of the type", async () => {
	const root = await startApp(tagged, "#entities");
	const tagSelect = () => tagSelectIn(root.querySelector(".section-filters"))!;
	assert.deepEqual([...tagSelect().options].map((o) => o.textContent), [sharedText.allTags, "Classic", "Romance"]);
	choose(tagSelect(), "Classic");
	assert.deepEqual(rowNames(root), ["Dune", "Emma"]);

	// Emma moves above Dune, so before Foundation too, which the filter hides.
	root.querySelectorAll<HTMLElement>("tbody .drag-handle")[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
	assert.deepEqual((await readSaved()).entities.map((e) => e.name), ["Emma", "Dune", "Foundation"]);

	byText(root, "button", dataText.createNewEntity).click();
	const tagsInput = [...root.querySelectorAll<HTMLInputElement>("#entity-form label.field input")].at(-1)!;
	// Emma comes first now: the tag is spelled as on her, and the filter still shows the set.
	assert.equal(tagsInput.value, "classic", "a new entity starts in the set shown");
	assert.deepEqual(rowNames(root), ["Emma", "Dune"]);

	goTo("#types");
	goTo("#entities");
	assert.equal(tagSelect().value, "classic", "remembered");
});

test("the type form: the list steps aside while it's open; a new property stands unfolded with its name focused, one with an error unfolds", async () => {
	const status = { id: "status", name: "Status", kind: "options", options: [{ id: "o-open", label: "open" }], reference: null, cardDisplay: "list", description: "" };
	const root = await startApp({ version: DATA_VERSION, types: [{ id: "idea", name: "Idea", color: "#c4dafa", contentTemplate: "", description: "", guide: "", properties: [status] }], entities: [], boards: [] }, "#types");
	byText(root.querySelector(".type-item")!, "button", dataText.edit).click();
	assert.equal(root.querySelector(".type-list"), null, "no list below the form");
	const toggles = () => [...root.querySelectorAll<HTMLButtonElement>("#type-form .property .property-toggle")].map((b) => b.ariaExpanded);
	assert.deepEqual(toggles(), ["false"]);

	byText(root.querySelector("#type-form")!, "button", `+ ${dataText.addProperty}`).click();
	assert.deepEqual(toggles(), ["false", "true"]);
	const names = () => root.querySelectorAll<HTMLInputElement>(`#type-form input[placeholder="${dataText.propertyName}"]`);
	assert.equal(document.activeElement, names()[1], "the new one's name is focused");

	typeInto(names()[1]!, "status");
	byText(root.querySelector("#type-form")!, "button", `+ ${dataText.addProperty}`).click();
	byText(root.querySelector("#type-form")!, "button", sharedText.save).click();
	// Saving is refused: the new one has no name, the other one's name is taken — all three unfold.
	assert.deepEqual(toggles(), ["true", "true", "true"]);
	byText(root.querySelector("#type-form")!, "button", sharedText.cancel).click();
	assert.ok(root.querySelector(".type-list"), "closed, the list is back");
});

test("the type form edits options in place: a rename saves without asking, a carried one dropped asks", async () => {
	const data = {
		version: DATA_VERSION,
		types: [
			{
				id: "idea",
				name: "Idea",
				color: "#c4dafa",
				contentTemplate: "", description: "", guide: "",
				properties: [
					{
						id: "status",
						name: "Status",
						kind: "options",
						options: [
							{ id: "o-open", label: "open" },
							{ id: "o-pitched", label: "pitched" },
						],
						reference: null,
						cardDisplay: "list", description: "",
					},
				],
			},
		],
		entities: [{ id: "01J00000000000000000000000", typeId: "idea", name: "Dune", content: "", description: "", tags: [], values: { status: "o-pitched" } }],
		boards: [],
	};
	const questions: string[] = [];
	stub({
		confirm: (message: string) => {
			questions.push(message);
			return true;
		},
	});
	const root = await startApp(data, "#types");

	byText(root.querySelector(".type-item")!, "button", dataText.edit).click();
	// A property stands folded to its line; its settings, the options among them, unfold below it.
	assert.equal(root.querySelector("#type-form .option-row"), null);
	const unfold = () => [...root.querySelectorAll<HTMLButtonElement>("#type-form .property-toggle")].find((b) => b.ariaLabel === dataText.showPropertySettings("Status"))!.click();
	unfold();
	const form = root.querySelector<HTMLFormElement>("#type-form")!;
	typeInto(form.querySelectorAll<HTMLInputElement>(".option-row input")[1]!, "proposed");
	byText(form, "button", sharedText.save).click();
	await settle();
	assert.deepEqual(questions, [], "renaming an option changes only the type");
	const saved = await readSaved();
	assert.deepEqual(
		saved.types[0]!.properties[0]!.options.map((o) => [o.id, o.label]),
		[
			["o-open", "open"],
			["o-pitched", "proposed"],
		],
	);
	assert.equal(saved.entities[0]!.values.status, "o-pitched", "the entity keeps the option it had");

	// Dropping the option the entity holds asks first; confirmed, the value is cleared.
	byText(root.querySelector(".type-item")!, "button", dataText.edit).click();
	unfold();
	const again = root.querySelector<HTMLFormElement>("#type-form")!;
	[...again.querySelectorAll("button")].find((b) => b.ariaLabel === dataText.removeOption("proposed"))!.click();
	byText(root.querySelector<HTMLFormElement>("#type-form")!, "button", sharedText.save).click();
	await settle();
	assert.deepEqual(questions, [dataText.confirmChangedValues(1)]);
	assert.equal((await readSaved()).entities[0]!.values.status, null);
});

/** A workspace whose type Regel says what it is for and how it is used, its Status what its values mean. */
const withHelp = () => ({
	version: DATA_VERSION,
	types: [
		{
			id: "regel", name: "Regel", color: "#c4dafa", contentTemplate: "",
			description: "Was im System immer gilt.",
			guide: "## Verwendung\n\nEine Regel je Aussage.\n\n## Beispiel\n\nNamen sind **eindeutig**.",
			properties: [
				{ id: "status", name: "Status", kind: "options", options: [{ id: "draft", label: "Entwurf" }, { id: "valid", label: "gültig" }], reference: null, cardDisplay: "list", description: "Entwürfe werden noch nicht als verbindliche Systemregel gelesen." },
				{ id: "quelle", name: "Quelle", kind: "text", options: [], reference: null, cardDisplay: "list", description: "" },
			],
		},
	],
	entities: [{ id: "01J00000000000000000000000", typeId: "regel", name: "Namen sind eindeutig", content: "", description: "", tags: [], values: { status: "draft" } }],
	boards: [],
});

test("the form for a new entity shows what its type is for, its guide to unfold, and each property's note at its field", async () => {
	const root = await startApp(withHelp(), "#entities");
	byText(root, "button", dataText.createNewEntity).click();
	const form = root.querySelector<HTMLFormElement>("#entity-form")!;
	assert.equal(form.querySelector(".type-help-description")?.textContent, "Was im System immer gilt.");
	const guide = form.querySelector<HTMLDetailsElement>(".type-help-guide")!;
	assert.equal(guide.open, false, "the long guide doesn't crowd the form");
	assert.equal(guide.querySelector("summary")?.textContent, dataText.typeGuideOf("Regel"));
	assert.equal(guide.querySelector(".markdown strong")?.textContent, "eindeutig", "the whole guide, formatted");
	assert.deepEqual([...form.querySelectorAll(".field-hint")].map((hint) => [hint.closest(".field")!.querySelector("span")!.textContent, hint.textContent]), [
		["Status", "Entwürfe werden noch nicht als verbindliche Systemregel gelesen."],
	]);
});

test("a field edited on its own shows its property's note; the details show the type's help, the guide staying unfolded", async () => {
	const root = await startApp(withHelp(), "#entities");
	byText<HTMLElement>(root, "tbody .editable", "Entwurf").click();
	assert.equal(root.querySelector("tbody form .field-hint")?.textContent, "Entwürfe werden noch nicht als verbindliche Systemregel gelesen.");
	root.querySelector("tbody form")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal(root.querySelector(".field-hint"), null, "not in every row: only where the value is entered");

	byText(root, ".name-link", "Namen sind eindeutig").click();
	const panel = () => root.querySelector<HTMLElement>(".entities-view .details-panel")!;
	assert.equal(panel().querySelector(".type-help-description")?.textContent, "Was im System immer gilt.");
	const guide = panel().querySelector<HTMLDetailsElement>(".type-help-guide")!;
	guide.open = true;
	guide.dispatchEvent(new Event("toggle"));
	// A field opened draws the details anew: the guide read meanwhile stays open, the note stands at the field.
	byText<HTMLElement>(panel(), ".editable", "Entwurf").click();
	assert.equal(panel().querySelector<HTMLDetailsElement>(".type-help-guide")!.open, true);
	assert.equal(panel().querySelector("form .field-hint")?.textContent, "Entwürfe werden noch nicht als verbindliche Systemregel gelesen.");
	panel().querySelector("form")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	const shown = panel().querySelector<HTMLDetailsElement>(".type-help-guide")!;
	shown.open = false;
	shown.dispatchEvent(new Event("toggle"));
});

test("the type form keeps a type's description and guide and each property's note; the list shows the description", async () => {
	const root = await startApp(withHelp(), "#types");
	assert.equal(root.querySelector(".type-description")?.textContent, "Was im System immer gilt.");
	byText(root, ".type-item button", dataText.edit).click();
	const form = () => root.querySelector<HTMLFormElement>("#type-form")!;
	const description = form().querySelector<HTMLInputElement>(`input[placeholder="${dataText.typeDescriptionHint}"]`)!;
	const guide = form().querySelector<HTMLTextAreaElement>(`textarea[placeholder="${dataText.typeGuideHint}"]`)!;
	assert.equal(description.value, "Was im System immer gilt.");
	assert.match(guide.value, /^## Verwendung/);
	typeInto(description, " Was immer gilt. ");
	typeInto(guide, "Kurz.");
	form().querySelectorAll<HTMLElement>(".property-toggle")[2]!.click(); // after the built-in fields' and Status's
	const note = form().querySelector<HTMLInputElement>(`input[placeholder="${dataText.propertyDescriptionHint}"]`)!;
	assert.equal(note.value, "");
	typeInto(note, "Woher die Regel stammt.");
	byText(form(), "button", sharedText.save).click();

	const [regel] = (await readSaved()).types;
	assert.equal(regel!.description, "Was immer gilt.");
	assert.equal(regel!.guide, "Kurz.");
	assert.deepEqual(regel!.properties.map((p) => p.description), ["Entwürfe werden noch nicht als verbindliche Systemregel gelesen.", "Woher die Regel stammt."]);
	assert.deepEqual((await readSaved()).entities[0]!.values, { status: "draft" });
});
