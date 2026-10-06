import type { AppData, Board, CanvasCard, Drawing, Entity, EntityType } from "./model.js";
import type { Viewport } from "./viewport.js";

/**
 * Whether two JSON-shaped values deeply agree, with records read key by key — their order doesn't matter,
 * the way two records of the same values are the same values. Everything the app saves is JSON-shaped,
 * so this one question says what a save has to carry per unit: units that answer it carry nothing at
 * all — they haven't changed.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
	}
	if (typeof a === "object" && typeof b === "object" && a !== null && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
		const keys = Object.keys(a);
		const other = b as Record<string, unknown>;
		return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(other, key) && jsonEqual((a as Record<string, unknown>)[key], other[key]));
	}
	return false;
}

/** A board itself — `name` and `viewport`, without its cards and drawings. The two are units of their own,
 * so someone panning a board and someone moving a card never address the same one. */
export interface BoardMeta {
	id: string;
	name: string;
	viewport: Viewport;
}

/** One unit's stand: the unit itself, the way the app's data holds it, and its place in the list it belongs
 * to (the types, the entities and the boards; the cards and drawings of one board). */
export interface UnitStand<T> {
	value: T;
	position: number;
}

/** One unit of the saved data, addressed by its id: what it was when this stand was last read or saved
 * (`before`, null when there was nothing there yet), and what it is now (`after`, null when it is gone). */
export type Change =
	| { kind: "type"; id: string; before: UnitStand<EntityType> | null; after: UnitStand<EntityType> | null }
	| { kind: "entity"; id: string; before: UnitStand<Entity> | null; after: UnitStand<Entity> | null }
	| { kind: "board"; id: string; before: UnitStand<BoardMeta> | null; after: UnitStand<BoardMeta> | null }
	| { kind: "card"; id: string; boardId: string; before: UnitStand<CanvasCard> | null; after: UnitStand<CanvasCard> | null }
	| { kind: "drawing"; id: string; boardId: string; before: UnitStand<Drawing> | null; after: UnitStand<Drawing> | null };

/** The units of one list, keyed by id: compared by id, never by the position they happen to sit at. */
function stands<T extends { id: string }>(items: readonly T[]): Map<string, UnitStand<T>> {
	return new Map(items.map((value, position) => [value.id, { value, position }] as const));
}

/** The boards themselves, as units. */
function boardStands(boards: readonly Board[]): Map<string, UnitStand<BoardMeta>> {
	return new Map(
		boards.map(({ id, name, viewport }, position) => [id, { value: { id, name, viewport }, position }] as const),
	);
}

/** One unit's stand, and the board it stands on (the tables' rows name their board, so a card or drawing
 * written anew says which). Card ids are unique across boards; the app never sits a card or drawing down
 * on another board, so `board` is taken from whichever of the two stands still has it. */
export interface Located<T> {
	board: string;
	stand: UnitStand<T>;
}

/** The cards or drawings of every board, keyed by their id (their ids are unique across boards). */
function located<T extends { id: string }>(boards: readonly Board[], items: (board: Board) => readonly T[]): Map<string, Located<T>> {
	const map = new Map<string, Located<T>>();
	for (const board of boards) {
		items(board).forEach((value, position) => {
			if (!map.has(value.id)) map.set(value.id, { board: board.id, stand: { value, position } });
		});
	}
	return map;
}

/** Whether both stands tell of the same unit — same place, same content. A unit that isn't there (on either
 * side) is a change, never the same one. This is the one comparison every stand is measured with, here
 * for building a change set and there (`apps/api`) for telling an untouched unit from a collided one, so
 * the two never drift apart.
 */
export function sameStand<T>(before: UnitStand<T> | null, after: UnitStand<T> | null): boolean {
	if (before === null || after === null) return false;
	return before.position === after.position && jsonEqual(before.value, after.value);
}

