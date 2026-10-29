/** The app's store on a port in memory, for its tests and the features'. */
import assert from "node:assert/strict";
import type { AppData, DraftProperty } from "./model.js";
import { memoryDataPort } from "./memory-port.js";
import { DATA_VERSION, createStore, type Store } from "./store.js";
import { REFERENCE_SCREEN } from "../../features/boards/core.js";
import { BOARD_LISTS } from "../../features.core.js";

/** Lets background saves finish and report how they went (a failed save flips `problems.saveFailed` only then). */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

/** The workspace the tests' stores open. */
export const WS = "ws";

/** The data port in memory, with the workspace WS already there — holding `saved` when given (as data stored
 * by whatever version of the app saved it), or nothing at all, the way a workspace starts. */
export function memoryStorage(saved: unknown = { version: DATA_VERSION, types: [], entities: [], boards: [] }) {
	return memoryDataPort({ [WS]: saved });
}

/** The store of the workspace WS, through the port in memory — once the saves on their way have landed, the
 * way another tab opening it a moment later would find them. */
export const open = async (storage: ReturnType<typeof memoryStorage>) => {
	await settle();
	return createStore(storage.port, WS);
};

/** The features' lists of a board with nothing in them (see `BoardList`). */
export const noLists = Object.fromEntries(BOARD_LISTS.map(({ key }) => [key, []]));

/** Checks for fresh data: no types or entities, and one empty default board. */
export function assertEmpty(data: AppData) {
	assert.deepEqual(data.types, []);
	assert.deepEqual(data.entities, []);
	assert.equal(data.boards.length, 1);
	assert.deepEqual({ ...data.boards[0], id: "" }, {
		id: "",
		name: "Board 1",
		cards: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		viewFrame: { x: 0, y: 0, ...REFERENCE_SCREEN },
		...noLists,
	});
}

/** The first board, which a fresh store always has. */
export const firstBoard = (store: Store) => store.data.boards[0]!;

export const titleDraft: DraftProperty = { name: "title", kind: "text", options: [], reference: null, cardDisplay: "list" };

/** The names of the boards the workspace WS holds in the storage. */
export const storedBoards = (storage: ReturnType<typeof memoryStorage>) =>
	(storage.data(WS)!.boards as { name: string }[]).map((b) => b.name);

export async function referenceSetup() {
	const store = await open(memoryStorage());
	const person = store.addType("Person", [], "");
	const tag = store.addType("Tag", [], "");
	const book = store.addType("Book", [
		{ name: "author", kind: "reference", options: [], reference: { typeIds: [person.id], multiple: false, required: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
		{ name: "tags", kind: "reference", options: [], reference: { typeIds: [tag.id], multiple: true, required: false, arrow: "to", lineLabel: "", inverseLabel: "" }, cardDisplay: "list" },
	], "");
	const [author, tags] = [book.properties[0]!, book.properties[1]!];
	const frank = store.addEntity(person.id, "Frank", "", {});
	const scifi = store.addEntity(tag.id, "Sci-fi", "", {});
	const classic = store.addEntity(tag.id, "Classic", "", {});
	const dune = store.addEntity(book.id, "Dune", "", { [author.id]: frank.id, [tags.id]: [scifi.id, classic.id] });
	return { store, person, tag, book, author, tags, frank, scifi, classic, dune };
}

export const valueOf = (store: Store, entityId: string, propId: string) => store.data.entities.find((e) => e.id === entityId)?.values[propId];

