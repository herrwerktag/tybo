import assert from "node:assert/strict";
import { test } from "node:test";
import { NameTaken, freeName, nameTaken, refuseTakenName } from "./names.js";

const items = [
	{ id: "a", name: "Board 1" },
	{ id: "b", name: " board 3 " },
];

test("nameTaken ignores case and surrounding spaces, and the item itself", () => {
	assert.equal(nameTaken(items, "BOARD 1"), true);
	assert.equal(nameTaken(items, "Board 3"), true);
	assert.equal(nameTaken(items, "Board 1", "a"), false);
	assert.equal(nameTaken(items, "Board 2"), false);
});

test("freeName takes the first number no item has", () => {
	assert.equal(freeName(items, (n) => `Board ${n}`), "Board 2");
	assert.equal(freeName([], (n) => `Board ${n}`), "Board 1");
});

test("refuseTakenName throws a NameTaken naming the taken name", () => {
	assert.throws(() => refuseTakenName("board", items, "board 1"), (e) => e instanceof NameTaken && e.message === 'There is a board "board 1" already.');
	assert.doesNotThrow(() => refuseTakenName("board", items, "Board 1", "a"));
});
