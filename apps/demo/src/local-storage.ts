import type { StoragePort } from "@bekbon/core";

/**
 * The browser app's port into localStorage. Each call is done the moment it's made (as with the port's
 * promise, so earlier saves are never overtaken), and failing calls reject for the core to catch.
 */
export function localStoragePort(): StoragePort {
	return {
		async getItem(key) {
			return localStorage.getItem(key);
		},
		async setItem(key, value) {
			localStorage.setItem(key, value);
		},
		async removeItem(key) {
			localStorage.removeItem(key);
		},
	};
}
