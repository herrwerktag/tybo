import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_IMAGE_SIZE,
	MIN_BOX_SIZE,
	areaContents,
	drawingBounds,
	imageRect,
	moveDrawing,
	normalizeRect,
	resizeBox,
	resizeImage,
} from "./drawings.js";
import type { BoxDrawing, ImageDrawing } from "@tybo/core";

const box: BoxDrawing = { id: "b", kind: "textbox", x: 100, y: 100, width: 200, height: 100, color: "#dcdcdc", text: "", textSize: "m" };
const image: ImageDrawing = { id: "i", kind: "image", x: 100, y: 100, width: 200, height: 100, src: "data:image/png;base64," };
const small: BoxDrawing = { ...box, id: "l", x: 0, y: 0, width: 100, height: 50 };

test("normalizeRect spans two corners in any drag direction", () => {
	assert.deepEqual(normalizeRect({ x: 50, y: 80 }, { x: 10, y: 20 }), { x: 10, y: 20, width: 40, height: 60 });
});

test("moveDrawing moves boxes and images", () => {
	assert.deepEqual(moveDrawing(box, 5, -10), { ...box, x: 105, y: 90 });
	assert.deepEqual(moveDrawing(image, 5, -10), { ...image, x: 105, y: 90 });
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

test("drawingBounds is the box of boxes and images", () => {
	assert.deepEqual(drawingBounds(box), { x: 100, y: 100, width: 200, height: 100 });
	assert.deepEqual(drawingBounds(image), { x: 100, y: 100, width: 200, height: 100 });
});

test("areaContents finds the cards and drawings whose middle is in the area, nested areas included", () => {
	const area: BoxDrawing = { ...box, id: "a", kind: "area", x: 0, y: 0, width: 300, height: 200 };
	const nested: BoxDrawing = { ...box, id: "n", kind: "area", x: 20, y: 20, width: 100, height: 60 };
	const cards = [
		{ id: "in", x: 100, y: 100, width: 160, height: 80 }, // reaches out on the right, but its middle is inside
		{ id: "out", x: 250, y: 100, width: 160, height: 80 },
	];
	const contents = areaContents(area, cards, [area, nested, small, { ...image, x: 400 }]);
	assert.deepEqual([...contents.cardIds], ["in"]);
	assert.deepEqual([...contents.drawingIds], ["n", "l"], "not the area itself, nor the image outside it");
});
