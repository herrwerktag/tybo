import { createWorkspacesOf, exportWorkspaceOf, readWorkspaceFileOf, type ActiveWorkspacePreference, type DataPort } from "../../shared/core/index.js";
import type { AppData } from "./model.js";
import { APP_FORMAT, createStore } from "./store.js";

/** The app's workspaces, each opened as the app's store (see `createWorkspacesOf`). */
export function createWorkspaces(port: DataPort, defaultName: (n: number) => string, preference: ActiveWorkspacePreference) {
	return createWorkspacesOf(port, APP_FORMAT, (id) => createStore(port, id), defaultName, preference);
}

export type Workspaces = Awaited<ReturnType<typeof createWorkspaces>>;

/** A workspace of the app as a JSON file (see `exportWorkspaceOf` in shared/core). */
export const exportWorkspace = (name: string, data: AppData): string => exportWorkspaceOf(APP_FORMAT, name, data);

/** Reads an exported workspace file of the app (see `readWorkspaceFileOf` in shared/core). */
export const readWorkspaceFile = (text: string) => readWorkspaceFileOf(APP_FORMAT, text);
