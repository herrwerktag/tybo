import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryDataPort } from "../../memory-port.js";
import { DATA_VERSION, NameTaken } from "../../shared/core/index.js";
import { changesBetween, createStore } from "../../features.core.js";
import {
	addTrait,
	bindingChoices,
	deleteTrait,
	fittingBinding,
	roleReader,
	updateTrait,
	validateTrait,
	withBinding,
	withRoles,
	withType,
	type RoleDef,
} from "./core.js";
import { progress, progressModel } from "./test-progress.js";

const role = (id: string) => progress().roles.find((r) => r.id === id)!;
const entity = (data: ReturnType<typeof progressModel>, id: string) => data.entities.find((e) => e.id === id)!;

test("what can play a role: a text role a field or a text property, an options role an options property, a reference role a reference either way", () => {
	const { types } = progressModel();
	const choices = (typeId: string, roleId: string) =>
		bindingChoices(types, typeId, role(roleId)).map(({ fits }) => ("field" in fits ? fits.field : `${fits.direction} ${fits.prop.name}`));
	assert.deepEqual(choices("pitch", "short"), ["name", "content", "description"]);
	assert.deepEqual(choices("question", "short"), ["name", "content", "description", "forward Frage"]);
	assert.deepEqual(choices("pitch", "stand"), ["forward Status"]);
	assert.deepEqual(choices("pitch", "belongs"), ["forward Job Story", "inverse Pitch"]);
	assert.deepEqual(choices("story", "belongs"), ["inverse Job Story"]);

	// What doesn't fit the role's kind isn't read.
	assert.equal(fittingBinding(types, "pitch", role("short"), { propertyId: "p-status", direction: "forward", values: {} }), null);
	assert.equal(fittingBinding(types, "pitch", role("stand"), { field: "name" }), null);
	assert.equal(fittingBinding(types, "rule", role("belongs"), { propertyId: "p-stories", direction: "inverse", values: {} }), null, "Job Story doesn't point at rules");
});

test("a role read on an entity: the role's values its options stand for, its texts, the entities it leads to; none on types not bearing the trait", () => {
	const data = progressModel();
	const [trait] = data.traits;
	const read = (roleId: string, entityId: string) => roleReader(data, trait!, roleId)(entity(data, entityId));
	assert.deepEqual(read("stand", "traits"), ["r-open"]);
	assert.deepEqual(read("stand", "naming"), ["r-open"], "two types' options stand for one value of the role");
	assert.deepEqual(read("stand", "where"), ["r-done"]);
	assert.deepEqual(read("stand", "story-mode"), [], "an option standing for none counts as no value");
	assert.deepEqual(read("stand", "see"), [], "an unbound role has no value");
	assert.deepEqual(read("stand", "rule"), [], "a type not bearing the trait has none");
	assert.deepEqual(read("short", "traits"), ["Bedeutungen"]);
	assert.deepEqual(read("short", "history"), [], "an empty text is none");
	assert.deepEqual(read("short", "naming"), ["Trait oder Merkmal?"]);
	assert.deepEqual(read("belongs", "see"), ["traits"], "inverse: the pitch planning the job story");
});

test("bindings outlive what they name: a property gone or of another kind reads as none, a renamed option still stands for its value", () => {
	const data = progressModel();
	const [trait] = data.traits;
	const question = data.types.find((t) => t.id === "question")!;
	const pitch = data.types.find((t) => t.id === "pitch")!;
	pitch.properties[0]!.options[0]!.label = "Skizze";
	assert.deepEqual(roleReader(data, trait!, "stand")(entity(data, "traits")), ["r-open"]);

	question.properties = question.properties.filter((p) => p.id !== "q-status");
	assert.equal(fittingBinding(data.types, "question", role("stand"), trait!.bindings.question!.stand), null);
	assert.deepEqual(roleReader(data, trait!, "stand")(entity(data, "naming")), []);
	question.properties.push({ id: "q-status", name: "Status", kind: "text", options: [], reference: null, cardDisplay: "list" });
	assert.equal(fittingBinding(data.types, "question", role("stand"), trait!.bindings.question!.stand), null, "a text no longer fits an options role");
});

