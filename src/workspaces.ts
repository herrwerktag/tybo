import type { EntityType } from "./model.js";
import { createStore, type Store } from "./store.js";

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

const INDEX_KEY = "workspaces";
/** The first workspace keeps the key used before workspaces existed, so its data needs no migration. */
const DEFAULT_ID = "default";
const LEGACY_DATA_KEY = "entities-app";

export function dataKey(workspaceId: string): string {
	return workspaceId === DEFAULT_ID ? LEGACY_DATA_KEY : `${LEGACY_DATA_KEY}:${workspaceId}`;
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

	return {
		get list(): readonly WorkspaceInfo[] {
			return index.workspaces;
		},

		get active(): WorkspaceInfo {
			return index.workspaces.find((w) => w.id === index.active) ?? index.workspaces[0]!;
		},

		setActive(id: string): void {
			if (!index.workspaces.some((w) => w.id === id)) return;
			index = { ...index, active: id };
			save();
		},

		/** Adds a workspace, empty or starting with copies of the given entity types (no entities or boards). */
		add(name: string, copyTypesFrom: readonly EntityType[] = []): WorkspaceInfo {
			const workspace: WorkspaceInfo = {
				id: crypto.randomUUID(),
				name: name.trim() || defaultName(index.workspaces.length + 1),
			};
			try {
				// The store fills in the rest (a default board, defaults for any missing fields) when it loads this.
				storage.setItem(dataKey(workspace.id), JSON.stringify({ types: copyTypesFrom, entities: [], boards: [] }));
			} catch {
				// Storage blocked: the workspace starts empty.
			}
			index = { ...index, workspaces: [...index.workspaces, workspace] };
			save();
			return workspace;
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
