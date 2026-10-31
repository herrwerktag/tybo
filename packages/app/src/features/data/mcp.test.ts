import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../../features.core.js";
import { withPeople } from "../../test-tools.js";

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

	await call("update_type", { type: "Person", properties: [{ name: "Mentor" }], confirm: true });
	assert.deepEqual((await call("get_entity", { entity: "Ada" })).values, {});
});

test("a type gets its color, and a reference its arrow and line label, as the type form gives them", async () => {
	const { call, refusal, storage } = await withPeople();
	const { type } = await call("create_type", {
		name: "Review",
		color: "teal",
		properties: [{ name: "Reviews", kind: "reference", targets: ["Task"], cardDisplay: "line", arrow: "from", lineLabel: "checks" }],
	});
	assert.equal(type.color, "Teal");
	assert.deepEqual(type.properties[0], {
		id: type.properties[0].id,
		name: "Reviews",
		kind: "reference",
		targets: ["Task"],
		multiple: false,
		required: false,
		inverseLabel: "",
		arrow: "from",
		lineLabel: "checks",
		cardDisplay: "line",
	});
	const store = await createStore(storage.port, "Projekt");
	assert.equal(store.data.types[2]!.color, "#b9e4df");
	assert.equal(store.data.types[2]!.properties[0]!.reference?.arrow, "from");

	// Changing the color and the arrow leaves the rest as it is.
	const changed = (await call("update_type", { type: "Review", color: "Pink", properties: [{ name: "Reviews", arrow: "none" }] })).type;
	assert.equal(changed.color, "Pink");
	assert.deepEqual(
		[changed.properties[0].arrow, changed.properties[0].lineLabel, changed.properties[0].cardDisplay, changed.properties[0].targets],
		["none", "checks", "line", ["Task"]],
	);
	const described = await call("describe_workspace");
	assert.equal(described.types[2].color, "Pink");

	assert.match(await refusal("update_type", { type: "Review", color: "#ff0000" }), /isn't a color. Colors: Red, Orange/);
	assert.match(await refusal("update_type", { type: "Review", properties: [{ name: "Reviews", arrow: "both" }] }), /arrow is one of to, from, none/);
	assert.match(await refusal("update_type", { type: "Review", name: " task " }), /There is a type "task" already/);
});

test("update_type removes properties only with confirm, saying what would go", async () => {
	const { call, refusal, storage } = await withPeople();
	const saves = storage.saves.length;
	assert.match(
		await refusal("update_type", { type: "Person", properties: [{ name: "Nickname", kind: "text" }] }),
		/removes "Role" from Person, with the values of 2 entities.*confirm: true/,
	);
	assert.equal(storage.saves.length, saves);
	// Renaming the type or changing its template leaves the properties alone, and needs no confirm.
	await call("update_type", { type: "Person", name: "Human" });
	assert.equal((await call("get_entity", { entity: "Ada" })).values.Role, "Lead");
});

test("create_entities creates all in one save, references naming entities of the same call", async () => {
	const { call, storage } = await withPeople();
	const saves = storage.saves.length;
	const { created } = await call("create_entities", {
		entities: [
			{ type: "Task", name: "Deploy", values: { Owner: "Grace" } },
			{ type: "Person", name: "Grace", values: { Role: "Dev" }, tags: ["new"] },
			{ type: "Task", name: "Plan" },
		],
	});
	assert.deepEqual(created.map((e: { name: string }) => e.name), ["Deploy", "Grace", "Plan"]);
	assert.equal(storage.saves.length, saves + 1);
	const deploy = await call("get_entity", { entity: "Deploy" });
	assert.deepEqual(deploy.values.Owner, [{ id: created[1].id, name: "Grace" }]);
});

test("create_entities creates none when one doesn't fit, saying which", async () => {
	const { refusal, storage, call } = await withPeople();
	const saves = storage.saves.length;
	const message = await refusal("create_entities", {
		entities: [
			{ type: "Person", name: "Grace" },
			{ type: "Person", name: "Linus", values: { Role: "CEO" } },
		],
	});
	assert.match(message, /^entities\[1\] \("Linus"\): "CEO" isn't an option of Role/);
	assert.match(await refusal("create_entities", { entities: [{ type: "Robot", name: "R2" }] }), /^entities\[0\] \("R2"\): There is no type "Robot"/);
	assert.equal(storage.saves.length, saves);
	assert.equal((await call("find_entities", { type: "Person" })).total, 2);
});

test("find_entities with missing: true lists the entities lacking a required reference", async () => {
	const { call } = await withPeople();
	await call("update_type", { type: "Task", properties: [{ name: "Owner", required: true }] });
	await call("create_entity", { type: "Task", name: "Review" });
	const found = await call("find_entities", { missing: true });
	assert.deepEqual(found.entities.map((e: { name: string; missing: string[] }) => [e.name, e.missing]), [["Review", ["Owner"]]]);
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
