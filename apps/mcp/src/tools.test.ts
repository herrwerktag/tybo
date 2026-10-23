import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION, createStore } from "@tybo/core";
import { memoryDataPort } from "@tybo/core/testing";
import { ToolError } from "./protocol.js";
import { tyboTools } from "./tools.js";

/** The tools on a port in memory holding one empty workspace, "Projekt"; `call` runs one and parses its answer. */
function setup() {
	const storage = memoryDataPort({ Projekt: { version: DATA_VERSION, types: [], entities: [], boards: [] } });
	const tools = tyboTools(storage.port);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `no tool ${name}`);
		return JSON.parse(await tool.run({ workspace: "Projekt", ...args }));
	};
	/** The tool's refusal, as the model gets to read it. */
	const refusal = async (name: string, args: Record<string, unknown>) => {
		const tool = tools.find((t) => t.name === name)!;
		const error = await tool.run({ workspace: "Projekt", ...args }).then(
			() => assert.fail(`${name} didn't refuse`),
			(e: unknown) => e,
		);
		assert.ok(error instanceof ToolError, String(error));
		return error.message;
	};
	return { storage, call, refusal };
}

/** Two types, a Person and a Task referencing its owner, with Ada and Alan and one task of Ada's. */
async function withPeople() {
	const tools = setup();
	await tools.call("create_type", { name: "Person", properties: [{ name: "Role", kind: "options", options: ["Dev", "Lead"] }] });
	await tools.call("create_type", {
		name: "Task",
		properties: [{ name: "Owner", kind: "reference", targets: ["person"], inverseLabel: "owns" }],
	});
	await tools.call("create_entity", { type: "Person", name: "Ada", values: { role: "Lead" } });
	await tools.call("create_entity", { type: "Person", name: "Alan", values: { Role: "Dev" } });
	await tools.call("create_entity", { type: "Task", name: "Write the spec", values: { Owner: "ada" }, tags: ["q4"] });
	return tools;
}

test("types and entities made by the tools are saved, references named by name", async () => {
	const { storage } = await withPeople();
	const store = await createStore(storage.port, "Projekt");
	const [person, task] = store.data.types;
	assert.deepEqual(store.data.types.map((t) => t.name), ["Person", "Task"]);
	assert.deepEqual(task!.properties[0]!.reference?.typeIds, [person!.id]);
	const ada = store.data.entities.find((e) => e.name === "Ada")!;
	const spec = store.data.entities.find((e) => e.name === "Write the spec")!;
	assert.equal(ada.values[person!.properties[0]!.id], "Lead");
	assert.equal(spec.values[task!.properties[0]!.id], ada.id);
	assert.deepEqual(spec.tags, ["q4"]);
});

test("describe_workspace tells the types with their properties, how many entities each has, and the tags", async () => {
	const { call } = await withPeople();
	const described = await call("describe_workspace");
	assert.deepEqual(
		described.types.map((t: { name: string; entities: number; properties: { name: string }[] }) => [t.name, t.entities, t.properties.map((p) => p.name)]),
		[
			["Person", 2, ["Role"]],
			["Task", 1, ["Owner"]],
		],
	);
	assert.deepEqual(described.types[1].properties[0].targets, ["Person"]);
	assert.deepEqual(described.tags, ["q4"]);
	assert.deepEqual(described.analyses, []);
});

test("find_entities filters by type, name, tag and values; get_entity tells who references the entity", async () => {
	const { call } = await withPeople();
	assert.deepEqual((await call("find_entities", { query: "a" })).entities.map((e: { name: string }) => e.name), ["Ada", "Alan"]);
	assert.deepEqual((await call("find_entities", { type: "Person", values: { Role: "dev" } })).entities.map((e: { name: string }) => e.name), ["Alan"]);
	assert.deepEqual((await call("find_entities", { type: "Task", values: { Owner: "Ada" } })).total, 1);
	assert.deepEqual((await call("find_entities", { tag: "Q4" })).entities.map((e: { name: string }) => e.name), ["Write the spec"]);
	assert.equal((await call("find_entities", { limit: 1 })).entities.length, 1);

	const ada = await call("get_entity", { entity: "Ada" });
	assert.deepEqual(ada.values, { Role: "Lead" });
	assert.deepEqual(ada.referencedBy.map((r: { label: string; entities: { name: string }[] }) => [r.label, r.entities.map((e) => e.name)]), [
		["owns", ["Write the spec"]],
	]);
	const spec = await call("get_entity", { entity: "write the spec" });
	assert.deepEqual(spec.values.Owner, [{ id: ada.id, name: "Ada" }]);
});

