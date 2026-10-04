import type { AppData, EntityType } from "./model.js";
import { DATA_VERSION, createStore, looksLikeAppData, toSaved, type Store } from "./store.js";
import type { StoragePort } from "./ports.js";
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

export const INDEX_KEY = "workspaces";
/** The first workspace keeps the key used before workspaces existed, so its data needs no migration. */
const DEFAULT_ID = "default";
const LEGACY_DATA_KEY = "entities-app";

export function dataKey(workspaceId: string): string {
	return workspaceId === DEFAULT_ID ? LEGACY_DATA_KEY : `${LEGACY_DATA_KEY}:${workspaceId}`;
}

/** Marks an exported workspace file. */
const EXPORT_FORMAT = "entities-app-workspace";

/** A workspace as a JSON file: its name and data, marked with the file format and its version (the data has its own). */
export function exportWorkspace(name: string, data: AppData): string {
	const file = { format: EXPORT_FORMAT, version: 1, name, exportedAt: new Date().toISOString(), data: toSaved(data) };
	return JSON.stringify(file, null, 2);
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

export type Workspaces = Awaited<ReturnType<typeof createWorkspaces>>;

/** The list of workspaces and which one is active; `defaultName(n)` names the n-th workspace when no name is given. */
export async function createWorkspaces(port: StoragePort, defaultName: (n: number) => string) {
	let index = await load();

	async function load(): Promise<WorkspaceIndex> {
		let raw: string | null = null;
		try {
			raw = await port.getItem(INDEX_KEY);
		} catch {
			// Unreadable list: start over with the default workspace, whose data is still under its old key.
		}
		try {
			const parsed: unknown = JSON.parse(raw ?? "null");
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
		void persistIndex();
	}

	/** Writes the workspace list; the in-memory list simply keeps working if that fails. */
	async function persistIndex(): Promise<void> {
		try {
			await port.setItem(INDEX_KEY, JSON.stringify(index));
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

	/** Takes the workspace's data off the port; if that fails, the data stays behind, unreachable. */
	async function clearData(id: string): Promise<void> {
		try {
			await port.removeItem(dataKey(id));
		} catch {
			// Storage blocked: the data stays behind, unreachable.
		}
	}

	return {
		get list(): readonly WorkspaceInfo[] {
			return index.workspaces;
		},

		get active(): WorkspaceInfo {
			return index.workspaces.find((w) => w.id === index.active) ?? index.workspaces[0]!;
		},

		/** Reads the list again after another tab changed it. This tab keeps its workspace unless it was deleted there. */
		async reload(): Promise<void> {
			const { active } = index;
			index = await load();
			if (index.workspaces.some((w) => w.id === active)) index = { ...index, active };
		},

		setActive(id: string): void {
			if (!index.workspaces.some((w) => w.id === id)) return;
			index = { ...index, active: id };
			save();
		},

		/** Adds a workspace, empty or starting with copies of the given entity types (no entities or boards). */
		async add(name: string, copyTypesFrom: readonly EntityType[] = []): Promise<WorkspaceInfo> {
			const workspace = newWorkspace(name);
			try {
				// The store fills in the rest (a default board, defaults for any missing fields) when it loads this.
				await port.setItem(dataKey(workspace.id), JSON.stringify({ version: DATA_VERSION, types: copyTypesFrom, entities: [], boards: [] }));
			} catch {
				// Storage blocked: the workspace starts empty.
			}
			return append(workspace);
		},

		/** Adds a workspace holding imported data. Null if it couldn't be stored (then nothing is added). */
		async addImported(name: string, data: unknown): Promise<WorkspaceInfo | null> {
			const workspace = newWorkspace(name);
			try {
				await port.setItem(dataKey(workspace.id), JSON.stringify(data));
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
			void clearData(id);
			save();
		},

		openStore(id: string): Promise<Store> {
			return createStore(port, dataKey(id));
		},
	};
}
