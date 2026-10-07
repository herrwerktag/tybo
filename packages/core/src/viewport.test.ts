import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ZOOM, MIN_ZOOM, screenToWorld, snapZoom, stepZoom, zoomAt } from "./viewport.js";

test("screenToWorld undoes pan and zoom", () => {
	assert.deepEqual(screenToWorld({ x: 100, y: 50, zoom: 2 }, 300, 250), { x: 100, y: 100 });
});

test("zoomAt keeps the point under the cursor in place", () => {
	const before = { x: 40, y: -20, zoom: 1 };
	const after = zoomAt(before, 1.5, 200, 120);
	assert.equal(after.zoom, 1.5);
	assert.deepEqual(screenToWorld(after, 200, 120), screenToWorld(before, 200, 120));
});

test("zoomAt clamps the zoom", () => {
	assert.equal(zoomAt({ x: 0, y: 0, zoom: 1 }, 10, 0, 0).zoom, MAX_ZOOM);
	assert.equal(zoomAt({ x: 0, y: 0, zoom: 1 }, 0.01, 0, 0).zoom, MIN_ZOOM);
});

test("snapZoom settles on the nearest 10% step, within the limits", () => {
	assert.equal(snapZoom(0.94), 0.9);
	assert.equal(snapZoom(1.26), 1.3);
	assert.equal(snapZoom(0.01), MIN_ZOOM);
	assert.equal(snapZoom(5), MAX_ZOOM);
});

test("stepZoom goes to the next 10% step, also from between two steps", () => {
	assert.equal(stepZoom(1, 1), 1.1);
	assert.equal(stepZoom(0.7, -1), 0.6);
	assert.equal(stepZoom(0.25, 1), 0.3);
	assert.equal(stepZoom(0.25, -1), 0.2);
	assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM);
	assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM);
});
