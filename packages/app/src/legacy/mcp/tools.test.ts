import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "../core/index.js";
import { withPeople } from "./test-tools.js";

test("place_on_board makes the board and lays the entities out in columns along their references", async () => {
	const { storage, call } = await withPeople();
	const placed = await call("place_on_board", { board: "Overview", types: ["Person", "Task"] });
	assert.equal(placed.board.name, "Overview");
	assert.equal(placed.board.created, true);
	const at = (answer: { placed: { entity: string; x: number; y: number }[] }) => Object.fromEntries(answer.placed.map((p) => [p.entity, [p.x, p.y]]));
	// The task references its owner, so the people are right of it, one below the other.
	const { "Write the spec": spec, Ada: ada, Alan: alan } = at(placed);
	assert.ok(spec![0]! < ada![0]!, "the task left of the people");
	assert.deepEqual([alan![0], alan![1]! - ada![1]!], [ada![0], 216]);
	assert.deepEqual((await call("describe_workspace")).boards.map((b: { name: string; cards: number }) => [b.name, b.cards]), [
		["Board 1", 0],
		["Overview", 3],
	]);

	// Given x and y, a card moves there; the others on the board stay, and new ones go right of them.
	await call("create_entity", { type: "Person", name: "Grace" });
	const again = await call("place_on_board", { board: "overview", entities: [{ entity: "Ada", x: -500, y: 10 }, "Alan", "Grace"] });
	assert.equal(again.board.created, undefined);
	assert.deepEqual(at(again).Ada, [-504, 0], "on the grid");
	assert.deepEqual(again.kept, ["Alan"]);
	assert.ok(at(again).Grace![0]! > alan![0]!, "Grace right of what's there");
	const store = await createStore(storage.port, "Projekt");
	assert.equal(store.data.boards.find((b) => b.name === "Overview")!.cards.length, 4, "Ada's card moved, not doubled");
});

test("place_on_board refuses what it can't place, saying why", async () => {
	const { refusal } = await withPeople();
	assert.match(await refusal("place_on_board", { board: "Overview" }), /Give `types` or `entities`/);
	assert.match(await refusal("place_on_board", { board: "Overview", entities: [{ entity: "Ada", x: 10 }] }), /needs both x and y/);
	assert.match(await refusal("place_on_board", { board: "Overview", entities: ["Grace"] }), /no entity "Grace"/);
	assert.match(await refusal("place_on_board", { board: " ", entities: ["Ada"] }), /needs a name/);
});
