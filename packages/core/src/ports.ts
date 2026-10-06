import type { Change } from "./changes.js";

/** A workspace: its own entity types, entities and boards. */
export interface WorkspaceInfo {
	id: string;
	name: string;
}

/**
 * How the core reaches its saved data: workspaces, and each one's data written unit by unit, asynchronously.
 * The environment provides the port — the browser app, the storage API's (apps/api), which keeps everything
 * in Postgres.
 *
 * Calls that can't be carried out reject, and the core reacts to that: it keeps working with what it holds
 * in memory and reports the failure where the user can act on it.
 */
export interface DataPort {
	/** The workspaces, in their order. */
	listWorkspaces(): Promise<WorkspaceInfo[]>;
	/** Makes an empty workspace whose data is in the format `dataVersion`. */
	createWorkspace(info: WorkspaceInfo, dataVersion: number): Promise<void>;
	/** Renames a workspace. */
	renameWorkspace(id: string, name: string): Promise<void>;
	/** Deletes a workspace and all its data. */
	deleteWorkspace(id: string): Promise<void>;
	/** The workspace's data — the app's data, marked with the format it is in (`version`) — and the version it
	 * is at; null when there is no such workspace. */
	load(id: string): Promise<{ data: unknown; version: string } | null>;
	/** The version the workspace's data is at right now, or null when there is no such workspace — without
	 * carrying the data itself. It tells the stand someone would save against from the stand saved meanwhile. */
	version(id: string): Promise<string | null>;
	/** Saves only the units that changed since the stand they were last read or saved at, each with its
	 * `before` and `after` (see `changesBetween` in changes.js). A save that names a unit someone else wrote in
	 * between doesn't reject: the answer lists it under `collided`, it was written anyway (last one wins), and
	 * the user can reload to see the other's stand. */
	saveChanges(id: string, changes: Change[]): Promise<SavedChanges>;
}

/** What a save of a change set answers: the stand's new version, and which units collided. */
export interface SavedChanges {
	/** The version the workspace's data is at now — the stand the units were merged into. */
	version: string;
	/** The ids of the units someone else had changed since this stand last read or saved them. They were
	 * written anyway (last one wins), so the save went through — but it built on older units than it
	 * thought, and the saver tells its user about it (the banner, the reload): here its own save stands, and
	 * the other's was written over by it. */
	collided: string[];
}