test("changing roles: a role gone or of another kind loses its bindings, a value gone is forgotten by the options standing for it", () => {
	const trait = progress();
	const [stand, short, belongs] = trait.roles as [RoleDef, RoleDef, RoleDef];
	const fewer = withRoles(trait, [{ ...stand, options: stand.options.filter((o) => o.id !== "r-doing") }, { ...short, kind: "reference" }]);
	assert.deepEqual(fewer.bindings.pitch, { stand: { propertyId: "p-status", direction: "forward", values: { draft: "r-open", planned: "r-open", closed: "r-done" } } });
	assert.deepEqual(fewer.bindings.story, {}, "the type still bears the trait");
	assert.deepEqual(withRoles(trait, [{ ...belongs, name: "  gehört zu  " }]).roles.map((r) => r.name), ["gehört zu"]);

	const bound = withBinding(withType(trait, "rule", true), "rule", "stand", { propertyId: "r-status", direction: "forward", values: {} });
	assert.deepEqual(bound.bindings.rule, { stand: { propertyId: "r-status", direction: "forward", values: {} } });
	assert.deepEqual(withBinding(bound, "rule", "stand", null).bindings.rule, {});
	assert.equal(Object.hasOwn(withType(bound, "rule", false).bindings, "rule"), false);
});

test("a trait needs a name of its own, roles with names of their own, and an options role values of its own", () => {
	const traits = [progress()];
	const codes = (name: string, roles: Omit<RoleDef, "id">[], selfId: string | null = null) => validateTrait(name, roles, traits, selfId).map((e) => e.code);
	assert.deepEqual(codes(" fortschritt ", []), ["traitNameTaken"]);
	assert.deepEqual(codes("Fortschritt", [], "progress"), []);
	assert.deepEqual(codes(" ", [{ name: "", kind: "text", options: [] }]), ["traitNameRequired", "roleNameRequired"]);
	assert.deepEqual(
		codes("Blockade", [
			{ name: "Stand", kind: "options", options: [] },
			{ name: "stand ", kind: "options", options: [{ id: "a", label: "x" }, { id: "b", label: "X" }, { id: "c", label: " " }] },
		]),
		["optionsRequired", "duplicateRole", "emptyOption", "duplicateOptions"],
	);
});

test("a trait is one unit of its own: binding a type changes no type, and it is saved, changed and deleted like an analysis", async () => {
	const storage = memoryDataPort({ ws: { version: DATA_VERSION, types: [], entities: [], boards: [] } });
	const store = await createStore(storage.port, "ws");
	const pitch = store.addType("Pitch", [{ name: "Status", kind: "options", options: [{ label: "Entwurf" }], reference: null, cardDisplay: "list" }], "");
	const trait = addTrait(store, "");
	assert.equal(trait.name, "Trait 1");
	assert.throws(() => addTrait(store, " trait 1"), NameTaken);
	const before = store.data;
	const roles = withRoles(trait, [{ id: "stand", name: "Stand", kind: "options", options: [{ id: "open", label: "offen" }] }]);
	const bound = withBinding(roles, pitch.id, "stand", { propertyId: pitch.properties[0]!.id, direction: "forward", values: { [pitch.properties[0]!.options[0]!.id]: "open" } });
	updateTrait(store, trait.id, { name: "Fortschritt", roles: bound.roles, bindings: bound.bindings });
	assert.deepEqual(changesBetween(before, store.data).map((c) => `${c.kind}:${c.id}`), [`trait:${trait.id}`]);

	await new Promise((resolve) => setTimeout(resolve));
	const reopened = await createStore(storage.port, "ws");
	assert.deepEqual(reopened.data.traits, [{ ...bound, name: "Fortschritt" }]);
	deleteTrait(store, trait.id);
	assert.equal(store.data.traits.length, 0);
	store.undo();
	assert.equal(store.data.traits[0]!.name, "Fortschritt");
});

test("loading keeps well-formed traits only, and their bindings to what is gone; data from before traits has none", async () => {
	const storage = memoryDataPort({
		old: { version: 10, types: [], entities: [], boards: [] },
		ws: {
			version: DATA_VERSION,
			types: [],
			entities: [],
			boards: [],
			traits: [
				{ id: "t", name: "", roles: [{ id: "r", name: "Stand", kind: "options", options: [{ id: "o", label: "offen" }, "kaputt"] }, { id: "x", kind: "number" }], bindings: { gone: { r: { propertyId: "p", direction: "forward", values: { a: "o", b: 3 } }, x: { field: "nope" } } } },
				{ name: "ohne id" },
			],
		},
	});
	assert.deepEqual((await createStore(storage.port, "old")).data.traits, []);
	assert.deepEqual((await createStore(storage.port, "ws")).data.traits, [
		{ id: "t", name: "Trait 1", roles: [{ id: "r", name: "Stand", kind: "options", options: [{ id: "o", label: "offen" }] }], bindings: { gone: { r: { propertyId: "p", direction: "forward", values: { a: "o" } } } } },
	]);
});
