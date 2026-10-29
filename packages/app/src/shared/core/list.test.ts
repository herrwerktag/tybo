import assert from "node:assert/strict";
import { test } from "node:test";
import { moveItem } from "./list.js";

test("moveItem moves one item and leaves the input unchanged", () => {
	const items = ["a", "b", "c", "d"];
	assert.deepEqual(moveItem(items, 0, 2), ["b", "c", "a", "d"]);
	assert.deepEqual(moveItem(items, 3, 0), ["d", "a", "b", "c"]);
	assert.deepEqual(moveItem(items, 1, 1), items);
	assert.deepEqual(moveItem(items, 1, 99), ["a", "c", "d", "b"]);
	assert.deepEqual(items, ["a", "b", "c", "d"]);
});
