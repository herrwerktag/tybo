import "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { el, listenWhileConnected, wheelGesture } from "./dom.js";

const wheel = (e: Partial<Parameters<typeof wheelGesture>[0]>) =>
	wheelGesture({ deltaMode: 0, deltaX: 0, deltaY: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...e });

test("a mouse wheel zooms one gentle step per notch, however far the notch scrolls", () => {
	assert.deepEqual(wheel({ deltaMode: 1, deltaY: 3 }), { zoom: 1 / 1.1 }); // by lines (Firefox)
	assert.deepEqual(wheel({ deltaY: -100, wheelDeltaY: 120 }), { zoom: 1.1 }); // by pixels, whole notches
	assert.deepEqual(wheel({ deltaY: 300, wheelDeltaY: -360, ctrlKey: true }), { zoom: 1 / 1.1 }); // Ctrl too
});

test("trackpad scrolling pans, a pinch zooms with the fingers, Shift + scroll pans sideways", () => {
	assert.deepEqual(wheel({ deltaX: 4, deltaY: 10, wheelDeltaY: -30 }), { pan: { dx: 4, dy: 10 } });
	assert.deepEqual(wheel({ deltaY: 40, wheelDeltaY: -120 }), { pan: { dx: 0, dy: 40 } }); // -3 × deltaY: a trackpad
	assert.deepEqual(wheel({ deltaY: 5, ctrlKey: true }), { zoom: Math.exp(-0.05) });
	assert.deepEqual(wheel({ deltaMode: 1, deltaY: 3, shiftKey: true }), { pan: { dx: 48, dy: 0 } });
});

test("a document listener is called while its node is on the page, and removes itself once it's gone", () => {
	const node = el("div");
	document.body.append(node);
	let calls = 0;
	listenWhileConnected(node, "keydown", () => calls++);
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
	node.remove();
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
	document.body.append(node); // back on the page: the listener is gone for good
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
	assert.equal(calls, 1);
});
