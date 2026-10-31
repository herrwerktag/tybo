import "../../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../../../features.core.js";
import { memoryDataPort } from "../../../memory-port.js";
import { DATA_VERSION } from "../../../shared/core/index.js";
import { boardLinks, chainOf } from "./lines.js";

test("a card's chain is every card linked to it by lines, either way and through others", () => {
	const edges: [string, string][] = [
		["a", "b"],
		["c", "b"],
		["c", "d"],
		["x", "y"],
	];
	assert.deepEqual([...chainOf("a", edges)].sort(), ["a", "b", "c", "d"]);
	assert.deepEqual([...chainOf("y", edges)].sort(), ["x", "y"]);
	assert.deepEqual([...chainOf("alone", edges)], ["alone"]);
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