test("update_entity changes only what it's given; null clears a value; delete_entity needs confirm", async () => {
	const { call, refusal } = await withPeople();
	await call("update_entity", { entity: "Ada", content: "Leads the project" });
	let ada = await call("get_entity", { entity: "Ada" });
	assert.equal(ada.content, "Leads the project");
	assert.deepEqual(ada.values, { Role: "Lead" });
	await call("update_entity", { entity: "Ada", values: { Role: null } });
	ada = await call("get_entity", { entity: "Ada" });
	assert.deepEqual(ada.values, {});

	assert.match(await refusal("delete_entity", { entity: "Ada", confirm: false }), /confirm: true/);
	await call("delete_entity", { entity: "Ada", confirm: true });
	assert.equal((await call("find_entities", { type: "Person" })).total, 1);
	// The task's reference to Ada went with her.
	assert.deepEqual((await call("get_entity", { entity: "Write the spec" })).values, {});
});

test("update_type keeps listed properties with their values, removes the ones left out, and can point at itself", async () => {
	const { call } = await withPeople();
	await call("update_type", {
		type: "Person",
		properties: [
			{ name: "Role", options: ["Dev", "Lead", "Ops"] },
			{ name: "Mentor", kind: "reference", targets: ["Person"] },
		],
	});
	await call("update_entity", { entity: "Alan", values: { Mentor: "Ada", Role: "Ops" } });
	const alan = await call("get_entity", { entity: "Alan" });
	assert.equal(alan.values.Role, "Ops");
	assert.deepEqual(alan.values.Mentor.map((e: { name: string }) => e.name), ["Ada"]);
	assert.equal((await call("get_entity", { entity: "Ada" })).values.Role, "Lead");

	await call("update_type", { type: "Person", properties: [{ name: "Mentor" }] });
	assert.deepEqual((await call("get_entity", { entity: "Ada" })).values, {});
});

test("a required reference is saved without an entity, and the entity lists it as missing until it has one", async () => {
	const { call } = await withPeople();
	await call("update_type", { type: "Task", properties: [{ name: "Owner", required: true }] });
	assert.equal((await call("describe_workspace")).types[1].properties[0].required, true);

	const created = await call("create_entity", { type: "Task", name: "Review" });
	assert.deepEqual(created.entity.missing, ["Owner"]);
	await call("update_entity", { entity: "Review", values: { Owner: "Alan" } });
	assert.equal((await call("get_entity", { entity: "Review" })).missing, undefined);
});

test("what doesn't fit is refused with a message the model can act on, and nothing is written", async () => {
	const { refusal, storage, call } = await withPeople();
	const saves = storage.saves.length;
	assert.match(await refusal("create_entity", { type: "Person", name: "Grace", values: { Role: "CEO" } }), /Options: Dev, Lead/);
	assert.match(await refusal("create_entity", { type: "Robot", name: "R2" }), /Types: Person, Task/);
	assert.match(await refusal("create_entity", { type: "Person", name: "Grace", values: { Age: "40" } }), /Properties: Role/);
	assert.match(await refusal("create_entity", { type: "Task", name: "x", values: { Owner: "Grace" } }), /no such entity "Grace"/);
	assert.match(await refusal("create_entity", { type: "Task", name: "x", values: { Owner: ["Ada", "Alan"] } }), /one entity only/);
	assert.match(await refusal("create_type", { name: "Thing", properties: [{ name: "name", kind: "text" }] }), /reserved/);
	assert.match(await refusal("create_type", { name: "Thing", properties: [{ name: "Size", kind: "options" }] }), /needs options/);
	assert.match(await refusal("create_type", { name: "person" }), /already/);
	assert.match(await refusal("get_entity", { workspace: "Elsewhere", entity: "Ada" }), /Workspaces: Projekt/);

	await call("create_entity", { type: "Task", name: "Ada" });
	assert.match(await refusal("get_entity", { entity: "Ada" }), /Several entities are called "Ada"/);
	assert.equal((await call("get_entity", { entity: "Ada", type: "Person" })).type, "Person");
	assert.equal(storage.saves.length, saves + 1);
});

test("a save that fails is the tool's failure", async () => {
	const { refusal, storage } = await withPeople();
	storage.failing.saves = true;
	assert.match(await refusal("create_entity", { type: "Person", name: "Grace" }), /couldn't be saved/);
});

test("run_analysis answers the analysis's groups and columns by name", async () => {
	const { storage, call } = await withPeople();
	const store = await createStore(storage.port, "Projekt");
	const [person, task] = store.data.types;
	const owner = task!.properties[0]!;
	const analysis = store.addAnalysis("Tasks by owner");
	store.updateAnalysis(analysis.id, {
		typeId: task!.id,
		groups: [[{ propertyId: owner.id, direction: "forward" }]],
		columns: [[{ propertyId: owner.id, direction: "forward" }, { propertyId: person!.properties[0]!.id, direction: "forward" }]],
	});
	await store.saved();

	const result = await call("run_analysis", { analysis: "tasks by owner" });
	assert.deepEqual(result.groupedBy, ["Owner"]);
	assert.deepEqual(result.columns, ["Owner › Role"]);
	assert.equal(result.count, 1);
	assert.deepEqual(result.groups, [{ value: "Ada", count: 1, rows: [{ entity: { id: result.groups[0].rows[0].entity.id, name: "Write the spec" }, cells: [["Lead"]] }] }]);
});
