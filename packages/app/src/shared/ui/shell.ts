import { exportWorkspaceOf, readWorkspaceFileOf, type DataFormat, type StoreCore, type WorkspacesOf } from "../core/index.js";
import { downloadFile, dragHandle, el, reorderable, safeFileName, svgEl } from "./dom.js";
import { LANGUAGES, language, setLanguage, type Language } from "./i18n.js";
import { text } from "./texts.js";
import { THEMES, setTheme, theme, type Theme } from "./theme.js";

/** What a page and a setting get of the app around them. */
export interface Shell {
	/** Draws the page anew (after a change that the page shows, say). */
	rerender(): void;
}

/** A page of its own in the app, with its tab in the top bar: what a feature shows the workspace's data in. */
export interface Page<S> {
	/** Its addresses after the "#", e.g. "analysis"; the first is its tab's link, the others land there too. */
	routes: readonly string[];
	/** The tab's name, in the current language. */
	label(): string;
	/** The page, showing the workspace held by `store`. */
	render(store: S): HTMLElement;
	/** Called once the page is on screen, e.g. to focus what it asked to. */
	afterRender?(root: HTMLElement): void;
}

/** Makes a feature's page, once for the app's whole life: what it keeps between drawings lives with it. */
export type PageMaker<S> = (shell: Shell) => Page<S>;

/** An entry of a feature in the workspace menu, after export and import (e.g. exporting the workspace as text). */
export interface WorkspaceAction<S> {
	label(): string;
	title(): string;
	run(store: S, workspaceName: string): void;
}

/** A choice of a feature in the form for a new workspace, as a checkbox (e.g. taking over the entity types). */
export interface NewWorkspaceOption<D, S> {
	label(currentName: string): string;
	/** Whether there's anything to take over from the current workspace. */
	available(store: S): boolean;
	/** What the new workspace starts with, of what it would hold without: from the current workspace's `store`. */
	start(store: S): (nothing: D) => D;
}

/** A feature's control in the settings menu, below language and theme. */
export type SettingMaker = (shell: Shell) => HTMLElement;

/** What the features put into the shell (see features.ui.ts). */
export interface ShellParts<D, S> {
	format: DataFormat<D>;
	/** The pages, their tabs in this order; the first is shown for an address no page has. */
	pages: readonly PageMaker<S>[];
	workspaceActions: readonly WorkspaceAction<S>[];
	newWorkspaceOptions: readonly NewWorkspaceOption<D, S>[];
	settings: readonly SettingMaker[];
	/** The question before deleting the workspace named, saying what it holds. */
	deleteQuestion(name: string, store: S): string;
}

const WORKSPACE_MIME = "application/x-workspace-index";

type MenuName = "settings" | "workspace";

/** An arrow bending back (undo); mirrored, forward (redo). Drawn, since the font's arrows come out small and thin. */
function historyIcon(mirrored: boolean): SVGSVGElement {
	return svgEl(
		"svg",
		{ class: "history-icon", viewBox: "0 0 16 16", "aria-hidden": "true", ...(mirrored && { transform: "scale(-1 1)" }) },
		svgEl("path", { d: "M5.5 3 2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8H7" }),
	);
}

/** How often to look, in the background, for a stand of the open workspace that someone else saved in between:
 * generously — it's about not being blindsided before the next save, not about seconds (and the tab being looked
 * at again — getting focus, turning visible — looks right away, not only every interval). */
const NEWER_STAND_EVERY_MS = 15_000;

/** A thrown value as text for the user. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What the page shows instead of the app when the storage API can't be reached: nothing could be loaded, so
 * nothing is shown or saved — only what happened, and the reload that tries again. */
export function renderServerUnreachable(root: HTMLElement): void {
	root.replaceChildren(
		el(
			"section",
			{ className: "error-screen", role: "alert" },
			el("h2", {}, text.serverUnreachableTitle),
			el("p", {}, text.serverUnreachableHint),
			el("div", { className: "row" }, el("button", { type: "button", onclick: () => location.reload() }, text.reload)),
		),
	);
}

/**
 * Draws the app in `root`: the top bar (the workspace and its menu, the pages' tabs, undo, redo and settings), the
 * warnings about saving below it, and the page the address names. What the pages, menus and settings hold, the
 * features put in (`parts`).
 */
