import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonEqual } from "./changes.js";

test("jsonEqual: equal in value whatever the records' key order is, different in anything else it might be", () => {
	assert.equal(jsonEqual({ a: 1, b: { c: [2, 3] } }, { b: { c: [2, 3] }, a: 1 }), true);
	assert.equal(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1, c: null }), false); // an extra key is a difference
	assert.equal(jsonEqual({ a: null }, { a: null, b: undefined }), false); // even a missing undefined one
	assert.equal(jsonEqual([1, 2, 3], [3, 2, 1]), false); // lists keep their order
	assert.equal(jsonEqual(0.1 + 0.2, 0.3), false); // numbers are compared as they are
	assert.equal(jsonEqual(null, null), true);
	assert.equal(jsonEqual("1", 1), false);
	assert.equal(jsonEqual(null, {}), false);
});
