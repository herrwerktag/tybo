import "../../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { newReference, type DraftProperty, type EntityType } from "../core.js";
import { text } from "../texts.js";
import { propertyRow } from "./property-row.js";

const book: EntityType = { id: "book", name: "Book", color: "#c4dafa", contentTemplate: "", description: "", guide: "", properties: [] };
const person: EntityType = { id: "person", name: "Person", color: "#c8ebbf", contentTemplate: "", description: "", guide: "", properties: [] };

function draft(fields: Partial<DraftProperty> = {}): DraftProperty {
	return { name: "author", kind: "text", options: [], reference: null, cardDisplay: "list", ...fields };
}

/** The properties' lines as the type form draws them, unfolded but `folded`, drawn anew whenever a setting asks for it. */
function form(props: DraftProperty[], types: EntityType[] = [book, person], folded = new Set<DraftProperty>()) {
	const view = document.createElement("div");
	let current = props;
	const draw = () => view.replaceChildren(...current.map((prop, i) => propertyRow(prop, i, rows)));
	const rows = {
		types: () => types,
		props: () => current,
		setProps: (next: DraftProperty[]) => {
			current = next;
		},
		rerender: draw,
		focusHandle: () => {},
		isOpen: (prop: DraftProperty) => !folded.has(prop),
		setOpen: (prop: DraftProperty, open: boolean) => {
			if (open) folded.delete(prop);
			else folded.add(prop);
		},
	};
	draw();
	return { view, props: () => current };
}

function choose(select: HTMLSelectElement, value: string): void {
	select.value = value;
	select.dispatchEvent(new Event("change"));
}

function selects(view: HTMLElement): HTMLSelectElement[] {
	return [...view.querySelectorAll("select")];
}

/** The element of that tag with that accessible name, if drawn. */
function labeled<K extends keyof HTMLElementTagNameMap>(view: HTMLElement, tag: K, label: string): HTMLElementTagNameMap[K] | undefined {
	return [...view.querySelectorAll(tag)].find((e) => e.ariaLabel === label);
}

function checkbox(view: HTMLElement, label: string): HTMLInputElement {
	const found = [...view.querySelectorAll("label.checkbox-setting")].find((l) => l.textContent?.trim() === label);
	return found!.querySelector("input")!;
}

test("a text property offers no line on cards; turned into a reference it gets a reference with its settings", () => {
	const prop = draft();
	const { view } = form([prop]);
	const [kind, display] = selects(view);
	assert.deepEqual([...display!.options].map((o) => o.value), ["list", "hidden"]);
	assert.equal(view.querySelector("label.checkbox-setting"), null);

	choose(kind!, "reference");
	assert.deepEqual(prop.reference, newReference([]));
	assert.deepEqual([...selects(view)[1]!.options].map((o) => o.value), ["list", "line", "hidden"]);
	assert.ok(checkbox(view, text.allowMultiple));
	assert.ok(checkbox(view, text.requiredReference));
});

test("a reference shown as a line falls back to the list when it becomes text again", () => {
	const prop = draft({ kind: "reference", reference: newReference(["book"]), cardDisplay: "line" });
	const { view } = form([prop]);
	choose(selects(view)[0]!, "text");
	assert.equal(prop.cardDisplay, "list");
	assert.equal(selects(view)[1]!.value, "list");
});

test("an option is a row: typed, added, removed, and reordered with its drag handle's arrow keys — keeping its id", () => {
	const prop = draft({ kind: "options", options: [{ id: "a", label: "A" }, { label: "B" }] });
	const { view } = form([prop]);
	const labels = () => [...view.querySelectorAll<HTMLInputElement>(`.option-row input`)];
	assert.deepEqual(labels().map((i) => i.value), ["A", "B"]);

	labels()[1]!.value = "B2";
	labels()[1]!.dispatchEvent(new Event("input", { bubbles: true }));
	assert.deepEqual(prop.options, [{ id: "a", label: "A" }, { label: "B2" }]);

	[...view.querySelectorAll("button")].find((b) => b.textContent === text.addOption)!.click();
	assert.deepEqual(prop.options.length, 3);
	labels()[2]!.value = "C";
	labels()[2]!.dispatchEvent(new Event("input", { bubbles: true }));

	labeled(view, "button", text.removeOption("A"))!.click();
	assert.deepEqual(prop.options, [{ label: "B2" }, { label: "C" }]);

	// Reordered by the handle's arrow keys, the option keeps its id.
	const prop2 = draft({ kind: "options", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] });
	const { view: view2 } = form([prop2]);
	const handle = [...view2.querySelectorAll<HTMLElement>(".option-row .drag-handle")].find((h) => h.dataset.focusKey === "option:0:2")!;
	handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
	assert.deepEqual(prop2.options.map((o) => o.id), ["a", "c", "b"]);
});