export async function renderShell<D, S extends StoreCore<D>>(root: HTMLElement, workspaces: WorkspacesOf<D, S>, parts: ShellParts<D, S>): Promise<void> {
	/** Warnings about the saved data and its saving, below the top bar; updated on its own, since failed or
	 refused saves can happen on the canvas. */
	const banner = el("div", { className: "problem-banner", role: "alert" });

	/** Undo and redo in the top bar; updated on their own, since most canvas changes don't draw the page again. */
	const undoButton = el("button", { type: "button", className: "history-button", onclick: () => undoChange() }, historyIcon(false));
	const redoButton = el("button", { type: "button", className: "history-button", onclick: () => redoChange() }, historyIcon(true));
	const historyButtons = el("div", { className: "history-buttons" }, undoButton, redoButton);
	const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

	function renderHistoryButtons(): void {
		const { canUndo, canRedo } = store.history;
		const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);
		Object.assign(undoButton, { disabled: !canUndo, title: `${text.undo} (${shortcut("Z")})`, ariaLabel: text.undo });
		Object.assign(redoButton, { disabled: !canRedo, title: `${text.redo} (${shortcut(isMac ? "⇧Z" : "Y")})`, ariaLabel: text.redo });
	}

	function undoChange(): void {
		if (store.undo()) rerender();
	}

	function redoChange(): void {
		if (store.redo()) rerender();
	}

	/** Opens a workspace's store, keeping the banner and undo buttons up to date while it's the active one. */
	async function openStore(id: string): Promise<S> {
		const opened = await workspaces.openStore(id);
		opened.onProblemsChange(() => {
			if (opened === store) renderBanner();
		});
		opened.onHistoryChange(() => {
			if (opened === store) renderHistoryButtons();
		});
		return opened;
	}

	/** The active workspace's data; replaced when switching workspaces. */
	let store: S = await openStore(workspaces.active.id);
	const state = {
		/** The open top-bar menu, if any (kept across re-renders, e.g. a language change). */
		openMenu: null as MenuName | null,
		/** Drag handle in the workspace list (its `data-focus-key`) to focus after the next render, so keyboard
		 * reordering keeps focus on the moved workspace. */
		focusHandle: null as string | null,
		/** Whether a background look saw a newer stand of the open workspace than this page holds (someone else
		 * saved in between). A hint only: nothing is reloaded for it without the user's word. */
		newerStand: false,
		/** The last error thrown outside rendering (e.g. in a click handler), shown until the page is reloaded. */
		unexpectedError: null as string | null,
	};

	const shell: Shell = { rerender: () => rerender() };
	const pages = parts.pages.map((make) => make(shell));
	const settings = parts.settings.map((make) => make(shell));

	/** The page the address names; the first page for an address none has (old links, say). */
	function pageFromHash(hash: string): Page<S> {
		const route = hash.slice(1).split("/")[0] ?? "";
		return pages.find((page) => page.routes.includes(route)) ?? pages[0]!;
	}

	const reloadButton = () => el("button", { type: "button", onclick: () => location.reload() }, text.reload);

	function exportActiveWorkspace(): void {
		const { name } = workspaces.active;
		const date = new Date().toISOString().slice(0, 10);
		downloadFile(`${safeFileName(name)} ${date}.json`, exportWorkspaceOf(parts.format, name, store.data));
	}

	function renderBanner(): void {
		const { load, saveFailed, saveConflict } = store.problems;
		const messages: Node[] = [];
		if (state.unexpectedError !== null) {
			messages.push(el("p", {}, text.unexpectedError(state.unexpectedError), " ", reloadButton()));
		}
		// Someone else saved the same units in between: say what happened, and offer the newer data.
		if (saveConflict) messages.push(el("p", {}, text.saveConflict, " ", reloadButton()));
		if (saveFailed) messages.push(el("p", {}, text.saveFailed));
		// Someone else saved the workspace anew in between — a look saw it; nothing of it was loaded here. Say so and
		// offer the newer stand: loading it is the user's word (the button), never this page's own doing.
		if (state.newerStand) messages.push(el("p", {}, text.changedElsewhere, " ", reloadButton()));
		if (load?.code === "newerVersion") messages.push(el("p", {}, text.loadNewerVersion, " ", reloadButton()));
		if (load?.code === "unavailable") messages.push(el("p", {}, text.loadUnavailable, " ", reloadButton()));
		banner.replaceChildren(...messages);
		banner.hidden = messages.length === 0;
	}

	/** Looks in the background whether the storage holds a newer stand of the open workspace — someone else's
	 * save, in another tab or on another device. Only looks: nothing is reloaded here, nothing the user is
	 * working on is touched, nothing is discarded; the hint tells it and offers the reload, which the user
	 * decides on. A look that fails is no event — the next one may work. */
	async function lookForNewerStand(): Promise<void> {
		const lookedAt = store;
		const newer = await lookedAt.checkForNewer(); // never rejects; a look that fails just isn't newer
		if (lookedAt !== store) return; // the workspace was switched while the look was here
		if (newer === state.newerStand) return; // nothing changed either way
		state.newerStand = newer;
		renderBanner();
	}

	/** Looks for a newer stand only while someone can see this tab: nobody looks at a hidden page, so nothing
	 * is asked there — no needless traffic, no battery spent on a page that has no eyes on it. */
	function lookWhileVisible(): void {
		if (document.visibilityState !== "visible") return;
		void lookForNewerStand();
	}

	/** Draws the page; if that fails, shows the error screen instead of a half-drawn page. */
	function rerender(): void {
		try {
			renderPage();
		} catch (error) {
			console.error(error);
			renderErrorScreen(error);
		}
	}

	/** The data is still in memory, so it can be exported before reloading. */
	function renderErrorScreen(error: unknown): void {
		root.replaceChildren(
			el(
				"section",
				{ className: "error-screen", role: "alert" },
				el("h2", {}, text.errorScreenTitle),
				el("p", {}, text.errorScreenHint),
				el("pre", { className: "error-detail mono" }, errorMessage(error)),
				el(
					"div",
					{ className: "row" },
					reloadButton(),
					el("button", { type: "button", onclick: exportActiveWorkspace }, text.exportButton),
				),
			),
		);
	}

	function renderPage(): void {
		const page = pageFromHash(location.hash);
		renderBanner();
		renderHistoryButtons();
		root.replaceChildren(
			// One header, so the page keeps its two rows (top, content) with or without warnings.
			el("header", {}, navBar(page), banner),
			page.render(store),
		);
		if (state.focusHandle !== null) {
			root.querySelector<HTMLElement>(`.drag-handle[data-focus-key="${state.focusHandle}"]`)?.focus();
			state.focusHandle = null;
		}
		page.afterRender?.(root);
	}

	/** The workspace first, since every tab shows its data; then the tabs; undo, redo and settings at the right end. */
	function navBar(current: Page<S>): HTMLElement {
		const nav = el(
			"nav",
			{ className: "app-nav" },
			workspaceMenu(),
			el(
				"div",
				{ className: "app-tabs" },
				...pages.map((page) => el("a", { href: `#${page.routes[0]}`, className: page === current ? "tab current" : "tab" }, page.label())),
			),
			el("div", { className: "nav-menus" }, historyButtons, settingsMenu()),
		);
		nav.querySelector(".current")?.setAttribute("aria-current", "page");
		return nav;
	}

	/**
	 * A top-bar button with a panel below it; closes on outside click or Escape. Which menu is open lives in
	 * `state.openMenu`, so only one is open at a time and it survives a re-render (e.g. after a language change).
	 */
	function popover(name: MenuName, button: HTMLButtonElement, panelLabel: string, ...content: Node[]): HTMLElement {
		const panel = el("div", { className: "menu-panel", id: `${name}-menu`, role: "dialog", ariaLabel: panelLabel }, ...content);
		button.type = "button";
		button.classList.add("menu-button");
		button.setAttribute("aria-controls", panel.id);
		button.setAttribute("aria-haspopup", "dialog");
		button.addEventListener("click", () => setOpen(state.openMenu !== name));
		const wrapper = el("div", { className: "menu" }, button, panel);

		const stopListening = () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
		function onPointerDown(e: PointerEvent): void {
			if (!wrapper.isConnected) return stopListening(); // replaced by a re-render
			if (!wrapper.contains(e.target as Node)) setOpen(false);
		}
		function onKeyDown(e: KeyboardEvent): void {
			if (!wrapper.isConnected) return stopListening();
			if (e.key === "Escape") {
				setOpen(false);
				button.focus();
			}
		}
		function setOpen(open: boolean): void {
			if (open) state.openMenu = name;
			else if (state.openMenu === name) state.openMenu = null;
			panel.hidden = !open;
			button.ariaExpanded = String(open);
			stopListening();
			if (open) {
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
			}
		}
		setOpen(state.openMenu === name);
		return wrapper;
	}

	/** ⚙ Settings: the UI language and the theme, then the features' own settings. */
	function settingsMenu(): HTMLElement {
		const languageSelect = el(
			"select",
			{
				onchange: () => {
					setLanguage(languageSelect.value as Language);
					rerender(); // the menu stays open, now in the new language
					root.querySelector<HTMLElement>("#settings-menu select")?.focus();
				},
			},
			...LANGUAGES.map(({ code, name }) => el("option", { value: code, lang: code, selected: code === language }, name)),
		);
		const themeNames: Record<Theme, string> = { system: text.themeSystem, light: text.themeLight, dark: text.themeDark };
		const themeSelect = el(
			"select",
			{ onchange: () => setTheme(themeSelect.value as Theme) },
			...THEMES.map((code) => el("option", { value: code, selected: code === theme }, themeNames[code])),
		);
		return popover(
			"settings",
			el("button", { className: "settings-button", title: text.settings, ariaLabel: text.settings }, el("span", { ariaHidden: "true" }, "⚙")),
			text.settings,
			el("h2", {}, text.settings),
			el("label", { className: "field" }, el("span", {}, text.language), languageSelect),
			el("label", { className: "field" }, el("span", {}, text.theme), themeSelect),
			...settings,
		);
	}

	/** The current workspace's name; opens the list of workspaces, rename/delete, and the form for a new one. */
	function workspaceMenu(): HTMLElement {
		const current = workspaces.active;
		const isLast = workspaces.list.length <= 1;

		const list = el(
			"ul",
			{ className: "workspace-list" },
			...workspaces.list.map((w, i) => {
				const option = el(
					"button",
					{ type: "button", className: "workspace-option", title: w.name, onclick: () => switchWorkspace(w.id) },
					w.name,
				);
				if (w.id === current.id) option.setAttribute("aria-current", "true");
				const handle = dragHandle(text.moveWorkspace(w.name), `workspace:${w.id}`);
				const item = el("li", {}, handle, option);
				reorderable(item, handle, {
					index: i,
					count: workspaces.list.length,
					mime: WORKSPACE_MIME,
					move: (from, to) => {
						const moved = workspaces.list[from]!.id;
						workspaces.move(moved, to);
						state.focusHandle = `workspace:${moved}`;
						rerender();
					},
				});
				return item;
			}),
		);

		const nameInput = el("input", {
			ariaLabel: text.name,
			value: text.defaultWorkspaceName(workspaces.list.length + 1),
		});
		const options = parts.newWorkspaceOptions.map((option) => ({
			option,
			checkbox: el("input", { type: "checkbox", disabled: !option.available(store) }),
		}));
		const newForm = el(
			"form",
			{
				className: "workspace-new",
				onsubmit: async (e) => {
					e.preventDefault();
					const starts = options.filter(({ checkbox }) => checkbox.checked).map(({ option }) => option.start(store));
					const added = await workspaces.add(nameInput.value, (nothing) => starts.reduce((data, start) => start(data), nothing));
					if (!added) return alert(text.createFailed);
					await switchWorkspace(added.id);
				},
			},
			el("h3", {}, text.newWorkspace),
			nameInput,
			...options.map(({ option, checkbox }) => el("label", { className: "checkbox-setting" }, checkbox, ` ${option.label(current.name)}`)),
			el("button", { type: "submit", className: "primary" }, text.create),
		);

		// Export downloads the current workspace; import always adds a new one, so nothing is overwritten.
		const fileInput = el("input", {
			type: "file",
			accept: ".json,application/json",
			hidden: true,
			onchange: async () => {
				const file = fileInput.files?.[0];
				fileInput.value = "";
				if (!file) return;
				const read = readWorkspaceFileOf(parts.format, await file.text().catch(() => ""));
				if (!read) return alert(text.importInvalid);
				const added = await workspaces.addImported(read.name ?? file.name.replace(/\.json$/i, ""), read.data);
				if (!added) return alert(text.importFailed);
				await switchWorkspace(added.id);
			},
		});
		const transfer = el(
			"div",
			{ className: "menu-actions" },
			el(
				"button",
				{
					type: "button",
					className: "menu-item",
					title: text.exportWorkspace,
					onclick: exportActiveWorkspace,
				},
				text.exportButton,
			),
			...parts.workspaceActions.map((action) =>
				el("button", { type: "button", className: "menu-item", title: action.title(), onclick: () => action.run(store, current.name) }, action.label()),
			),
			el("button", { type: "button", className: "menu-item", title: text.importWorkspace, onclick: () => fileInput.click() }, text.importButton),
			fileInput,
		);

		const button = el(
			"button",
			{ title: text.workspaces, ariaLabel: text.workspaceMenuLabel(current.name) },
			el("span", { ariaHidden: "true" }, "▤"),
			el("span", { className: "workspace-name" }, current.name),
			el("span", { ariaHidden: "true" }, "▾"),
		);
		return popover(
			"workspace",
			button,
			text.workspaces,
			el("h2", {}, text.workspaces),
			list,
			// The current workspace's actions, then its transfer, as menu entries.
			el(
				"div",
				{ className: "menu-actions" },
				el(
					"button",
					{
						type: "button",
						className: "menu-item",
						title: text.renameWorkspace,
						onclick: () => {
							const name = prompt(text.renameWorkspace, current.name);
							if (name === null) return;
							workspaces.rename(current.id, name);
							rerender();
						},
					},
					text.renameButton,
				),
				el(
					"button",
					{
						type: "button",
						className: "menu-item",
						disabled: isLast,
						title: isLast ? text.lastWorkspace : text.deleteWorkspace,
						onclick: () => {
							if (!confirm(parts.deleteQuestion(current.name, store))) return;
							workspaces.remove(current.id);
							switchWorkspace(workspaces.active.id);
						},
					},
					text.delete,
				),
			),
			transfer,
			newForm,
		);
	}

	/** Opens another workspace: its own data, in the same tab. */
	async function switchWorkspace(id: string): Promise<void> {
		workspaces.setActive(id);
		store = await openStore(workspaces.active.id);
		state.newerStand = false; // the opened stand is the one to look from now on
		state.openMenu = null;
		rerender();
	}

	// Errors outside rendering (event handlers, timers, promises) would otherwise go unnoticed.
	const showUnexpectedError = (error: unknown) => {
		state.unexpectedError = errorMessage(error);
		renderBanner();
	};
	window.addEventListener("error", (e) => showUnexpectedError(e.error ?? e.message));
	window.addEventListener("unhandledrejection", (e) => showUnexpectedError(e.reason));

	// Ctrl/⌘+Z undoes, Ctrl/⌘+Shift+Z or Ctrl+Y redoes; in text fields they stay the browser's own text undo.
	document.addEventListener("keydown", (e) => {
		if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
		if ((e.target as Element).closest?.("input, select, textarea, [contenteditable]")) return;
		const key = e.key.toLowerCase();
		const redo = (key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey);
		if (key !== "z" && !redo) return;
		e.preventDefault();
		if (redo) redoChange();
		else undoChange();
	});

	window.addEventListener("hashchange", rerender);

	// The watch on newer stands runs once, for the page's whole life — not on each of its many re-draws
	// (rerender()), or every drawing would nest a further interval and the page would ask faster and faster.
	// The interval looks now and then; focus and the tab turning visible look at once, which is when the user
	// looks. It never reloads anything by itself: the hint does no more than it says.
	const watchNewerStand = window.setInterval(lookWhileVisible, NEWER_STAND_EVERY_MS);
	// The browser's answer is a bare number with no such handle; Node answers with a timer that mustn't hold
	// its process open (the UI tests), so it steps aside there — the interval itself lives on as before.
	(watchNewerStand as number & { unref?: () => void }).unref?.();
	window.addEventListener("focus", lookWhileVisible);
	document.addEventListener("visibilitychange", lookWhileVisible);
	lookWhileVisible(); // the stand this page read may lag behind from the first moment on

	rerender();
}
