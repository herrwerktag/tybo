import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryDataPort } from "../../memory-port.js";
import { DATA_VERSION, NameTaken } from "../../shared/core/index.js";
import { changesBetween, createStore } from "../../features.core.js";
import {
	addTrait,
	bindingChoices,
	conditionCycle,
	conditionHints,
	deleteTrait,
	fittingBinding,
	resolveCondition,
	roleReader,
	updateTrait,
	validateTrait,
	withBinding,
	withRoles,
	withType,
	type Condition,
	type RoleDef,
	type Trait,
} from "./core.js";
import { newReference, type PropertyDef } from "../data/core.js";
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
	const codes = (name: string, roles: Omit<RoleDef, "id">[], selfId: string | null = null) =>
		validateTrait(name, roles.map((r, i) => ({ ...r, id: `r${i}` })), traits, selfId).map((e) => e.code);
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

/** Tasks waiting on tasks, each with a status; Progress over them, and Blockade: what a task is blocked by (the tasks it
 * waits on that aren't done), what it waits on that is blocked itself, and what it waits on that is free. */
function tasks(waits: Record<string, string[]>, open: string[]) {
	const status: PropertyDef = { id: "t-status", name: "Status", kind: "options", options: [{ id: "t-open", label: "offen" }, { id: "t-done", label: "erledigt" }], reference: null, cardDisplay: "list" };
	const wait: PropertyDef = { id: "t-waits", name: "wartet auf", kind: "reference", options: [], reference: { ...newReference(["task"]), multiple: true }, cardDisplay: "list" };
	const binding = { propertyId: "t-waits", direction: "forward" as const, values: {} };
	const progressOfTasks: Trait = {
		id: "progress",
		name: "Fortschritt",
		roles: [{ id: "stand", name: "Stand", kind: "options", options: [{ id: "open", label: "offen" }, { id: "done", label: "fertig" }] }],
		bindings: { task: { stand: { propertyId: "t-status", direction: "forward", values: { "t-open": "open", "t-done": "done" } } } },
	};
	const blockade: Trait = {
		id: "blockade",
		name: "Blockade",
		roles: [
			{ id: "blocked", name: "blockiert durch", kind: "reference", options: [], condition: { traitId: "progress", roleId: "stand", values: ["open"] } },
			{ id: "onBlocked", name: "wartet auf Blockiertes", kind: "reference", options: [], condition: { traitId: "blockade", roleId: "blocked", hasTargets: true } },
			{ id: "onFree", name: "wartet auf Freies", kind: "reference", options: [], condition: { traitId: "blockade", roleId: "blocked", hasTargets: false } },
		],
		bindings: { task: { blocked: binding, onBlocked: binding, onFree: binding } },
	};
	const names = [...new Set([...Object.keys(waits), ...Object.values(waits).flat(), ...open])];
	return {
		types: [{ id: "task", name: "Aufgabe", properties: [status, wait], contentTemplate: "", color: "#dcdcdc" }],
		entities: names.map((name) => ({
			id: name,
			typeId: "task",
			name,
			content: "",
			description: "",
			tags: [],
			values: { "t-status": open.includes(name) ? "t-open" : "t-done", ...(waits[name] ? { "t-waits": waits[name] } : {}) },
		})),
		traits: [progressOfTasks, blockade],
	};
}
const reads = (data: ReturnType<typeof tasks>, roleId: string) => {
	const read = roleReader(data, data.traits[1]!, roleId);
	return Object.fromEntries(data.entities.map((e) => [e.id, read(e)]));
};

test("a condition lets through only the targets meeting it: a value of an options role, or a reference role having targets or none", () => {
	const data = tasks({ X: ["Y"], Y: ["Z", "W"] }, ["X", "Y", "Z"]);
	assert.deepEqual(reads(data, "blocked"), { X: ["Y"], Y: ["Z"], Z: [], W: [] }, "W is done: it blocks nothing");
	assert.deepEqual(reads(data, "onBlocked"), { X: ["Y"], Y: [], Z: [], W: [] }, "Y is blocked itself, Z and W aren't");
	assert.deepEqual(reads(data, "onFree"), { X: [], Y: ["Z", "W"], Z: [], W: [] });
});

test("a circle in the data is no problem: the conditions' chain ends, whatever the references do", () => {
	const data = tasks({ X: ["Y"], Y: ["X"] }, ["X", "Y"]);
	assert.deepEqual(reads(data, "blocked"), { X: ["Y"], Y: ["X"] });
	assert.deepEqual(reads(data, "onBlocked"), { X: ["Y"], Y: ["X"] });
});

