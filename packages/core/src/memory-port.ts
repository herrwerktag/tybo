import { jsonEqual, unitStands, type Change } from "./changes.js";
import type { AppData, Board } from "./model.js";
import type { DataPort, SavedChanges, WorkspaceInfo } from "./ports.js";

/** One workspace as the memory holds it: its data as saved (in whatever shape a test put there), and the
 * version it is at. */
interface Held {
	name: string;
	data: Record<string, unknown>;
	version: number;
}

/** The data port on workspaces held in memory — what the storage API does, without a server: for tests.
 * Change sets are applied unit by unit the way the API's tables apply them, and a unit whose `before` isn't
 * the stand held is reported as collided — written anyway, the last save wins.
 *
 * Besides the port, it lets a test look in and step in: what was saved (`saves`), how often a version was
 * asked for (`looks`), someone else saving (`saveElsewhere`), and calls that fail (`failing`). */
export function memoryDataPort(initial: Record<string, unknown> = {}) {
	const held = new Map<string, Held>(
		Object.entries(initial).map(([id, data]) => [id, { name: id, data: data as Record<string, unknown>, version: 1 }]),
	);
	const failing = { loads: false, saves: false, looks: false, workspaces: false };
	const saves: Change[][] = [];
	let looks = 0;

	const fail = (what: keyof typeof failing) => {
		if (failing[what]) throw new Error("the storage doesn't answer");
	};

	const port: DataPort = {
		async listWorkspaces(): Promise<WorkspaceInfo[]> {
			fail("workspaces");
			return [...held].map(([id, { name }]) => ({ id, name }));
		},
		async createWorkspace({ id, name }, dataVersion) {
			fail("workspaces");
			if (held.has(id)) throw new Error(`the workspace "${id}" is there already`);
			held.set(id, { name, data: { version: dataVersion, types: [], entities: [], boards: [] }, version: 0 });
		},
		async renameWorkspace(id, name) {
			fail("workspaces");
			const workspace = held.get(id);
			if (workspace) workspace.name = name;
		},
		async deleteWorkspace(id) {
			fail("workspaces");
			held.delete(id);
		},
		async load(id) {
			fail("loads");
			const workspace = held.get(id);
			return workspace ? { data: JSON.parse(JSON.stringify(workspace.data)), version: String(workspace.version) } : null;
		},
		async version(id) {
			looks++;
			fail("looks");
			const workspace = held.get(id);
			return workspace ? String(workspace.version) : null;
		},
		async saveChanges(id, changes): Promise<SavedChanges> {
			fail("saves");
			const workspace = held.get(id);
			if (!workspace) throw new Error(`there is no workspace "${id}"`);
			saves.push(JSON.parse(JSON.stringify(changes)));
			const current = asAppData(workspace.data);
			const stands = unitStands(current);
			const collided = changes.filter((unit) => !untouched(stands, unit)).map((unit) => unit.id);
			workspace.data = { ...workspace.data, ...applyChanges(current, changes) };
			workspace.version++;
			return { version: String(workspace.version), collided };
		},
	};

	return {
		port,
		/** Every change set saved, in order. */
		saves,
		/** How often the version was asked for. */
		looks: () => looks,
		/** Which kinds of call fail from now on. */
		failing,
		/** The workspace's data as it is held, or undefined when there is no such workspace. */
		data: (id: string) => held.get(id)?.data,
		/** The workspace's name as it is held. */
		name: (id: string) => held.get(id)?.name,
		/** Someone else saves the workspace (with `data`, or with nothing changed): its version moves on. */
		saveElsewhere(id: string, data?: Record<string, unknown>): void {
			const workspace = held.get(id)!;
			if (data) workspace.data = data;
			workspace.version++;
		},
	};
}

/** The held data with every list there, so its units can be compared and written — boards without their
 * lists get empty ones, the way the API's tables would answer them. */
function asAppData(data: Record<string, unknown>): AppData {
	const list = (value: unknown) => (Array.isArray(value) ? value : []);
	return {
		types: list(data.types),
		entities: list(data.entities),
		boards: list(data.boards).map((board: Partial<Board>) => ({ ...board, cards: list(board.cards), drawings: list(board.drawings) })),
	} as AppData;
}

/** Whether the unit's `before` is the stand held (or its absence, for a new one) — the API's very question. */
function untouched(stands: ReturnType<typeof unitStands>, unit: Change): boolean {
	const now =
		unit.kind === "type"
			? stands.types.get(unit.id)
			: unit.kind === "entity"
				? stands.entities.get(unit.id)
				: unit.kind === "board"
					? stands.boards.get(unit.id)
					: unit.kind === "card"
						? stands.cards.get(unit.id)?.stand
						: stands.drawings.get(unit.id)?.stand;
	if (unit.before === null) return now === undefined;
	return now !== undefined && now.position === unit.before.position && jsonEqual(now.value, unit.before.value);
}

/** A list's units by id, each with its place — what the tables' `position` columns hold. */
type Placed<T> = Map<string, { value: T; position: number }>;

const placed = <T extends { id: string }>(items: readonly T[]): Placed<T> =>
	new Map(items.map((value, position) => [value.id, { value, position }]));

/** The units in the order of their places. */
const ordered = <T>(units: Placed<T>): T[] => [...units.values()].sort((a, b) => a.position - b.position).map(({ value }) => value);

/** The data with the change set's units written into it — every other unit as it was, and what hung below a
 * unit that goes going with it, as the tables' references cascade. */
function applyChanges(data: AppData, changes: readonly Change[]): AppData {
	const types = placed(data.types);
	const entities = placed(data.entities);
	const boards = new Map(
		data.boards.map((board, position) => [
			board.id,
			{ board, position, cards: placed(board.cards), drawings: placed(board.drawings) },
		]),
	);
	const set = <T>(units: Placed<T>, id: string, after: { value: T; position: number } | null) =>
		after ? units.set(id, after) : units.delete(id);

	for (const unit of changes) {
		switch (unit.kind) {
			case "type":
				set(types, unit.id, unit.after);
				if (!unit.after) for (const [id, { value }] of entities) if (value.typeId === unit.id) entities.delete(id);
				break;
			case "entity":
				set(entities, unit.id, unit.after);
				break;
			case "board": {
				if (!unit.after) {
					boards.delete(unit.id);
					break;
				}
				const existing = boards.get(unit.id);
				boards.set(unit.id, {
					board: { ...unit.after.value, cards: [], drawings: [] },
					position: unit.after.position,
					cards: existing?.cards ?? new Map(),
					drawings: existing?.drawings ?? new Map(),
				});
				break;
			}
			case "card":
				for (const board of boards.values()) board.cards.delete(unit.id);
				if (unit.after) boards.get(unit.boardId)?.cards.set(unit.id, unit.after);
				break;
			case "drawing":
				for (const board of boards.values()) board.drawings.delete(unit.id);
				if (unit.after) boards.get(unit.boardId)?.drawings.set(unit.id, unit.after);
				break;
		}
	}
	// Cards of an entity that went go with it.
	for (const board of boards.values()) {
		for (const [id, { value }] of board.cards) if (!entities.has(value.entityId)) board.cards.delete(id);
	}

	return {
		types: ordered(types),
		entities: ordered(entities),
		boards: [...boards.values()]
			.sort((a, b) => a.position - b.position)
			.map(({ board, cards, drawings }) => ({ ...board, cards: ordered(cards), drawings: ordered(drawings) })),
	};
}
