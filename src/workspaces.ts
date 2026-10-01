import type { AppData, EntityType } from "./model.js";
import { createStore, looksLikeAppData, type Store } from "./store.js";
import { ulid } from "./ulid.js";

/** A workspace: its own entity types, entities and boards, stored under its own key. */
export interface WorkspaceInfo {
	id: string;
	name: string;
}

interface WorkspaceIndex {
	workspaces: WorkspaceInfo[];
	active: string;
}

type WorkspaceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const INDEX_KEY = "workspaces";
/** The first workspace keeps the key used before workspaces existed, so its data needs no migration. */
const DEFAULT_ID = "default";
const LEGACY_DATA_KEY = "entities-app";

export function dataKey(workspaceId: string): string {
	return workspaceId === DEFAULT_ID ? LEGACY_DATA_KEY : `${LEGACY_DATA_KEY}:${workspaceId}`;
}

/** Marks an exported workspace file. */
const EXPORT_FORMAT = "entities-app-workspace";

/** A workspace as a JSON file: its name and data, marked with the format and its version. */
export function exportWorkspace(name: string, data: AppData): string {
	return JSON.stringify({ format: EXPORT_FORMAT, version: 1, name, exportedAt: new Date().toISOString(), data }, null, 2);
}

/**
 * Reads an exported workspace file, or plain saved data (e.g. a downloaded backup; it has no name). Null if it's
 * neither. The data is only checked for its outline; the store checks and repairs the rest when it loads it.
 */
export function readWorkspaceFile(text: string): { name: string | null; data: unknown } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const file = parsed as { format?: unknown; name?: unknown; data?: unknown } | null;
	if (file?.format === EXPORT_FORMAT) {
		return looksLikeAppData(file.data) ? { name: typeof file.name === "string" ? file.name : null, data: file.data } : null;
	}
	return looksLikeAppData(parsed) ? { name: null, data: parsed } : null;
}

export type Workspaces = ReturnType<typeof createWorkspaces>;

/** The list of workspaces and which one is active; `defaultName(n)` names the n-th workspace when no name is given. */
export function createWorkspaces(storage: WorkspaceStorage, defaultName: (n: number) => string) {
	let index = load();

	function load(): WorkspaceIndex {
		try {
			const parsed: unknown = JSON.parse(storage.getItem(INDEX_KEY) ?? "null");
			const list = (parsed as Partial<WorkspaceIndex> | null)?.workspaces;
			if (Array.isArray(list)) {
				const workspaces = list.filter(
					(w): w is WorkspaceInfo => typeof w?.id === "string" && typeof w?.name === "string",
				);
				if (workspaces.length > 0) {
					const active = (parsed as Partial<WorkspaceIndex>).active;
					return { workspaces, active: workspaces.some((w) => w.id === active) ? active! : workspaces[0]!.id };
				}
			}
		} catch {
			// Unreadable list: start over with the default workspace, whose data is still under its old key.
		}
		return { workspaces: [{ id: DEFAULT_ID, name: defaultName(1) }], active: DEFAULT_ID };
	}

	function save(): void {
		try {
			storage.setItem(INDEX_KEY, JSON.stringify(index));
		} catch {
			// Storage full or blocked: keep working in memory.
		}
	}

	save();

	function newWorkspace(name: string): WorkspaceInfo {
		return { id: ulid(), name: name.trim() || defaultName(index.workspaces.length + 1) };
	}

	function append(workspace: WorkspaceInfo): WorkspaceInfo {
		index = { ...index, workspaces: [...index.workspaces, workspace] };
		save();
		return workspace;
	}

	return {
		get list(): readonly WorkspaceInfo[] {
			return index.workspaces;
		},

		get active(): WorkspaceInfo {
			return index.workspaces.find((w) => w.id === index.active) ?? index.workspaces[0]!;
		},

		/** Reads the list again after another tab changed it. This tab keeps its workspace unless it was deleted there. */
		reload(): void {
			const { active } = index;
			index = load();
			if (index.workspaces.some((w) => w.id === active)) index = { ...index, active };
		},

		setActive(id: string): void {
			if (!index.workspaces.some((w) => w.id === id)) return;
			index = { ...index, active: id };
			save();
		},

		/** Adds a workspace, empty or starting with copies of the given entity types (no entities or boards). */
		add(name: string, copyTypesFrom: readonly EntityType[] = []): WorkspaceInfo {
			const workspace = newWorkspace(name);
			try {
				// The store fills in the rest (a default board, defaults for any missing fields) when it loads this.
				storage.setItem(dataKey(workspace.id), JSON.stringify({ types: copyTypesFrom, entities: [], boards: [] }));
			} catch {
				// Storage blocked: the workspace starts empty.
			}
			return append(workspace);
		},

		/** Adds a workspace holding imported data. Null if it couldn't be stored (then nothing is added). */
		addImported(name: string, data: unknown): WorkspaceInfo | null {
			const workspace = newWorkspace(name);
			try {
				storage.setItem(dataKey(workspace.id), JSON.stringify(data));
			} catch {
				return null; // storage full or blocked
			}
			return append(workspace);
		},

		rename(id: string, name: string): void {
			if (name.trim() === "") return;
			index = { ...index, workspaces: index.workspaces.map((w) => (w.id === id ? { ...w, name: name.trim() } : w)) };
			save();
		},

		/** Deletes a workspace and all its data. The last workspace can't be deleted. */
		remove(id: string): void {
			if (index.workspaces.length <= 1 || !index.workspaces.some((w) => w.id === id)) return;
			const workspaces = index.workspaces.filter((w) => w.id !== id);
			index = { workspaces, active: index.active === id ? workspaces[0]!.id : index.active };
			try {
				storage.removeItem(dataKey(id));
			} catch {
				// Storage blocked: the data stays behind, unreachable.
			}
			save();
		},

		openStore(id: string): Store {
			return createStore(storage, dataKey(id));
		},
	};
}