test("a target never meets a condition when its type doesn't bear the trait asked about, or holds no value there", () => {
	const data = progressModel();
	const blockade: Trait = {
		id: "blockade",
		name: "Blockade",
		roles: [{ id: "blocked", name: "blockiert durch", kind: "reference", options: [], condition: { traitId: "progress", roleId: "stand", values: ["r-open", "r-done"] } }],
		// A pitch is blocked by the questions on it; a question by the job stories planned — which bear Progress unbound.
		bindings: { pitch: { blocked: { propertyId: "q-pitch", direction: "inverse", values: {} } }, question: {} },
	};
	data.traits.push(blockade);
	assert.deepEqual(roleReader(data, blockade, "blocked")(entity(data, "traits")), ["naming"]);
	data.entities.push({ ...entity(data, "naming"), id: "unmapped", values: { "q-pitch": "traits" } });
	assert.deepEqual(roleReader(data, blockade, "blocked")(entity(data, "traits")), ["naming"], "a question without a status holds no stand");

	// Bound to the job stories a pitch plans: their type bears Progress, but not its stand.
	data.traits[1] = withBinding(blockade, "pitch", "blocked", { propertyId: "p-stories", direction: "forward", values: {} });
	assert.deepEqual(roleReader(data, data.traits[1], "blocked")(entity(data, "traits")), []);
	assert.deepEqual(conditionHints(data, data.traits[1]), [], "Job Story bears Progress");
	data.traits[0] = withType(data.traits[0]!, "story", false);
	assert.deepEqual(conditionHints(data, data.traits[1]), [{ typeId: "pitch", roleId: "blocked", typeIds: ["story"] }], "the form points out targets that never count");
});

test("conditions may not lead round in a circle — through other roles, other traits, or a role asking about itself", () => {
	const data = tasks({}, []);
	const [progressOfTasks, blockade] = data.traits as [Trait, Trait];
	const roles = (ask: Record<string, Condition>) => blockade.roles.map((r) => ({ ...r, ...(ask[r.id] ? { condition: ask[r.id] } : {}) }));
	const errors = (rolesNow: RoleDef[], traits = data.traits) => validateTrait("Blockade", rolesNow, traits, "blockade");
	assert.deepEqual(errors(blockade.roles), []);
	assert.deepEqual(errors(roles({ blocked: { traitId: "blockade", roleId: "blocked", hasTargets: true } })), [
		{ code: "conditionCycle", label: "Blockade.blockiert durch › Blockade.blockiert durch" },
	]);
	assert.deepEqual(errors(roles({ blocked: { traitId: "blockade", roleId: "onBlocked", hasTargets: true } })), [
		{ code: "conditionCycle", label: "Blockade.blockiert durch › Blockade.wartet auf Blockiertes › Blockade.blockiert durch" },
	], "one circle, told once");

	// Through another trait: Progress gets a reference role asking about Blockade.
	const progressAsking: Trait = { ...progressOfTasks, roles: [...progressOfTasks.roles, { id: "waits", name: "wartet", kind: "reference", options: [], condition: { traitId: "blockade", roleId: "blocked", hasTargets: true } }] };
	assert.deepEqual(errors(roles({ blocked: { traitId: "progress", roleId: "waits", hasTargets: true } }), [progressAsking, blockade]).map((e) => e.code), ["conditionCycle"]);
	assert.deepEqual(conditionCycle([progressAsking, blockade], { traitId: "blockade", roleId: "onFree" }), null, "a chain into a circle elsewhere isn't this role's");
});

test("a condition whose role or values are gone lets nothing through; changing a role's kind drops its condition", () => {
	const data = tasks({ X: ["Y"] }, ["X", "Y"]);
	const progressOfTasks = data.traits[0]!;
	data.traits[0] = withRoles(progressOfTasks, [{ ...progressOfTasks.roles[0]!, options: progressOfTasks.roles[0]!.options.filter((o) => o.id !== "open") }]);
	assert.equal(resolveCondition(data.traits, data.traits[1]!.roles[0]!.condition!), null);
	assert.deepEqual(reads(data, "blocked"), { X: [], Y: [] });
	assert.deepEqual(reads(data, "onFree"), { X: ["Y"], Y: [] }, "nothing is blocked now, so Y is free");

	const blockade = data.traits[1]!;
	const asText = withRoles(blockade, blockade.roles.map((r) => (r.id === "blocked" ? { ...r, kind: "text" as const } : r)));
	assert.equal(asText.roles[0]!.condition, undefined);
});

test("loading keeps a well-formed condition of a reference role, and nothing else of the kind", async () => {
	const role = (id: string, kind: string, condition: unknown) => ({ id, name: id, kind, options: [], condition });
	const storage = memoryDataPort({
		ws: {
			version: DATA_VERSION,
			types: [],
			entities: [],
			boards: [],
			traits: [{ id: "t", name: "T", bindings: {}, roles: [role("a", "reference", { traitId: "t", roleId: "b", hasTargets: false }), role("b", "reference", { traitId: "t" }), role("c", "text", { traitId: "t", roleId: "a", hasTargets: true }), role("d", "reference", { traitId: "u", roleId: "o", values: ["x", 1] })] }],
		},
	});
	const [trait] = (await createStore(storage.port, "ws")).data.traits;
	assert.deepEqual(trait!.roles.map((r) => r.condition), [{ traitId: "t", roleId: "b", hasTargets: false }, undefined, undefined, { traitId: "u", roleId: "o", values: ["x"] }]);
	assert.deepEqual(trait!.roles.map((r) => Object.hasOwn(r, "condition")), [true, false, false, true], "a role without one has no field for it");
});
