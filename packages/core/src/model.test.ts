import assert from "node:assert/strict";
import { test } from "node:test";
import {
	FRAME_ASPECT,
	frameInside,
	frameShape,
	TYPE_COLORS,
	cardRows,
	detailRows,
	entityTags,
	filterEntities,
	filterLibrary,
	parseTags,
	inverseCardRows,
	inverseReferences,
	inverseRelations,
	migrateValues,
	moveItem,
	nextTypeColor,
	parseValue,
	linkCandidates,
	placeBeside,
	relationsOf,
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

const author: PropertyDef = { id: "a", name: "author", kind: "reference", options: [], reference: { typeIds: ["person"], multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" };
const tags: PropertyDef = { id: "g", name: "tags", kind: "reference", options: [], reference: { typeIds: ["tag"], multiple: true, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" };
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

test("parseValue: a reference to several types keeps entities of any of them", () => {
	const subject: PropertyDef = { ...tags, reference: { ...tags.reference!, typeIds: ["person", "tag"] } };
	assert.deepEqual(parseValue(subject, ["p1", "t1", "gone"], entityTypes), ["p1", "t1"]);
	assert.equal(parseValue({ ...author, reference: { ...author.reference!, typeIds: ["person", "tag"] } }, "t2", entityTypes), "t2");
});

test("parseValue: a list is not a valid text value", () => {
	assert.equal(parseValue(title, ["a"]), null);
});

test("migrateValues: single and multiple references convert into each other", () => {
	const asMultiple: PropertyDef = { ...author, reference: { typeIds: ["person"], multiple: true, arrow: "to", lineLabel: "", inverseLabel: "" } };
	assert.deepEqual(migrateValues({ a: "p1" }, [asMultiple], entityTypes), { a: ["p1"] });
	const asSingle: PropertyDef = { ...tags, reference: { typeIds: ["tag"], multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" } };
	assert.deepEqual(migrateValues({ g: ["t2", "t1"] }, [asSingle], entityTypes), { g: "t2" });
});

test("migrateValues: changing the target type clears references", () => {
	const toTag: PropertyDef = { ...author, reference: { typeIds: ["tag"], multiple: false, arrow: "to", lineLabel: "", inverseLabel: "" } };
	assert.deepEqual(migrateValues({ a: "p1" }, [toTag], entityTypes), { a: null });
});

test("validateType: a reference needs an existing target type", () => {
	assert.deepEqual(validateType("Book", [author], new Set(["person"])), []);
	assert.ok(validateType("Book", [author], noTypes).length > 0);
	assert.ok(validateType("Book", [{ ...author, reference: null }], new Set(["person"])).length > 0);
	const targets = (typeIds: string[]): PropertyDef => ({ ...author, reference: { ...author.reference!, typeIds } });
	assert.deepEqual(validateType("Book", [targets(["person", "tag"])], new Set(["person", "tag"])), []);
	assert.ok(validateType("Book", [targets([])], new Set(["person"])).length > 0);
	assert.ok(validateType("Book", [targets(["person", "gone"])], new Set(["person"])).length > 0);
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
		tags: [],
		values: { t: "Dune", h: "secret", s: null, a: "p1", g: ["t1", "gone", "t2"] },
	};
	assert.deepEqual(cardRows(type, entity, names), [
		{ label: "title", kind: "text", values: ["Dune"], entityIds: [] },
		{ label: "author", kind: "reference", values: ["Frank"], entityIds: ["p1"] },
		{ label: "tags", kind: "reference", values: ["Sci-fi", "Classic"], entityIds: ["t1", "t2"] },
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
	const entity = { id: "e", typeId: "book", name: "Dune", content: "", description: "", tags: [], values: { g: ["t1", "t2"] } };
	assert.deepEqual(cardRows(type, entity, names, (id) => id === "t1"), [
		{ label: "tags", kind: "reference", values: ["Classic"], entityIds: ["t2"] },
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

test("filterEntities matches names ignoring case and accents, optionally by type and by tag", () => {
	const entities = [
		{ name: "Überprüfung", typeId: "activity", tags: ["Release"] },
		{ name: "Incident gemeldet", typeId: "event", tags: [] },
		{ name: "Deployment-Paket erstellen", typeId: "activity", tags: ["release", "Ops"] },
	];
	const names = (query: string, typeId: string | null = null, tag: string | null = null) =>
		filterEntities(entities, { query, typeId, tag }).map((e) => e.name);

	assert.deepEqual(names(""), entities.map((e) => e.name));
	assert.deepEqual(names("uber"), ["Überprüfung"]);
	assert.deepEqual(names("  GEMELDET "), ["Incident gemeldet"]);
	assert.deepEqual(names("", "activity"), ["Überprüfung", "Deployment-Paket erstellen"]);
	assert.deepEqual(names("paket", "event"), []);
	assert.deepEqual(names("", null, "RELEASE"), ["Überprüfung", "Deployment-Paket erstellen"]);
	assert.deepEqual(names("", "activity", "Ops"), ["Deployment-Paket erstellen"]);
	assert.deepEqual(entityTags(entities), ["Ops", "Release"], "sorted, once each whatever the case");
});

test("inverse references: who points at an entity, only for properties with an inverse label", () => {
	const ref = (id: string, name: string, inverseLabel: string): PropertyDef => ({
		id,
		name,
		kind: "reference",
		options: [],
		reference: { typeIds: ["role"], multiple: false, arrow: "to", lineLabel: "", inverseLabel },
		cardDisplay: "list",
	});
	const responsible = ref("resp", "responsible", "responsible for");
	const reviewer = ref("rev", "reviewer", ""); // no inverse label: not shown on the role
	const types = [
		{ id: "role", name: "Role", properties: [], contentTemplate: "", color: "#c4dafa" },
		{ id: "activity", name: "Activity", properties: [responsible, reviewer], contentTemplate: "", color: "#c8ebbf" },
	];
	const entities = [
		{ id: "r1", typeId: "role", name: "Dev", content: "", description: "", tags: [], values: {} },
		{ id: "a1", typeId: "activity", name: "Build", content: "", description: "", tags: [], values: { resp: "r1", rev: "r1" } },
		{ id: "a2", typeId: "activity", name: "Ship", content: "", description: "", tags: [], values: { resp: "r1" } },
		{ id: "a3", typeId: "activity", name: "Plan", content: "", description: "", tags: [], values: { resp: null } },
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
		{ label: "responsible for", kind: "reference", values: ["Build", "Ship"], entityIds: ["a1", "a2"] },
	]);

	// Drawn as a line: activities already connected on the board are left out of the row.
	const asLine = {
		types: [types[0]!, { ...types[1]!, properties: [{ ...responsible, cardDisplay: "line" as const }, reviewer] }],
		entities,
	};
	assert.deepEqual(inverseCardRows(asLine, role, names, (id) => id === "a1")[0]?.values, ["Ship"]);
	assert.deepEqual(inverseCardRows(asLine, role, names, () => true), []);

	// A reference to several types shows its inverse label on each of them.
	const toBoth = [types[0]!, { ...types[1]!, properties: [{ ...responsible, reference: { ...responsible.reference!, typeIds: ["role", "activity"] } }] }];
	assert.deepEqual(inverseRelations(toBoth, "role").map((r) => r.prop.id), ["resp"]);
	assert.deepEqual(inverseRelations(toBoth, "activity").map((r) => r.prop.id), ["resp"]);
});

test("detailRows lists every property in order, empty ones too, then reverse references", () => {
	const hidden: PropertyDef = { ...title, id: "h", name: "internal", cardDisplay: "hidden" };
	const asLine: PropertyDef = { ...author, cardDisplay: "line" };
	const book = { id: "book", name: "Book", properties: [title, hidden, status, asLine], contentTemplate: "", color: "#dcdcdc" };
	const types = [book, { id: "person", name: "Person", properties: [], contentTemplate: "", color: "#c4dafa" }];
	const dune = { id: "e", typeId: "book", name: "Dune", content: "", description: "", tags: [], values: { t: "Dune", h: "secret", a: "p1" } };
	const names = new Map([
		["e", "Dune"],
		["p1", "Frank"],
	]);
	assert.deepEqual(detailRows({ types, entities: [dune] }, dune, names), [
		{ label: "title", kind: "text", values: ["Dune"], entityIds: [] },
		{ label: "internal", kind: "text", values: ["secret"], entityIds: [] },
		{ label: "status", kind: "options", values: [], entityIds: [] },
		{ label: "author", kind: "reference", values: ["Frank"], entityIds: ["p1"] },
	]);
});

test("placeBeside puts a card right of the source, moved down past the cards in the way", () => {
	const source = { x: 0, y: 0, width: 240, height: 168 };
	const size = { width: 240, height: 168 };
	assert.deepEqual(placeBeside(source, [source], size), { x: 288, y: 0 });
	// A card in that place: below it, one grid step apart.
	assert.deepEqual(placeBeside(source, [source, { x: 288, y: 0, width: 240, height: 168 }], size), { x: 288, y: 192 });
	// Off the grid, the source still leads to a place on it.
	assert.deepEqual(placeBeside({ x: 10, y: 13, width: 240, height: 80 }, [], size), { x: 288, y: 24 });
});

test("relationsOf: an entity's own references that can take one more, and every reference that can point at it", () => {
	const ref = (id: string, typeIds: string[], multiple: boolean, inverseLabel = ""): PropertyDef => ({
		id,
		name: id,
		kind: "reference",
		options: [],
		reference: { typeIds, multiple, arrow: "from", lineLabel: "", inverseLabel },
		cardDisplay: "line",
	});
	const idea = { id: "idea", name: "Idea", properties: [ref("related", ["idea"], true)], contentTemplate: "", color: "#dcdcdc" };
	const requirement = { id: "req", name: "Requirement", properties: [ref("source", ["idea"], false, "results in")], contentTemplate: "", color: "#dcdcdc" };
	const types = [idea, requirement];
	const spark = { id: "i1", typeId: "idea", name: "Spark", content: "", description: "", tags: [], values: {} };
	const other = { ...spark, id: "i2", name: "Other" };
	const sourced = { id: "r1", typeId: "req", name: "Sourced", content: "", description: "", tags: [], values: { source: "i2" } };
	const open = { ...sourced, id: "r2", name: "Open", values: {} };

	const relations = relationsOf(types, spark);
	assert.deepEqual(
		relations.map((r) => [r.prop.id, r.direction, r.typeId]),
		[["related", "forward", "idea"], ["related", "inverse", "idea"], ["source", "inverse", "req"]],
	);
	// A requirement from an idea: only those whose single source is still empty.
	assert.deepEqual(linkCandidates([spark, other, sourced, open], spark, relations[2]!).map((e) => e.name), ["Open"]);
	assert.deepEqual(linkCandidates([spark, other, sourced, open], spark, relations[0]!).map((e) => e.name), ["Other"]);
	// A requirement whose single source is set: nothing left (no type references requirements).
	assert.deepEqual(relationsOf(types, sourced).map((r) => r.prop.id), []);
});

test("snapToGrid rounds to the nearest grid line", () => {
	assert.deepEqual([0, 11, 13, 150, -13].map(snapToGrid), [0, 0, 24, 144, -24]);
});

test("parseTags splits at commas, trims, and drops empty tags and duplicates ignoring case", () => {
	assert.deepEqual(parseTags(" Sky, sky ,, Shape,Über "), ["Sky", "Shape", "Über"]);
	assert.deepEqual(parseTags(""), []);
});

test("filterLibrary matches names and tags ignoring case and accents", () => {
	const items = [
		{ name: "Sun", tags: ["Sky"] },
		{ name: "Tree", tags: ["Natur", "Grün"] },
	];
	const names = (query: string) => filterLibrary(items, query).map((item) => item.name);
	assert.deepEqual(names(""), ["Sun", "Tree"]);
	assert.deepEqual(names("sky"), ["Sun"]);
	assert.deepEqual(names("grun"), ["Tree"]);
	assert.deepEqual(names("TRE"), ["Tree"]);
});

test("frames have a screen's shape: frameShape keeps the width (at least the minimum), frameInside the largest fitting", () => {
	assert.equal(FRAME_ASPECT, 16 / 9);
	assert.deepEqual(frameShape({ x: 5, y: 6, width: 640, height: 999 }), { x: 5, y: 6, width: 640, height: 360 });
	assert.deepEqual(frameShape({ x: 0, y: 0, width: 10, height: 10 }), { x: 0, y: 0, width: 192, height: 108 });
	// A view taller than a screen: as wide, centered top to bottom; a wider one: as tall, centered across.
	assert.deepEqual(frameInside({ x: 0, y: 0, width: 800, height: 600 }), { x: 0, y: 75, width: 800, height: 450 });
	assert.deepEqual(frameInside({ x: 100, y: 0, width: 1600, height: 450 }), { x: 500, y: 0, width: 800, height: 450 });
});
