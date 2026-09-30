import assert from "node:assert/strict";
import { test } from "node:test";
import { TYPE_COLORS, migrateValues, moveItem, nextTypeColor, parseValue, validateType, type PropertyDef } from "./model.js";

const noTypes = new Set<string>();
const noEntities = new Map<string, string>();

const title: PropertyDef = { id: "t", name: "title", kind: "text", options: [], reference: null };
const status: PropertyDef = { id: "s", name: "status", kind: "options", options: ["Draft", "Published"], reference: null };

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

const author: PropertyDef = { id: "a", name: "author", kind: "reference", options: [], reference: { typeId: "person", multiple: false } };
const tags: PropertyDef = { id: "g", name: "tags", kind: "reference", options: [], reference: { typeId: "tag", multiple: true } };
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
	const asMultiple = { ...author, reference: { typeId: "person", multiple: true } };
	assert.deepEqual(migrateValues({ a: "p1" }, [asMultiple], entityTypes), { a: ["p1"] });
	const asSingle = { ...tags, reference: { typeId: "tag", multiple: false } };
	assert.deepEqual(migrateValues({ g: ["t2", "t1"] }, [asSingle], entityTypes), { g: "t2" });
});

test("migrateValues: changing the target type clears references", () => {
	const toTag = { ...author, reference: { typeId: "tag", multiple: false } };
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
