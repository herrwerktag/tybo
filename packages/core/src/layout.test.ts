import assert from "node:assert/strict";
import { test } from "node:test";
import type { Rect } from "@tybo/app/core";
import { connector } from "./connectors.js";
import { layeredLayout } from "./layout.js";
import { DEFAULT_CARD_SIZE, type PropertyDef } from "./model.js";

/** A reference property `id` pointing at entities of `typeId`, several allowed. */
const points = (id: string, typeId: string): PropertyDef => ({
	id,
	name: id,
	kind: "reference",
	options: [],
	reference: { typeIds: [typeId], multiple: true, required: false, arrow: "to", lineLabel: "", inverseLabel: "" },
	cardDisplay: "line",
});

// Requirement → Component → Team, and a component can use other components.
const types = [
	{ id: "team", properties: [] },
	{ id: "component", properties: [points("owner", "team"), points("uses", "component")] },
	{ id: "requirement", properties: [points("in", "component")] },
];
const entity = (id: string, typeId: string, values: Record<string, string[]> = {}) => ({ id, typeId, values });

/** Whether the line the app draws from `from` to `to` runs through `card`. */
function runsThrough(from: Rect, to: Rect, card: Rect): boolean {
	const [x0, y0, x1, y1, x2, y2, x3, y3] = connector(from, to).path.match(/-?[\d.]+/g)!.map(Number) as [number, number, number, number, number, number, number, number];
	return Array.from({ length: 41 }, (_, i) => i / 40).some((t) => {
		const u = 1 - t;
		const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
		const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
		return x > card.x && x < card.x + card.width && y > card.y && y < card.y + card.height;
	});
}

/** Where each entity went, by id. */
const at = (placed: { entityId: string; x: number; y: number }[]) => new Map(placed.map((p) => [p.entityId, p]));

test("layeredLayout: columns in the direction of the references, a type's own references spreading its band", () => {
	const placed = at(
		layeredLayout(
			types,
			[
				entity("t1", "team"),
				entity("c1", "component", { owner: ["t1"] }),
				entity("c2", "component", { owner: ["t1"], uses: ["c1"] }),
				entity("r1", "requirement", { in: ["c2"] }),
			],
			{ x: 10, y: 13 },
		),
	);
	const step = DEFAULT_CARD_SIZE.width + 96;
	assert.deepEqual(["r1", "c2", "c1", "t1"].map((id) => placed.get(id)!.x), [0, step, 2 * step, 3 * step]);
	assert.equal(Math.min(...[...placed.values()].map((p) => p.y)), 24, "from the start, on the grid");
	for (const p of placed.values()) assert.equal(p.y % 24, 0);
});

test("layeredLayout: cards of a column are sorted so their lines don't cross, and don't overlap", () => {
	// Given crosswise: r1 → c2 and r2 → c1, with c1 above c2 to begin with.
	const placed = at(
		layeredLayout(
			types,
			[
				entity("c1", "component"),
				entity("c2", "component"),
				entity("c3", "component"),
				entity("r1", "requirement", { in: ["c2"] }),
				entity("r2", "requirement", { in: ["c1"] }),
				entity("r3", "requirement", { in: ["c3"] }),
			],
			{ x: 0, y: 0 },
		),
	);
	const y = (id: string) => placed.get(id)!.y;
	const target = { r1: "c2", r2: "c1", r3: "c3" } as const;
	for (const [a, b] of [["r1", "r2"], ["r1", "r3"], ["r2", "r3"]] as const) {
		assert.equal(Math.sign(y(a) - y(b)), Math.sign(y(target[a]) - y(target[b])), `${a} and ${b} in the order of their components`);
	}
	for (const column of [["c1", "c2", "c3"], ["r1", "r2", "r3"]]) {
		const tops = column.map(y).sort((a, b) => a - b);
		for (let i = 1; i < tops.length; i++) assert.ok(tops[i]! - tops[i - 1]! >= DEFAULT_CARD_SIZE.height + 48, `${column} apart`);
	}
	// Linked cards side by side are at the same height, so their line runs straight.
	assert.equal(y("r3"), y("c3"));
});

test("layeredLayout: a line spanning a column keeps a passage free there; loops and lone entities are placed too", () => {
	const placed = at(
		layeredLayout(
			types,
			[
				entity("t1", "team"),
				entity("c1", "component", { owner: ["t1"] }),
				entity("c2", "component", { owner: ["t1"], uses: ["c1"] }),
				entity("c3", "component", { uses: ["c4"] }),
				entity("c4", "component", { uses: ["c3"] }),
				entity("lone", "requirement"),
			],
			{ x: 0, y: 0 },
		),
	);
	assert.equal(placed.size, 6);
	// c2's line to t1 passes c1's column: c1 isn't in its way.
	const card = (id: string) => ({ ...placed.get(id)!, ...DEFAULT_CARD_SIZE });
	assert.equal(runsThrough(card("c2"), card("t1"), card("c1")), false);
	assert.notEqual(placed.get("c3")!.x, placed.get("c4")!.x, "a loop still goes left to right");
	assert.deepEqual(layeredLayout(types, [], { x: 0, y: 0 }), []);
});
