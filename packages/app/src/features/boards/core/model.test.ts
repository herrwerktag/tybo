import assert from "node:assert/strict";
import { test } from "node:test";
import { snapToGrid } from "../../../shared/core/index.js";
import { FRAME_ASPECT, frameInside, frameShape, placeAround, placeBeside } from "./model.js";

test("placeBeside puts a card right of the source, moved down past the cards in the way", () => {
	const source = { x: 0, y: 0, width: 240, height: 168 };
	const size = { width: 240, height: 168 };
	assert.deepEqual(placeBeside(source, [source], size), { x: 288, y: 0 });
	// A card in that place: below it, one grid step apart.
	assert.deepEqual(placeBeside(source, [source, { x: 288, y: 0, width: 240, height: 168 }], size), { x: 288, y: 192 });
	// Off the grid, the source still leads to a place on it.
	assert.deepEqual(placeBeside({ x: 10, y: 13, width: 240, height: 80 }, [], size), { x: 288, y: 24 });
});

test("placeAround stacks cards in a column on each side of the source, clear of the others and each other", () => {
	const source = { x: 0, y: 0, width: 240, height: 168 };
	const card = { width: 240, height: 168 };
	const narrow = { width: 168, height: 72 };
	assert.deepEqual(placeAround(source, [source], { right: [card, card], left: [narrow] }), {
		right: [
			{ x: 288, y: 0 },
			{ x: 288, y: 192 },
		],
		left: [{ x: -216, y: 0 }],
	});
	assert.deepEqual(placeAround(source, [source], { right: [], left: [] }), { right: [], left: [] });
});

test("snapToGrid rounds to the nearest grid line", () => {
	assert.deepEqual([0, 11, 13, 150, -13].map(snapToGrid), [0, 0, 24, 144, -24]);
});

test("frames have a screen's shape: frameShape keeps the width (at least the minimum), frameInside the largest fitting", () => {
	assert.equal(FRAME_ASPECT, 16 / 9);
	assert.deepEqual(frameShape({ x: 5, y: 6, width: 640, height: 999 }), { x: 5, y: 6, width: 640, height: 360 });
	assert.deepEqual(frameShape({ x: 0, y: 0, width: 10, height: 10 }), { x: 0, y: 0, width: 192, height: 108 });
	// A view taller than a screen: as wide, centered top to bottom; a wider one: as tall, centered across.
	assert.deepEqual(frameInside({ x: 0, y: 0, width: 800, height: 600 }), { x: 0, y: 75, width: 800, height: 450 });
	assert.deepEqual(frameInside({ x: 100, y: 0, width: 1600, height: 450 }), { x: 500, y: 0, width: 800, height: 450 });
});