test("a reference's target types are tags in their colors; the select adds the others, × removes one", () => {
	const prop = draft({ kind: "reference", reference: newReference(["book"]) });
	const { view } = form([prop]);
	const tags = () => [...view.querySelectorAll<HTMLElement>(".reference-type")];
	assert.deepEqual(tags().map((t) => [t.firstChild?.textContent, t.style.background]), [["Book", book.color]]);
	const add = labeled(view, "select", text.addReferenceType)!;
	assert.deepEqual([...add.options].slice(1).map((o) => o.value), ["person"]);

	choose(add, "person");
	assert.deepEqual(prop.reference?.typeIds, ["book", "person"]);
	assert.deepEqual(tags().map((t) => t.firstChild?.textContent), ["Book", "Person"]);
	assert.equal(labeled(view, "select", text.addReferenceType), undefined, "no type left to add");

	labeled(view, "button", text.removeReferenceType("Book"))!.click();
	assert.deepEqual(prop.reference?.typeIds, ["person"]);
	assert.deepEqual(tags().map((t) => t.firstChild?.textContent), ["Person"]);
});

test("without any types a reference says so instead of offering a select", () => {
	const { view } = form([draft({ kind: "reference", reference: newReference([]) })], []);
	assert.equal(view.querySelector(".property-settings .muted")?.textContent, text.noTypesOption);
	assert.equal(labeled(view, "select", text.addReferenceType), undefined);
});

test("multiple, required and the label on the target are set on the reference", () => {
	const prop = draft({ kind: "reference", reference: newReference(["book"]) });
	const { view } = form([prop]);
	for (const label of [text.allowMultiple, text.requiredReference]) {
		const box = checkbox(view, label);
		box.checked = true;
		box.dispatchEvent(new Event("change"));
	}
	const inverse = view.querySelector<HTMLInputElement>(`input[placeholder="${text.shownOnTargetAsPlaceholder}"]`)!;
	inverse.value = "written by";
	inverse.dispatchEvent(new Event("input"));
	assert.deepEqual(
		[prop.reference?.multiple, prop.reference?.required, prop.reference?.inverseLabel],
		[true, true, "written by"],
	);
});

test("arrow and line label are offered only while the reference is shown as a line", () => {
	const prop = draft({ kind: "reference", reference: newReference(["book"]) });
	const { view } = form([prop]);
	const lineLabel = () => view.querySelector<HTMLInputElement>(`input[placeholder="author"]`);
	assert.equal(lineLabel(), null);

	choose(selects(view)[1]!, "line");
	assert.equal(prop.cardDisplay, "line");
	const arrow = selects(view).find((s) => [...s.options].some((o) => o.value === "from"))!;
	choose(arrow, "none");
	const label = lineLabel()!;
	label.value = "wrote";
	label.dispatchEvent(new Event("input"));
	assert.deepEqual([prop.reference?.arrow, prop.reference?.lineLabel], ["none", "wrote"]);

	choose(selects(view)[1]!, "hidden");
	assert.equal(lineLabel(), null);
});

test("a property is renamed in place and removed by its button", () => {
	const first = draft({ name: "title" });
	const { view, props } = form([first, draft()]);
	const name = view.querySelector<HTMLInputElement>(`input[placeholder="${text.propertyName}"]`)!;
	name.value = "name";
	name.dispatchEvent(new Event("input"));
	assert.equal(first.name, "name");

	labeled(view, "button", text.removePropertyNamed("author"))!.click();
	assert.deepEqual(props().map((p) => p.name), ["name"]);
	assert.equal(view.querySelectorAll(".property").length, 1);
});

test("folded, a property is one line: its name, kind and targets in short; unfolding shows its settings", () => {
	const prop = draft({ name: "written by", kind: "reference", reference: newReference(["person", "book"]) });
	const status = draft({ name: "status", kind: "options", options: [{ label: "open" }, { label: "done" }] });
	const { view } = form([prop, status], [book, person], new Set([prop, status]));
	const lines = [...view.querySelectorAll(".property-summary")].map((s) => [...s.children].map((c) => c.textContent));
	assert.deepEqual(lines, [
		[text.kinds.reference, "Person", "Book"],
		[text.kinds.options, text.optionCount(2)],
	]);
	assert.equal(view.querySelector("select"), null, "no settings while folded");
	const toggle = labeled(view, "button", text.showPropertySettings("written by"))!;
	assert.equal(toggle.ariaExpanded, "false");
	toggle.click();
	assert.equal(labeled(view, "button", text.showPropertySettings("written by"))!.ariaExpanded, "true");
	assert.ok(checkbox(view, text.allowMultiple), "unfolded, the reference's settings are there");
	assert.equal(view.querySelectorAll(".property")[1]!.querySelector("select"), null, "the other stays folded");
});
