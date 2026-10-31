import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../../features.core.js";
import { withPeople } from "../../test-tools.js";
import { addAnalysis, updateAnalysis } from "./core.js";

test("analyses are made, changed and deleted with their paths named the way run_analysis writes them", async () => {
	const { call, refusal } = await withPeople();
	await call("create_entity", { type: "Task", name: "Test it", values: { Owner: "Alan" } });
	const { analysis } = await call("create_analysis", { name: "Tasks by role", type: "Task", groups: ["Owner › Role"], columns: [["Owner"]] });
	assert.deepEqual([analysis.type, analysis.groupedBy, analysis.columns], ["Task", ["Owner › Role"], ["Owner"]]);
	let result = await call("run_analysis", { analysis: "Tasks by role" });
	assert.deepEqual(result.groups.map((g: { value: string; count: number }) => [g.value, g.count]), [["Dev", 1], ["Lead", 1]]);

	// An inverse step by its label, or by Type.Property.
	await call("update_analysis", { analysis: "Tasks by role", name: "People", type: "Person", columns: ["owns", "Task.Owner"] });
	result = await call("run_analysis", { analysis: "people" });
	assert.deepEqual(result.groupedBy, []);
	assert.deepEqual(result.columns, ["owns", "owns"]);
	assert.deepEqual(result.rows.map((r: { cells: string[][] }) => r.cells[0]), [["Write the spec"], ["Test it"]]);
	assert.deepEqual((await call("describe_workspace")).analyses.map((a: { name: string }) => a.name), ["People"]);

	assert.match(await refusal("update_analysis", { analysis: "People", columns: ["Role › Name"] }), /"Role" is a text or options property/);
	assert.match(await refusal("update_analysis", { analysis: "People", columns: ["Boss"] }), /no step "Boss" here. Steps: Role, owns/);
	assert.match(await refusal("create_analysis", { name: "people", type: "Task" }), /There is an analysis "people" already/);
	assert.match(await refusal("delete_analysis", { analysis: "People", confirm: false }), /confirm: true/);
	await call("delete_analysis", { analysis: "People", confirm: true });
	assert.deepEqual((await call("describe_workspace")).analyses, []);
});

test("run_analysis shows at most `limit` rows, keeping the groups' counts whole", async () => {
	const { call } = await withPeople();
	await call("create_entities", { entities: ["A", "B", "C"].map((name) => ({ type: "Task", name, values: { Owner: "Alan" } })) });
	await call("create_analysis", { name: "By owner", type: "Task", groups: ["Owner"] });
	const result = await call("run_analysis", { analysis: "By owner", limit: 2 });
	assert.equal(result.count, 4);
	assert.deepEqual(result.groups.map((g: { value: string; count: number; rows: unknown[] }) => [g.value, g.count, g.rows.length]), [["Ada", 1, 1], ["Alan", 3, 1]]);
	assert.match(result.truncated, /first 2 rows/);
	assert.equal((await call("run_analysis", { analysis: "By owner" })).truncated, undefined);
});

test("run_analysis answers the analysis's groups and columns by name", async () => {
	const { storage, call } = await withPeople();
	const store = await createStore(storage.port, "Projekt");
	const [person, task] = store.data.types;
	const owner = task!.properties[0]!;
	const analysis = addAnalysis(store, "Tasks by owner");
	updateAnalysis(store, analysis.id, {
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
