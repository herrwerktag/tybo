/**
 * A browser-like environment for UI tests (happy-dom). Import it before any module that touches the DOM at load
 * (e.g. i18n): importing installs the browser globals (document, localStorage, …) on Node's global object.
 */
import { Window } from "happy-dom";
import type { StoragePort } from "@bekbon/core";

/** Browser globals Node also has in some form, which UI code needs to be the browser's (and all …Event classes). */
const OVERRIDES = new Set(["window", "document", "location", "navigator", "localStorage", "sessionStorage", "history"]);

let current: Window;

/** Puts the current window's globals on Node's global object, as getters, so freshDom() can swap the window. */
function install(window: Window): void {
	const names = new Set<string>();
	for (let o: object | null = window; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
		for (const name of Object.getOwnPropertyNames(o)) names.add(name);
	}
	const global = globalThis as unknown as Record<string, unknown>;
	for (const name of names) {
		// Node's own timers, events, URL, crypto etc. stay.
		if (name === "constructor" || (name in global && !OVERRIDES.has(name) && !name.endsWith("Event"))) continue;
		Object.defineProperty(global, name, {
			configurable: true,
			get() {
				const value = (current as unknown as Record<string, unknown>)[name];
				// Methods like confirm() or requestAnimationFrame() need their window; classes don't.
				return typeof value === "function" && !/^[A-Z]/.test(name) ? value.bind(current) : value;
			},
			set(value) {
				(current as unknown as Record<string, unknown>)[name] = value;
			},
		});
	}
}

/** Replaces the window with a new one: empty storage and a page with just the app's `<main id="app">`. */
export function freshDom(): Window {
	current?.close();
	current = new Window({ url: "http://localhost/" });
	current.document.body.innerHTML = '<main id="app"></main>';
	return current;
}

/** The page's localStorage as the core's port, the way the demo app provides it in the browser. */
export function localStoragePort(): StoragePort {
	return {
		async getItem(key: string) {
			return localStorage.getItem(key);
		},
		async setItem(key: string, value: string) {
			localStorage.setItem(key, value);
		},
		async removeItem(key: string) {
			localStorage.removeItem(key);
		},
	};
}

install(freshDom());
