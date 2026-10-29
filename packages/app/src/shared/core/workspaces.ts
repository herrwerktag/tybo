import { moveItem } from "./list.js";
import type { DataPort, WorkspaceInfo } from "./ports.js";
import type { DataFormat } from "./store.js";
import { ulid } from "./ulid.js";

/** Where the active workspace is remembered — per browser, the way a view is: which one this tab opens. */
export interface ActiveWorkspacePreference {
	read(): string | null;
	write(id: string): void;
}

/** Marks an exported workspace file. */
const EXPORT_FORMAT = "entities-app-workspace";

/** A workspace as a JSON file: its name and data, marked with the file format and its version (the data has its own). */
export function exportWorkspaceOf<D>(format: DataFormat<D>, name: string, data: D): string {
	const file = { format: EXPORT_FORMAT, version: 1, name, exportedAt: new Date().toISOString(), data: format.toSaved(data) };
	return JSON.stringify(file, null, 2);
}

/**
 * Reads an exported workspace file, or plain saved data (e.g. a downloaded backup; it has no name). Null if it's
 * neither. The data is only checked for its outline; the store checks and repairs the rest when it loads it.
 */
export function readWorkspaceFileOf(format: Pick<DataFormat<unknown>, "looksLike">, text: string): { name: string | null; data: unknown } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const file = parsed as { format?: unknown; name?: unknown; data?: unknown } | null;
	if (file?.format === EXPORT_FORMAT) {
		return format.looksLike(file.data) ? { name: typeof file.name === "string" ? file.name : null, data: file.data } : null;
	}
	return format.looksLike(parsed) ? { name: null, data: parsed } : null;
}

/**
 * The list of workspaces and which one is active; `defaultName(n)` names the n-th workspace when no name is
 * given. With no workspace there yet, the first one is made. Rejects when the storage can't list them (or
 * make the first): without its list there is nothing the app could show. Their data is in `format`, and
 * `openStore` opens one's store.
 */
export async function createWorkspacesOf<D, S>(
	port: DataPort,
	format: DataFormat<D>,
	openStore: (id: string) => Promise<S>,
	defaultName: (n: number) => string,
	preference: ActiveWorkspacePreference,
) {
	let list = await load();
	let active = pick(preference.read());

	async function load(): Promise<WorkspaceInfo[]> {
		const listed = await port.listWorkspaces();
		if (listed.length > 0) return listed;
		const first = { id: ulid(), name: defaultName(1) };
		await port.createWorkspace(first, format.version);
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
	async function make(workspace: WorkspaceInfo, data: D): Promise<WorkspaceInfo | null> {
		try {
			await port.createWorkspace(workspace, format.version);
		} catch {
			return null;
		}
		const changes = format.changesBetween(format.nothing(), data);
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

		/** Adds a workspace, empty or starting with what `start` makes of nothing. Null if it couldn't be made
		 * (then nothing is added). The store fills in the rest (a default board, say) when it loads it. */
		add(name: string, start: (nothing: D) => D = (nothing) => nothing): Promise<WorkspaceInfo | null> {
			return make(newWorkspace(name), start(format.nothing()));
		},

		/** Adds a workspace holding imported data. Null if the data can't be read, or the workspace couldn't be
		 * made (then nothing is added). */
		async addImported(name: string, data: unknown): Promise<WorkspaceInfo | null> {
			const prepared = format.prepareImport(data);
			return prepared ? make(newWorkspace(name), prepared) : null;
		},

		/** Renames a workspace; a rename the storage doesn't take is undone here at its next reload. */
		rename(id: string, name: string): void {
			if (name.trim() === "") return;
			list = list.map((w) => (w.id === id ? { ...w, name: name.trim() } : w));
			void port.renameWorkspace(id, name.trim()).catch(() => {});
		},

		/** Moves a workspace to index `to` in the list; a move the storage doesn't take is undone here at its next
		 * reload. The active workspace is remembered: without that, the next start would open whichever is first now. */
		move(id: string, to: number): void {
			const from = list.findIndex((w) => w.id === id);
			if (from < 0) return;
			list = moveItem(list, from, to);
			preference.write(active);
			void port.moveWorkspace(id, to).catch(() => {});
		},

		/** Deletes a workspace and all its data. The last workspace can't be deleted. */
		remove(id: string): void {
			if (list.length <= 1 || !list.some((w) => w.id === id)) return;
			list = list.filter((w) => w.id !== id);
			if (active === id) active = list[0]!.id;
			void port.deleteWorkspace(id).catch(() => {});
		},

		openStore,
	};
}

/** The workspaces of data in the format `D`, opened as stores `S` (see `createWorkspacesOf`). */
export type WorkspacesOf<D, S> = Awaited<ReturnType<typeof createWorkspacesOf<D, S>>>;
