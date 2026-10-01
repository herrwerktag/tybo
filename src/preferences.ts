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
