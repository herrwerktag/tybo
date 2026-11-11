import "../../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../../../features.core.js";
import { memoryDataPort } from "../../../memory-port.js";
import { DATA_VERSION } from "../../../shared/core/index.js";
import { boardLinks, chainSteps, type Edge } from "./lines.js";

test("a card's chain, both ways, is every card linked to it by lines, through others, with how many lines away", () => {
	const edges: Edge[] = [
		{ from: "a", to: "b", arrow: "to" },
		{ from: "c", to: "b", arrow: "to" },
		{ from: "c", to: "d", arrow: "to" },
		{ from: "x", to: "y", arrow: "to" },
	];
	assert.deepEqual([...chainSteps("a", edges, "both")], [["a", 0], ["b", 1], ["c", 2], ["d", 3]]);
	assert.deepEqual([...chainSteps("y", edges, "both")], [["y", 0], ["x", 1]]);
	assert.deepEqual([...chainSteps("alone", edges, "both")], [["alone", 0]]);
});

test("a chain one way follows the arrows as drawn, or goes against them; a line without an arrow goes either way", () => {
	// X references its source (the arrow at the source) and its target: the board shows source → X → target. Y → target too.
	const edges: Edge[] = [
		{ from: "x", to: "source", arrow: "from" },
		{ from: "x", to: "target", arrow: "to" },
		{ from: "y", to: "target", arrow: "to" },
	];
	assert.deepEqual([...chainSteps("source", edges, "forward")], [["source", 0], ["x", 1], ["target", 2]]);
	assert.deepEqual([...chainSteps("target", edges, "backward")], [["target", 0], ["x", 1], ["y", 1], ["source", 2]]);
	assert.deepEqual([...chainSteps("x", edges, "backward")], [["x", 0], ["source", 1]]);

	// a → b, then b – c without an arrow: against the arrows from b, c is in the chain as well as a.
	const loose: Edge[] = [
		{ from: "a", to: "b", arrow: "to" },
		{ from: "b", to: "c", arrow: "none" },
	];
	assert.deepEqual([...chainSteps("b", loose, "backward")], [["b", 0], ["a", 1], ["c", 1]]);
	assert.deepEqual([...chainSteps("b", loose, "forward")], [["b", 0], ["c", 1]]);
});

test("a board has a line per reference shown as a line, to every other card of the entity it names", async () => {
	const store = await createStore(memoryDataPort({ ws: { version: DATA_VERSION, types: [], entities: [], boards: [] } }).port, "ws");
	const person = store.addType("Person", [], "");
	const reference = { typeIds: [person.id], multiple: true, required: false, arrow: "from" as const, lineLabel: "", inverseLabel: "" };
	const book = store.addType("Book", [
		{ name: "author", kind: "reference", options: [], reference, cardDisplay: "line" },
		{ name: "editor", kind: "reference", options: [], reference: { ...reference, lineLabel: "edited" }, cardDisplay: "list" },
	], "");
	const ann = store.addEntity(person.id, "Ann", "", {});
	const bob = store.addEntity(person.id, "Bob", "", {});
	const [author, editor] = book.properties;
	const dune = store.addEntity(book.id, "Dune", "", { [author!.id]: [ann.id, bob.id], [editor!.id]: [ann.id] });
	const boardId = store.data.boards[0]!.id;
	const duneCard = store.addCard(boardId, dune.id, 0, 0);
	const ann1 = store.addCard(boardId, ann.id, 0, 0);
	const ann2 = store.addCard(boardId, ann.id, 0, 0);
	// Bob has no card here: no line to him; the editor shows in the list, not as a line.
	assert.deepEqual(boardLinks(store.data, store.data.boards[0]!), [
		{ fromCardId: duneCard.id, targetCardIds: [ann1.id, ann2.id], label: "author", fromColor: book.color, color: person.color, arrow: "from" },
	]);
});
