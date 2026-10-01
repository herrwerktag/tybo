import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MIN_BOX_SIZE,
	arrowGeometry,
	drawingBounds,
	moveDrawing,
	moveEndpoint,
	normalizeRect,
	resizeBox,
	simplifyStroke,
	strokePath,
} from "./drawings.js";
import type { BoxDrawing, PathDrawing } from "./model.js";

const box: BoxDrawing = { id: "b", kind: "rect", x: 100, y: 100, width: 200, height: 100, color: "#dcdcdc", text: "", textSize: "m" };
const line: PathDrawing = { id: "l", kind: "line", points: [{ x: 0, y: 0 }, { x: 100, y: 50 }], color: "#4a4a4a" };

test("normalizeRect spans two corners in any drag direction", () => {
	assert.deepEqual(normalizeRect({ x: 50, y: 80 }, { x: 10, y: 20 }), { x: 10, y: 20, width: 40, height: 60 });
});

test("moveDrawing moves boxes and every point of paths", () => {
	assert.deepEqual(moveDrawing(box, 5, -10), { ...box, x: 105, y: 90 });
	assert.deepEqual(moveDrawing(line, 1, 2).points, [{ x: 1, y: 2 }, { x: 101, y: 52 }]);
});

test("resizeBox moves one corner and keeps the opposite one", () => {
	const at = (b: BoxDrawing) => [b.x, b.y, b.width, b.height];
	assert.deepEqual(at(resizeBox(box, "se", 20, 30)), [100, 100, 220, 130]);
	assert.deepEqual(at(resizeBox(box, "nw", 20, 30)), [120, 130, 180, 70]);
	assert.deepEqual(at(resizeBox(box, "ne", 10, -10)), [100, 90, 210, 110]);
	assert.deepEqual(at(resizeBox(box, "sw", -10, 10)), [90, 100, 210, 110]);
});

test("resizeBox flips past the opposite corner and keeps a minimum size", () => {
	const flipped = resizeBox(box, "se", -260, 0); // right edge dragged 60 past the left edge
	assert.deepEqual([flipped.x, flipped.width], [40, 60]);
	const tiny = resizeBox(box, "se", -199, -99);
	assert.deepEqual([tiny.x, tiny.y, tiny.width, tiny.height], [100, 100, MIN_BOX_SIZE, MIN_BOX_SIZE]);
});

test("moveEndpoint moves only the chosen end", () => {
	assert.deepEqual(moveEndpoint(line, 1, -100, 0).points, [{ x: 0, y: 0 }, { x: 0, y: 50 }]);
});

test("drawingBounds covers boxes and all path points", () => {
	assert.deepEqual(drawingBounds(box), { x: 100, y: 100, width: 200, height: 100 });
	const pen: PathDrawing = { ...line, kind: "pen", points: [{ x: 5, y: 9 }, { x: -3, y: 4 }, { x: 8, y: 1 }] };
	assert.deepEqual(drawingBounds(pen), { x: -3, y: 1, width: 11, height: 8 });
});

test("simplifyStroke drops points that are too close, keeping both ends", () => {
	const points = [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 3, y: 0 },
		{ x: 4, y: 0 },
		{ x: 4.5, y: 0 },
	];
	assert.deepEqual(simplifyStroke(points), [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 4.5, y: 0 }]);
});

test("strokePath draws straight segments, or a smoothed curve for pen strokes", () => {
	assert.equal(strokePath(line.points, false), "M 0,0 L 100,50");
	assert.equal(
		strokePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }], true),
		"M 0,0 Q 10,0 15,5 L 20,10",
	);
});

test("arrowGeometry ends the line at the arrowhead's base", () => {
	const { lineEnd, head } = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 });
	assert.deepEqual(lineEnd, { x: 88, y: 0 });
	assert.equal(head, "100,0 88,6 88,-6");
});
