import type { AppData, CanvasCard, Drawing, Entity, EntityType } from "./model.js";
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

/** The kinds of unit, parents before the children naming them. */
export const CHANGE_KINDS: readonly Change["kind"][] = ["type", "entity", "board", "card", "drawing"];

/** One unit of a state: its address (kind, id, and the board a card or drawing stands on) and its stand. */
interface Unit {
	kind: Change["kind"];
	id: string;
	boardId?: string;
	stand: UnitStand<unknown>;
}

/** Every unit of a state, keyed by its kind and id — compared by id, never by the position it happens to sit
 * at. Card and drawing ids are unique across boards; the app never moves one to another board. */
export type UnitStands = Map<string, Unit>;

const unitKey = (kind: Change["kind"], id: string) => `${kind}:${id}`;

/** The units of a state with their places. Boards are units without their cards and drawings, so someone
 * panning a board and someone moving a card never address the same one. */
export function unitStands(data: AppData): UnitStands {
	const units: UnitStands = new Map();
	const add = (kind: Change["kind"], items: readonly { id: string }[], boardId?: string) =>
		items.forEach((value, position) => {
			const key = unitKey(kind, value.id);
			if (!units.has(key)) units.set(key, { kind, id: value.id, ...(boardId !== undefined && { boardId }), stand: { value, position } });
		});
	add("type", data.types);
	add("entity", data.entities);
	add("board", data.boards.map(({ id, name, viewport }): BoardMeta => ({ id, name, viewport })));
	for (const board of data.boards) add("card", board.cards, board.id);
	for (const board of data.boards) add("drawing", board.drawings, board.id);
	return units;
}

/** Whether both stands tell of the same unit — same place, same content. A unit that isn't there (on either
 * side) is a change, never the same one. */
function sameStand(before: UnitStand<unknown> | null, after: UnitStand<unknown> | null): boolean {
	if (before === null || after === null) return false;
	return before.position === after.position && jsonEqual(before.value, after.value);
}

/** Whether nobody else has touched the unit since the change's `before` was read: the stand held now is still
 * that one — or, for a new unit, nothing is there. The storage (the API's tables, the memory port) asks this
 * of every unit it is given, with the very comparison the change set was built with. */
export function untouched(stands: UnitStands, change: Change): boolean {
	const now = stands.get(unitKey(change.kind, change.id))?.stand ?? null;
	return change.before === null ? now === null : sameStand(change.before, now);
}

/**
 * The units in which two states of the app's data differ, each with its last saved stand and its new one —
 * the change set a save writes per unit, so it never touches a row nobody changed here. Every unit is
 * addressed by its id, never by the position it happens to sit at, and each stand carries its `position`
 * — each list's own order, which SQL doesn't know on its own — so a unit that only moved in its list is
 * heard of too, and what is saved keeps its order without saving everything. The changes come in the order
 * of CHANGE_KINDS, so parents are written before the children naming them.
 */
export function changesBetween(before: AppData, after: AppData): Change[] {
	const was = unitStands(before);
	const now = unitStands(after);
	const changes: Change[] = [];
	for (const key of new Set([...was.keys(), ...now.keys()])) {
		const b = was.get(key) ?? null;
		const a = now.get(key) ?? null;
		if (sameStand(b?.stand ?? null, a?.stand ?? null)) continue;
		const { kind, id, boardId } = (a ?? b)!;
		changes.push({ kind, id, ...(boardId !== undefined && { boardId }), before: b?.stand ?? null, after: a?.stand ?? null } as Change);
	}
	return changes.sort((x, y) => CHANGE_KINDS.indexOf(x.kind) - CHANGE_KINDS.indexOf(y.kind));
}
