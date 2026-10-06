import { changesBetween } from "./changes.js";
import type { AppData, EntityType } from "./model.js";
import { DATA_VERSION, createStore, looksLikeAppData, prepareImport, toSaved, type Store } from "./store.js";
import type { DataPort, WorkspaceInfo } from "./ports.js";
import { ulid } from "./ulid.js";

/** Where the active workspace is remembered — per browser, the way a view is: which one this tab opens. */
export interface ActiveWorkspacePreference {
	read(): string | null;
	write(id: string): void;
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

/** A workspace before its first save: nothing in it, not even a board. */
const NOTHING: AppData = { types: [], entities: [], boards: [] };

/**
 * The list of workspaces and which one is active; `defaultName(n)` names the n-th workspace when no name is
 * given. With no workspace there yet, the first one is made. Rejects when the storage can't list them (or
 * make the first): without its list there is nothing the app could show.
 */
export async function createWorkspaces(port: DataPort, defaultName: (n: number) => string, preference: ActiveWorkspacePreference) {
	let list = await load();
	let active = pick(preference.read());

	async function load(): Promise<WorkspaceInfo[]> {
		const listed = await port.listWorkspaces();
		if (listed.length > 0) return listed;
		const first = { id: ulid(), name: defaultName(1) };
		await port.createWorkspace(first, DATA_VERSION);
		return [first];
	}

	/** The workspace of `id` if there is one, else the first. */
	function pick(id: string | null): string {
		return list.some((w) => w.id === id) ? id! : list[0]!.id;
	}

	function newWorkspace(name: string): WorkspaceInfo {
		return { id: ulid(), name: name.trim() || defaultName(list.length + 1) };
	}

	/** Makes the workspace in the storage, with `data` as its first save. Null when the storage refused. */
	async function make(workspace: WorkspaceInfo, data: AppData): Promise<WorkspaceInfo | null> {
		try {
			await port.createWorkspace(workspace, DATA_VERSION);
		} catch {
			return null;
		}
		const changes = changesBetween(NOTHING, data);
		if (changes.length > 0) {
			try {
				await port.saveChanges(workspace.id, changes);
			} catch {
				// The workspace is there, but its data didn't make it: it isn't kept half-filled.
				await port.deleteWorkspace(workspace.id).catch(() => {});
				return null;
			}
		}
		list = [...list, workspace];
		return workspace;
	}

	return {
		get list(): readonly WorkspaceInfo[] {
			return list;
		},

		get active(): WorkspaceInfo {
			return list.find((w) => w.id === active) ?? list[0]!;
		},

		/** Reads the list again after another tab or device changed it. This tab keeps its workspace unless it was
		 * deleted there. A list that can't be read leaves this one as it is. */
		async reload(): Promise<void> {
			try {
				list = await load();
			} catch {
				return;
			}
			active = pick(active);
		},

		setActive(id: string): void {
			if (!list.some((w) => w.id === id)) return;
			active = id;
			preference.write(id);
		},

		/** Adds a workspace, empty or starting with copies of the given entity types (no entities or boards).
		 * Null if it couldn't be made (then nothing is added). */
		add(name: string, copyTypesFrom: readonly EntityType[] = []): Promise<WorkspaceInfo | null> {
			// The store fills in the rest (a default board) when it loads this.
			return make(newWorkspace(name), { ...NOTHING, types: [...copyTypesFrom] });
		},

		/** Adds a workspace holding imported data. Null if the data can't be read, or the workspace couldn't be
		 * made (then nothing is added). */
		async addImported(name: string, data: unknown): Promise<WorkspaceInfo | null> {
			const prepared = prepareImport(data);
			return prepared ? make(newWorkspace(name), prepared) : null;
		},

		/** Renames a workspace; a rename the storage doesn't take is undone here at its next reload. */
		rename(id: string, name: string): void {
			if (name.trim() === "") return;
			list = list.map((w) => (w.id === id ? { ...w, name: name.trim() } : w));
			void port.renameWorkspace(id, name.trim()).catch(() => {});
		},

		/** Deletes a workspace and all its data. The last workspace can't be deleted. */
		remove(id: string): void {
			if (list.length <= 1 || !list.some((w) => w.id === id)) return;
			list = list.filter((w) => w.id !== id);
			if (active === id) active = list[0]!.id;
			void port.deleteWorkspace(id).catch(() => {});
		},

		openStore(id: string): Promise<Store> {
			return createStore(port, id);
		},
	};
}
