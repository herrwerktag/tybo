import { createWorkspacesOf, exportWorkspaceOf, readWorkspaceFileOf, type ActiveWorkspacePreference, type DataPort } from "../../shared/core/index.js";
import type { AppData, EntityType } from "./model.js";
import { APP_FORMAT, createStore } from "./store.js";

/** The app's workspaces, each opened as the app's store. */
export async function createWorkspaces(port: DataPort, defaultName: (n: number) => string, preference: ActiveWorkspacePreference) {
	const workspaces = await createWorkspacesOf(port, APP_FORMAT, (id) => createStore(port, id), defaultName, preference);
	const { add } = workspaces;
	return Object.assign(workspaces, {
		/** Adds a workspace, empty or starting with copies of the given entity types (no entities or boards). Null if
		 * it couldn't be made (then nothing is added). */
		add(name: string, copyTypesFrom: readonly EntityType[] = []) {
			return add(name, (nothing) => ({ ...nothing, types: [...copyTypesFrom] }));
		},
	});
}

export type Workspaces = Awaited<ReturnType<typeof createWorkspaces>>;

/** A workspace of the app as a JSON file (see `exportWorkspaceOf` in shared/core). */
export const exportWorkspace = (name: string, data: AppData): string => exportWorkspaceOf(APP_FORMAT, name, data);

/** Reads an exported workspace file of the app (see `readWorkspaceFileOf` in shared/core). */
export const readWorkspaceFile = (text: string) => readWorkspaceFileOf(APP_FORMAT, text);
