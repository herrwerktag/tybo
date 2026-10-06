/** Per-browser UI preferences (language, panel state, …), kept outside the app data. */

export function readPreference(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writePreference(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage blocked: the choice just isn't remembered.
	}
}

/** Which workspace this browser opens — a view of the data, like the active board, so it's remembered here. */
export const activeWorkspacePreference = {
	read: () => readPreference("active-workspace"),
	write: (id: string) => writePreference("active-workspace", id),
};
