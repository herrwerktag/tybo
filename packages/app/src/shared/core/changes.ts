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

/** One unit's stand: the unit itself, the way the app's data holds it, and its place in the list it belongs
 * to (the types, the entities, the analyses and the boards; the cards and drawings of one board). */
export interface UnitStand<T> {
	value: T;
	position: number;
}

/** One unit of the saved data, addressed by its kind and id (and the board it stands on, for the kinds that
 * stand on one): what it was when this stand was last read or saved (`before`, null when there was nothing
 * there yet), and what it is now (`after`, null when it is gone). */
export interface Change<T = unknown> {
	kind: string;
	id: string;
	boardId?: string;
	before: UnitStand<T> | null;
	after: UnitStand<T> | null;
}

/** One list a kind's units sit in: the kind's only one, or one board's. */
export interface UnitList<T> {
	items: readonly T[];
	boardId?: string;
}

/**
 * A kind of unit of the saved data — the pieces a save is made of, each written on its own (a type, an entity,
 * a card …). Each feature names its own; the order of the kinds is the order they are written in, parents before
 * the children naming them.
 */
export interface UnitKind<D, T extends { id: string } = { id: string }> {
	kind: string;
	/** Whether its units stand on a board, their address naming it. */
	onBoard?: boolean;
	/** Its units in a state, list by list. */
	lists(data: D): readonly UnitList<T>[];
	/** The state with one of its lists replaced: the only one, or the board's. */
	withList(data: D, items: T[], boardId?: string): D;
	/** The state put right after a change set was written into it, the way the tables' references do it: what
	 * hangs below a unit that went goes with it, a new parent's lists start empty. */
	settle?(data: D): D;
}

/** One unit of a state: its address (kind, id, and the board a card or drawing stands on) and its stand. */
interface Unit {
	kind: string;
	id: string;
	boardId?: string;
	stand: UnitStand<unknown>;
}

/** Every unit of a state, keyed by its kind and id — compared by id, never by the position it happens to sit
 * at. Card and drawing ids are unique across boards; the app never moves one to another board. */
export type UnitStands = Map<string, Unit>;

export const unitKey = (kind: string, id: string) => `${kind}:${id}`;

/** The units of a state with their places, kind by kind. */
export function unitStandsOf<D>(kinds: readonly UnitKind<D>[], data: D): UnitStands {
	const units: UnitStands = new Map();
	for (const { kind, lists } of kinds) {
		for (const { items, boardId } of lists(data)) {
			items.forEach((value, position) => {
				const key = unitKey(kind, value.id);
				if (!units.has(key)) units.set(key, { kind, id: value.id, ...(boardId !== undefined && { boardId }), stand: { value, position } });
			});
		}
	}
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

/** The changes in the order of the kinds, so parents are written before the children naming them; a stable
 * sort keeps each kind's units in the order they came. */
export function inKindOrder<C extends Change>(kinds: readonly { kind: string }[], changes: readonly C[]): C[] {
	const order = kinds.map(({ kind }) => kind);
	return [...changes].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/**
 * The units in which two states of the app's data differ, each with its last saved stand and its new one —
 * the change set a save writes per unit, so it never touches a row nobody changed here. Every unit is
 * addressed by its id, never by the position it happens to sit at, and each stand carries its `position`
 * — each list's own order, which SQL doesn't know on its own — so a unit that only moved in its list is
 * heard of too, and what is saved keeps its order without saving everything. The changes come in the order
 * of the kinds, so parents are written before the children naming them.
 */
export function changesOf<D>(kinds: readonly UnitKind<D>[], before: D, after: D): Change[] {
	const was = unitStandsOf(kinds, before);
	const now = unitStandsOf(kinds, after);
	const changes: Change[] = [];
	for (const key of new Set([...was.keys(), ...now.keys()])) {
		const b = was.get(key) ?? null;
		const a = now.get(key) ?? null;
		if (sameStand(b?.stand ?? null, a?.stand ?? null)) continue;
		const { kind, id, boardId } = (a ?? b)!;
		changes.push({ kind, id, ...(boardId !== undefined && { boardId }), before: b?.stand ?? null, after: a?.stand ?? null });
	}
	return inKindOrder(kinds, changes);
}

/** The state with the change set's units written into it — every other unit as it was, and what hung below a
 * unit that went going with it (see `settle`). What the tables do with a change set, for the memory port. */
export function withChanges<D>(kinds: readonly UnitKind<D>[], data: D, changes: readonly Change[]): D {
	// Kind by kind, parents first, so a card finds the board written just before it.
	for (const kind of kinds) {
		const own = changes.filter((unit) => unit.kind === kind.kind);
		if (own.length === 0) continue;
		// Each list's units by id, each with its place — what the tables' `position` columns hold.
		const lists = kind.lists(data).map(({ items, boardId }) => ({
			boardId,
			units: new Map(items.map((value, position) => [value.id, { value, position }])),
		}));
		for (const unit of own) {
			for (const list of lists) list.units.delete(unit.id);
			if (unit.after === null) continue;
			// Its board isn't there: nowhere for it to stand.
			const list = kind.onBoard ? lists.find((l) => l.boardId === unit.boardId) : lists[0];
			list?.units.set(unit.id, unit.after as UnitStand<{ id: string }>);
		}
		for (const { boardId, units } of lists) {
			const ordered = [...units.values()].sort((a, b) => a.position - b.position).map(({ value }) => value);
			data = kind.withList(data, ordered, boardId);
		}
	}
	for (const kind of kinds) if (kind.settle) data = kind.settle(data);
	return data;
}