/** Every unit of one state with its place, by its id — for a writer that holds the state its tables read
 * (the answer of a read), to compare per unit with a change's `before`: what it says for the unit now is
 * what nobody else has touched, and what doesn't say so has been changed by someone else. */
export interface UnitStands {
	/** The types, by id. */
	types: Map<string, UnitStand<EntityType>>;
	/** The entities, by id. */
	entities: Map<string, UnitStand<Entity>>;
	/** The boards (name and viewport only), by id. */
	boards: Map<string, UnitStand<BoardMeta>>;
	/** The cards, by id, with the board they stand on. */
	cards: Map<string, Located<CanvasCard>>;
	/** The drawings, by id, with the board they stand on. */
	drawings: Map<string, Located<Drawing>>;
}

/** The units of a state with their places. */
export function unitStands(data: AppData): UnitStands {
	return {
		types: stands(data.types),
		entities: stands(data.entities),
		boards: boardStands(data.boards),
		cards: located(data.boards, (b) => b.cards),
		drawings: located(data.boards, (b) => b.drawings),
	};
}

/** Every id that either list names. */
function idsOf<T>(...lists: ReadonlyMap<string, T>[]): Set<string> {
	return new Set(lists.flatMap((list) => [...list.keys()]));
}

/** The ids whose stands differ between two lists — compared by id, never by the position they happen to sit
 * at, the stand on the last-read side (`before`) and the one on the other (`after`) handed to `make`, with
 * null where the id isn't on that side. */
function standChanges<T>(
	before: ReadonlyMap<string, UnitStand<T>>,
	after: ReadonlyMap<string, UnitStand<T>>,
	make: (id: string, before: UnitStand<T> | null, after: UnitStand<T> | null) => Change,
): Change[] {
	const changes: Change[] = [];
	for (const id of idsOf(before, after)) {
		const b = before.get(id) ?? null;
		const a = after.get(id) ?? null;
		if (sameStand(b, a)) continue;
		changes.push(make(id, b, a));
	}
	return changes;
}

/** The located siblings of `standChanges`: the cards and drawings of every board, named by their id and
 * the board they stand on. */
function locatedChanges<T>(
	before: ReadonlyMap<string, Located<T>>,
	after: ReadonlyMap<string, Located<T>>,
	make: (id: string, boardId: string, before: UnitStand<T> | null, after: UnitStand<T> | null) => Change,
): Change[] {
	return standChanges(
		new Map([...before].map(([id, l]) => [id, l.stand] as const)),
		new Map([...after].map(([id, l]) => [id, l.stand] as const)),
		(id, b, a) => make(id, (after.get(id) ?? before.get(id))!.board, b, a),
	);
}

/**
 * The units in which two states of the app's data differ, each with its last saved stand and its new one —
 * the change set a save writes per unit, so it never touches a row nobody changed here. Every unit is
 * addressed by its id, never by the position it happens to sit at, and each stand carries its `position`
 * — each list's own order, which SQL doesn't know on its own — so a unit that only moved in its list is
 * heard of too, and what is saved keeps its order without saving everything. The types come first, the
 * entities before the boards' cards and drawings, so parents are written before the children naming them.
 */
export function changesBetween(before: AppData, after: AppData): Change[] {
	const was = unitStands(before);
	const now = unitStands(after);
	return [
		...standChanges(was.types, now.types, (id, b, a) => ({ kind: "type", id, before: b, after: a })),
		...standChanges(was.entities, now.entities, (id, b, a) => ({ kind: "entity", id, before: b, after: a })),
		...standChanges(was.boards, now.boards, (id, b, a) => ({ kind: "board", id, before: b, after: a })),
		...locatedChanges(
			was.cards,
			now.cards,
			(id, boardId, b, a) => ({ kind: "card", id, boardId, before: b, after: a }),
		),
		...locatedChanges(
			was.drawings,
			now.drawings,
			(id, boardId, b, a) => ({ kind: "drawing", id, boardId, before: b, after: a }),
		),
	];
}
