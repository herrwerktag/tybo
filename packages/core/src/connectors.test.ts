import assert from "node:assert/strict";
import { test } from "node:test";
import { connector, facingSides, nearest } from "./connectors.js";

const box = (x: number, y: number) => ({ x, y, width: 100, height: 50 });

test("facingSides connects the sides that face each other", () => {
	assert.deepEqual(facingSides(box(0, 0), box(300, 20)), { fromSide: "right", toSide: "left" });
	assert.deepEqual(facingSides(box(300, 20), box(0, 0)), { fromSide: "left", toSide: "right" });
	assert.deepEqual(facingSides(box(0, 0), box(10, 200)), { fromSide: "bottom", toSide: "top" });
	assert.deepEqual(facingSides(box(10, 200), box(0, 0)), { fromSide: "top", toSide: "bottom" });
});

test("nearest picks the candidate with the closest center", () => {
	const far = { ...box(900, 0), id: "far" };
	const near = { ...box(200, 100), id: "near" };
	assert.equal(nearest(box(0, 0), [far, near])?.id, "near");
	assert.equal(nearest(box(0, 0), []), undefined);
});

test("connector runs from the source's right edge to just before the target's left edge, arrow touching it", () => {
	const c = connector(box(0, 0), box(300, 0));
	assert.match(c.path, /^M 100,25 C .* 290,25$/);
	assert.equal(c.arrow, "300,25 290,20 290,30");
	assert.deepEqual(c.mid, { x: 195, y: 25 });
});

test("connector without an arrow runs all the way to the target's edge", () => {
	const c = connector(box(0, 0), box(300, 0), false);
	assert.match(c.path, / 300,25$/);
	assert.equal(c.arrow, null);
});
