import assert from "node:assert/strict";
import { test } from "node:test";
import {
	TYPE_COLORS,
	cardRows,
	detailRows,
	filterEntities,
	inverseCardRows,
	inverseReferences,
	inverseRelations,
	migrateValues,
	moveItem,
	nextTypeColor,
	parseValue,
	snapToGrid,
	validateType,
	type PropertyDef,
} from "./model.js";

const noTypes = new Set<string>();
const noEntities = new Map<string, string>();

const title: PropertyDef = { id: "t", name: "title", kind: "text", options: [], reference: null, cardDisplay: "list" };
const status: PropertyDef = { id: "s", name: "status", kind: "options", options: ["Draft", "Published"], reference: null, cardDisplay: "list" };

test("parseValue: text trims and treats empty as null", () => {
	assert.equal(parseValue(title, "  hi  "), "hi");
	assert.equal(parseValue(title, "   "), null);
});

test("parseValue: options accepts listed options only", () => {
	assert.equal(parseValue(status, "Draft"), "Draft");
	assert.equal(parseValue(status, "Archived"), null);
	assert.equal(parseValue(status, ""), null);
});

test("validateType", () => {
	assert.deepEqual(validateType("Book", [title, status], noTypes), []);
	assert.ok(validateType(" ", [title], noTypes).length > 0);
	assert.deepEqual(validateType("Book", [], noTypes), []);
	assert.ok(validateType("Book", [{ ...title, name: "" }], noTypes).length > 0);
	assert.ok(validateType("Book", [title, { ...title, name: "Title " }], noTypes).length > 0);
});

test("validateType rejects the built-in field names", () => {
	assert.ok(validateType("Book", [{ ...title, name: "id" }], noTypes).length > 0);
	assert.ok(validateType("Book", [{ ...title, name: " Name " }], noTypes).length > 0);
	assert.ok(validateType("Book", [{ ...title, name: "content" }], noTypes).length > 0);
	assert.ok(validateType("Book", [{ ...title, name: "Description" }], noTypes).length > 0);
});

test("validateType: options properties need unique, non-empty options", () => {
	assert.ok(validateType("Book", [{ ...status, options: [] }], noTypes).length > 0);
	assert.ok(validateType("Book", [{ ...status, options: ["A", " "] }], noTypes).length > 0);
	assert.ok(validateType("Book", [{ ...status, options: ["A", "A"] }], noTypes).length > 0);
});

test("migrateValues drops removed properties and clears values that no longer fit", () => {
	const values = { t: "Dune", s: "Draft", gone: "x" };
	assert.deepEqual(migrateValues(values, [title, { ...status, options: ["Published"] }], noEntities), { t: "Dune", s: null });
});

test("migrateValues: text to options keeps values that match an option", () => {
	const asOptions: PropertyDef = { ...title, kind: "options", options: ["Dune"] };
	assert.deepEqual(migrateValues({ t: "Dune" }, [asOptions], noEntities), { t: "Dune" });
	assert.deepEqual(migrateValues({ t: "Emma" }, [asOptions], noEntities), { t: null });
});

