/**
 * The app on a fresh page for UI tests: started with saved data in a storage in memory, and the little helpers the
 * tests click and read it with. Import it before any module that touches the DOM at load (it brings test-dom).
 */
import { freshDom } from "../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { text } from "./i18n.js";
import type { AppData } from "../core/index.js";
import { render } from "./ui.js";
import { createWorkspaces } from "../core/index.js";
import { memoryDataPort } from "../core/memory-port.js";
import { activeWorkspacePreference } from "../../shared/ui/index.js";

/** Lets work started by a click or an event finish first (the stores open and save through the async port). */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

/** The workspace the tests' saved data is in. */
export const WS = "ws";

/** The storage in memory, with `saved` as the data of the workspace WS (named as the first workspace is) — or
 * no workspace at all, the way the very first start finds it. */
export function memoryStorage(saved?: unknown) {
	const behind = memoryDataPort(saved === undefined ? {} : { [WS]: saved });
	if (saved !== undefined) void behind.port.renameWorkspace(WS, text.defaultWorkspaceName(1)); // done at once, in memory
	return behind;
}

/** The storage behind the app the last startApp started. */
export let storage = memoryStorage();

/** Renders the app on a fresh page (at `hash`, e.g. "#boards"), with `saved` already in the storage. A different
 * storage `behind` it shows what the app does with one that answers otherwise (with collisions, for instance). */
export async function startApp(saved?: unknown, hash = "", behind = memoryStorage(saved), options: { viewScript?: string } = {}): Promise<HTMLElement> {
	freshDom();
	location.hash = hash;
	storage = behind;
	const root = document.querySelector<HTMLElement>("#app")!;
	const workspaces = await createWorkspaces(behind.port, text.defaultWorkspaceName, activeWorkspacePreference);
	await render(root, workspaces, options);
	return root;
}

/** The element matching `selector` whose text is `label`. */
export function byText<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string, label: string): T {
	const found = [...root.querySelectorAll<T>(selector)].find((node) => node.textContent?.trim() === label);
	assert.ok(found, `no ${selector} with text "${label}"`);
	return found;
}

export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Replaces browser dialogs (alert, confirm, prompt) for the current page. */
export const stub = (dialogs: Partial<Record<"alert" | "confirm" | "prompt", (message: string) => unknown>>) => Object.assign(globalThis, dialogs);

/** The data of the first workspace, as the storage holds it once the saves on their way have landed. */
export async function readSaved(): Promise<AppData> {
	await settle();
	const [first] = await storage.port.listWorkspaces();
	return storage.data(first!.id) as unknown as AppData;
}

/** Shows another page, the way a click on a nav link does. */
export function goTo(hash: string): void {
	location.hash = hash;
	window.dispatchEvent(new Event("hashchange"));
}
