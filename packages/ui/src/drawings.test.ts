import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_IMAGE_SIZE,
	MIN_BOX_SIZE,
	arrowGeometry,
	contentBounds,
	drawingBounds,
	eraseStroke,
	imageRect,
	moveDrawing,
	moveEndpoint,
	normalizeRect,
	resizeBox,
	resizeImage,
	simplifyStroke,
	streamline,
	strokePath,
} from "./drawings.js";
import type { BoxDrawing, ImageDrawing, PathDrawing, SymbolDrawing } from "@bekbon/core";

const box: BoxDrawing = { id: "b", kind: "rect", x: 100, y: 100, width: 200, height: 100, color: "#dcdcdc", text: "", textSize: "m" };
const image: ImageDrawing = { id: "i", kind: "image", x: 100, y: 100, width: 200, height: 100, src: "data:image/png;base64," };
const line: PathDrawing = { id: "l", kind: "line", points: [{ x: 0, y: 0 }, { x: 100, y: 50 }], color: "#4a4a4a" };

test("normalizeRect spans two corners in any drag direction", () => {
	assert.deepEqual(normalizeRect({ x: 50, y: 80 }, { x: 10, y: 20 }), { x: 10, y: 20, width: 40, height: 60 });
});

test("moveDrawing moves boxes and every point of paths", () => {
	assert.deepEqual(moveDrawing(box, 5, -10), { ...box, x: 105, y: 90 });
	assert.deepEqual(moveDrawing(image, 5, -10), { ...image, x: 105, y: 90 });
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

test("resizeImage keeps the aspect ratio and the opposite corner", () => {
	const at = (i: ImageDrawing) => [i.x, i.y, i.width, i.height];
	assert.deepEqual(at(resizeImage(image, "se", 100, 0)), [100, 100, 300, 150]);
	assert.deepEqual(at(resizeImage(image, "se", 0, 50)), [100, 100, 300, 150]);
	assert.deepEqual(at(resizeImage(image, "se", 100, -25)), [100, 100, 300, 150]); // the side dragged further decides
	assert.deepEqual(at(resizeImage(image, "nw", -100, 0)), [0, 50, 300, 150]);
	assert.deepEqual(at(resizeImage(image, "ne", -100, 0)), [100, 150, 100, 50]);
});

test("resizeImage never flips and keeps a minimum size", () => {
	const tiny = resizeImage(image, "se", -500, -500);
	assert.deepEqual([tiny.x, tiny.y, tiny.width, tiny.height], [100, 100, 2 * MIN_BOX_SIZE, MIN_BOX_SIZE]);
});

test("imageRect centers a new image, scaling large ones down", () => {
	assert.deepEqual(imageRect({ x: 0, y: 0 }, 100, 50), { x: -50, y: -25, width: 100, height: 50 });
	assert.deepEqual(imageRect({ x: 0, y: 0 }, 2 * MAX_IMAGE_SIZE, MAX_IMAGE_SIZE), {
		x: -MAX_IMAGE_SIZE / 2,
		y: -MAX_IMAGE_SIZE / 4,
		width: MAX_IMAGE_SIZE,
		height: MAX_IMAGE_SIZE / 2,
	});
});

test("moveEndpoint moves only the chosen end", () => {
	assert.deepEqual(moveEndpoint(line, 1, -100, 0).points, [{ x: 0, y: 0 }, { x: 0, y: 50 }]);
});

test("drawingBounds covers boxes and all path points", () => {
	assert.deepEqual(drawingBounds(box), { x: 100, y: 100, width: 200, height: 100 });
	assert.deepEqual(drawingBounds(image), { x: 100, y: 100, width: 200, height: 100 });
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

test("streamline moves part of the way to the pointer, evening out jitter", () => {
	assert.deepEqual(streamline({ x: 0, y: 0 }, { x: 10, y: -4 }), { x: 5, y: -2 });
	assert.deepEqual(streamline({ x: 0, y: 0 }, { x: 10, y: 0 }, 1), { x: 10, y: 0 });
});

test("eraseStroke cuts out what the eraser passes over, keeping the stroke's own points elsewhere", () => {
	const stroke = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }];
	// Through the middle of the long first segment: two pieces, cut where the eraser's reach ends.
	assert.deepEqual(eraseStroke(stroke, { x: 50, y: -20 }, { x: 50, y: 20 }, 10), [
		[{ x: 0, y: 0 }, { x: 35, y: 0 }],
		[{ x: 65, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }],
	]);
	// Rubbed over a whole end: only the rest is left.
	assert.deepEqual(eraseStroke(stroke, { x: 100, y: 60 }, { x: 100, y: 20 }, 5), [
		[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 12.5 }],
	]);
	assert.deepEqual(eraseStroke(stroke, { x: 0, y: 0 }, { x: 100, y: 50 }, 200), []);
	assert.equal(eraseStroke(stroke, { x: 50, y: 30 }, { x: 60, y: 30 }, 10), null);
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

test("placed library drawings move like boxes and resize keeping their aspect ratio, like images", () => {
	const symbol: SymbolDrawing = { id: "s", kind: "symbol", libraryId: "lib", x: 100, y: 100, width: 200, height: 100 };
	assert.deepEqual(moveDrawing(symbol, 5, -10), { ...symbol, x: 105, y: 90 });
	assert.deepEqual(resizeImage(symbol, "se", 100, 0), { ...symbol, width: 300, height: 150 });
	assert.deepEqual(drawingBounds(symbol), { x: 100, y: 100, width: 200, height: 100 });
});

test("contentBounds spans all drawings, or is null without any", () => {
	assert.equal(contentBounds([]), null);
	assert.deepEqual(contentBounds([box, line]), { x: 0, y: 0, width: 300, height: 200 });
});