const author: PropertyDef = { id: "a", name: "author", kind: "reference", options: [], reference: { typeId: "person", multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" };
const tags: PropertyDef = { id: "g", name: "tags", kind: "reference", options: [], reference: { typeId: "tag", multiple: true, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" };
const entityTypes = new Map([
	["p1", "person"],
	["p2", "person"],
	["t1", "tag"],
	["t2", "tag"],
]);

test("parseValue: single reference keeps one existing entity of the target type", () => {
	assert.equal(parseValue(author, "p1", entityTypes), "p1");
	assert.equal(parseValue(author, "t1", entityTypes), null);
	assert.equal(parseValue(author, "unknown", entityTypes), null);
	assert.equal(parseValue(author, "", entityTypes), null);
});

test("parseValue: multiple reference filters and dedupes; empty is null", () => {
	assert.deepEqual(parseValue(tags, ["t1", "p1", "t2", "t1", "gone"], entityTypes), ["t1", "t2"]);
	assert.equal(parseValue(tags, [], entityTypes), null);
	assert.equal(parseValue(tags, ["p1"], entityTypes), null);
});

test("parseValue: a list is not a valid text value", () => {
	assert.equal(parseValue(title, ["a"]), null);
});

test("migrateValues: single and multiple references convert into each other", () => {
	const asMultiple: PropertyDef = { ...author, reference: { typeId: "person", multiple: true, arrow: "to", lineLabel: "", inverseLabel: "" } };
	assert.deepEqual(migrateValues({ a: "p1" }, [asMultiple], entityTypes), { a: ["p1"] });
	const asSingle: PropertyDef = { ...tags, reference: { typeId: "tag", multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" } };
	assert.deepEqual(migrateValues({ g: ["t2", "t1"] }, [asSingle], entityTypes), { g: "t2" });
});

test("migrateValues: changing the target type clears references", () => {
	const toTag: PropertyDef = { ...author, reference: { typeId: "tag", multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" } };
	assert.deepEqual(migrateValues({ a: "p1" }, [toTag], entityTypes), { a: null });
});

test("validateType: a reference needs an existing target type", () => {
	assert.deepEqual(validateType("Book", [author], new Set(["person"])), []);
	assert.ok(validateType("Book", [author], noTypes).length > 0);
	assert.ok(validateType("Book", [{ ...author, reference: null }], new Set(["person"])).length > 0);
});

test("nextTypeColor picks the first unused palette color, then repeats", () => {
	const palette = TYPE_COLORS.map((c) => c.value);
	assert.equal(nextTypeColor([]), palette[0]);
	assert.equal(nextTypeColor([palette[0]!, palette[2]!]), palette[1]);
	assert.equal(nextTypeColor([palette[0]!.toUpperCase()]), palette[1]);
	assert.equal(nextTypeColor(palette), palette[0]);
	assert.equal(nextTypeColor([...palette, palette[0]!]), palette[1]);
});

test("moveItem moves one item and leaves the input unchanged", () => {
	const items = ["a", "b", "c", "d"];
	assert.deepEqual(moveItem(items, 0, 2), ["b", "c", "a", "d"]);
	assert.deepEqual(moveItem(items, 3, 0), ["d", "a", "b", "c"]);
	assert.deepEqual(moveItem(items, 1, 1), items);
	assert.deepEqual(moveItem(items, 1, 99), ["a", "c", "d", "b"]);
	assert.deepEqual(items, ["a", "b", "c", "d"]);
});

test("cardRows lists visible properties with a value, in order, with reference names", () => {
	const hidden: PropertyDef = { ...title, id: "h", name: "internal", cardDisplay: "hidden" };
	const type = { id: "book", name: "Book", properties: [title, hidden, status, author, tags], contentTemplate: "", color: "#dcdcdc" };
	const names = new Map([
		["p1", "Frank"],
		["t1", "Sci-fi"],
		["t2", "Classic"],
	]);
	const entity = {
		id: "e",
		typeId: "book",
		name: "Dune",
		content: "",
		description: "",
		values: { t: "Dune", h: "secret", s: null, a: "p1", g: ["t1", "gone", "t2"] },
	};
	assert.deepEqual(cardRows(type, entity, names), [
		{ label: "title", kind: "text", values: ["Dune"], entityIds: [], targetTypeId: null },
		{ label: "author", kind: "reference", values: ["Frank"], entityIds: ["p1"], targetTypeId: "person" },
		{ label: "tags", kind: "reference", values: ["Sci-fi", "Classic"], entityIds: ["t1", "t2"], targetTypeId: "tag" },
	]);
	assert.deepEqual(cardRows(type, { ...entity, values: { a: "gone" } }, names), []);
});

test("cardRows: line references are left out while their card is linked, listed otherwise", () => {
	const asLine: PropertyDef = { ...tags, cardDisplay: "line" };
	const type = { id: "book", name: "Book", properties: [asLine], contentTemplate: "", color: "#dcdcdc" };
	const names = new Map([
		["t1", "Sci-fi"],
		["t2", "Classic"],
	]);
	const entity = { id: "e", typeId: "book", name: "Dune", content: "", description: "", values: { g: ["t1", "t2"] } };
	assert.deepEqual(cardRows(type, entity, names, (id) => id === "t1"), [
		{ label: "tags", kind: "reference", values: ["Classic"], entityIds: ["t2"], targetTypeId: "tag" },
	]);
	assert.deepEqual(cardRows(type, entity, names, () => true), []);
	// Without board information nothing is linked, so everything is listed.
	assert.equal(cardRows(type, entity, names)[0]?.values.length, 2);
});

test("validateType reports problems as codes with the property label", () => {
	assert.deepEqual(validateType(" ", [{ ...title, name: "id" }, { ...title, name: "Title" }, { ...title, name: "title" }], noTypes), [
		{ code: "typeNameRequired" },
		{ code: "reservedName", label: "id" },
		{ code: "duplicateName", label: "title" },
	]);
	assert.deepEqual(validateType("Book", [{ ...status, options: [] }, author], noTypes), [
		{ code: "optionsRequired", label: "status" },
		{ code: "referenceTypeRequired", label: "author" },
	]);
});

test("filterEntities matches names ignoring case and accents, optionally by type", () => {
	const entities = [
		{ name: "Überprüfung", typeId: "activity" },
		{ name: "Incident gemeldet", typeId: "event" },
		{ name: "Deployment-Paket erstellen", typeId: "activity" },
	];
	const names = (query: string, typeId: string | null = null) =>
		filterEntities(entities, { query, typeId }).map((e) => e.name);

	assert.deepEqual(names(""), entities.map((e) => e.name));
	assert.deepEqual(names("uber"), ["Überprüfung"]);
	assert.deepEqual(names("  GEMELDET "), ["Incident gemeldet"]);
	assert.deepEqual(names("", "activity"), ["Überprüfung", "Deployment-Paket erstellen"]);
	assert.deepEqual(names("paket", "event"), []);
});

test("inverse references: who points at an entity, only for properties with an inverse label", () => {
	const ref = (id: string, name: string, inverseLabel: string): PropertyDef => ({
		id,
		name,
		kind: "reference",
		options: [],
		reference: { typeId: "role", multiple: false, arrow: "to", lineLabel: "", inverseLabel },
		cardDisplay: "list",
	});
	const responsible = ref("resp", "responsible", "responsible for");
	const reviewer = ref("rev", "reviewer", ""); // no inverse label: not shown on the role
	const types = [
		{ id: "role", name: "Role", properties: [], contentTemplate: "", color: "#c4dafa" },
		{ id: "activity", name: "Activity", properties: [responsible, reviewer], contentTemplate: "", color: "#c8ebbf" },
	];
	const entities = [
		{ id: "r1", typeId: "role", name: "Dev", content: "", description: "", values: {} },
		{ id: "a1", typeId: "activity", name: "Build", content: "", description: "", values: { resp: "r1", rev: "r1" } },
		{ id: "a2", typeId: "activity", name: "Ship", content: "", description: "", values: { resp: "r1" } },
		{ id: "a3", typeId: "activity", name: "Plan", content: "", description: "", values: { resp: null } },
	];
	const role = entities[0]!;
	const data = { types, entities };
	const names = new Map(entities.map((e) => [e.id, e.name]));

	assert.deepEqual(
		inverseRelations(types, "role").map((r) => [r.label, r.prop.id, r.sourceTypeId]),
		[["responsible for", "resp", "activity"]],
	);
	assert.deepEqual(
		inverseReferences(data, role).map((r) => [r.label, r.entityIds]),
		[["responsible for", ["a1", "a2"]]],
	);
	assert.deepEqual(inverseCardRows(data, role, names), [
		{ label: "responsible for", kind: "reference", values: ["Build", "Ship"], entityIds: ["a1", "a2"], targetTypeId: "activity" },
	]);

	// Drawn as a line: activities already connected on the board are left out of the row.
	const asLine = {
		types: [types[0]!, { ...types[1]!, properties: [{ ...responsible, cardDisplay: "line" as const }, reviewer] }],
		entities,
	};
	assert.deepEqual(inverseCardRows(asLine, role, names, (id) => id === "a1")[0]?.values, ["Ship"]);
	assert.deepEqual(inverseCardRows(asLine, role, names, () => true), []);
});

test("detailRows lists every property in order, empty ones too, then reverse references", () => {
	const hidden: PropertyDef = { ...title, id: "h", name: "internal", cardDisplay: "hidden" };
	const asLine: PropertyDef = { ...author, cardDisplay: "line" };
	const book = { id: "book", name: "Book", properties: [title, hidden, status, asLine], contentTemplate: "", color: "#dcdcdc" };
	const types = [book, { id: "person", name: "Person", properties: [], contentTemplate: "", color: "#c4dafa" }];
	const dune = { id: "e", typeId: "book", name: "Dune", content: "", description: "", values: { t: "Dune", h: "secret", a: "p1" } };
	const names = new Map([
		["e", "Dune"],
		["p1", "Frank"],
	]);
	assert.deepEqual(detailRows({ types, entities: [dune] }, dune, names), [
		{ label: "title", kind: "text", values: ["Dune"], entityIds: [], targetTypeId: null },
		{ label: "internal", kind: "text", values: ["secret"], entityIds: [], targetTypeId: null },
		{ label: "status", kind: "options", values: [], entityIds: [], targetTypeId: null },
		{ label: "author", kind: "reference", values: ["Frank"], entityIds: ["p1"], targetTypeId: "person" },
	]);
});

test("snapToGrid rounds to the nearest grid line", () => {
	assert.deepEqual([0, 11, 13, 150, -13].map(snapToGrid), [0, 0, 24, 144, -24]);
});
