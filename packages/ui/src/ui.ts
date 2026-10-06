import {
	CARD_DISPLAYS,
	LINE_ARROWS,
	PROPERTY_KINDS,
	TYPE_COLORS,
	effectiveCardDisplay,
	entityTypeMap,
	inverseReferences,
	inverseRelations,
	migrateValues,
	moveItem,
	newReference,
	nextTypeColor,
	parseValue,
	validateType,
	type CardDisplay,
	type DraftProperty,
	type LineArrow,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyKind,
	type PropertyValue,
	type ValidationError,
} from "@bekbon/core";
import { canvasView } from "./canvas.js";
import { downloadFile, el, safeFileName, typeDot } from "./dom.js";
import { LANGUAGES, language, setLanguage, text, type Language } from "./i18n.js";
import { standaloneViewHtml } from "./standalone.js";
import type { Store } from "@bekbon/core";
import { exportWorkspace, readWorkspaceFile, type Workspaces } from "@bekbon/core";

interface UiState {
	editingTypeId: string | null;
	draftName: string;
	draftContentTemplate: string;
	draftColor: string;
	draftProps: DraftProperty[];
	typeErrors: ValidationError[];
	selectedTypeId: string | null;
	editingEntityId: string | null;
	/** Whether the form for a new type / a new entity is open; they stay hidden until asked for. */
	creatingType: boolean;
	creatingEntity: boolean;
	/** Form to scroll into view and focus after the next render (set when Edit is clicked). */
	focusForm: "type" | "entity" | null;
	/** Drag handle to focus after the next render, so keyboard reordering keeps focus on the moved property. */
	focusHandle: number | null;
	/** The open top-bar menu, if any (kept across re-renders, e.g. a language change). */
	openMenu: MenuName | null;
	/** Whether a background look saw a newer stand of the open workspace than this page holds (someone else
	 * saved in between). A hint only: nothing is reloaded for it without the user's word. */
	newerStand: boolean;
	/** The last error thrown outside rendering (e.g. in a click handler), shown until the page is reloaded. */
	unexpectedError: string | null;
}

type MenuName = "settings" | "workspace";

const PROPERTY_MIME = "application/x-property-index";

/** The page shown, from the URL hash: entity types, entities, board editing (boards) or read-only boards (view). */
type Route = "types" | "entities" | "boards" | "view";

/** Entities is the default page, so old links (e.g. "#data") still land there; "#canvas" and "#viewer" are the
 * board pages' former names. */
function routeFromHash(hash: string): Route {
	const route = hash.slice(1);
	if (route === "canvas") return "boards";
	if (route === "viewer") return "view";
	return route === "types" || route === "boards" || route === "view" ? route : "entities";
}

/** How often to look, in the background, for a stand of the open workspace that someone else saved in between:
 * generously — it's about not being blindsided before the next save, not about seconds (and the tab being looked
 * at again — getting focus, turning visible — looks right away, not only every interval). */
const NEWER_STAND_EVERY_MS = 15_000;

/** Counts existing non-empty values of the type's entities that saving these properties would change or clear. */
function countChangedValues(entities: Entity[], props: DraftProperty[], entityTypes: ReadonlyMap<string, string>): number {
	const kept = props.flatMap((p) => (p.id ? [{ ...p, id: p.id }] : []));
	let changed = 0;
	for (const entity of entities) {
		const migrated = migrateValues(entity.values, kept, entityTypes);
		for (const [id, value] of Object.entries(entity.values)) {
			if (value !== null && JSON.stringify(migrated[id] ?? null) !== JSON.stringify(value)) changed++;
		}
	}
	return changed;
}

function describeProperty(p: PropertyDef, types: EntityType[]): string {
	if (p.kind === "options") return `${p.name}: ${p.options.join(" / ")}`;
	if (p.kind === "reference") {
		const target = types.find((t) => t.id === p.reference?.typeId)?.name ?? "?";
		// No-break spaces keep "→ Target (multiple)" together; a long line wraps after the property name.
		const suffix = p.reference?.multiple ? `\u00a0${text.multipleSuffix}` : "";
		return `${p.name} →\u00a0${target}${suffix}`;
	}
	return `${p.name}: ${text.kinds.text}`;
}

/** A small label above a control, for the settings inside a property card. */
function setting(label: string, control: HTMLElement): HTMLElement {
	return el("label", { className: "field" }, el("span", { className: "setting-label" }, label), control);
}

/** A thrown value as text for the user. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function newDraftProperty(): DraftProperty {
	return { name: "", kind: "text", options: [], reference: null, cardDisplay: "list" };
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
 * Draws the app in `root`. With `viewScript` — the built standalone viewer (see apps/demo) — the View tab can export
 * a board as an HTML file that shows it without the server.
 */
export async function render(root: HTMLElement, workspaces: Workspaces, { viewScript }: { viewScript?: string } = {}): Promise<void> {
	/** Warnings about the saved data and its saving, below the top bar; updated on its own, since failed or
	 refused saves can happen on the canvas. */
	const banner = el("div", { className: "problem-banner", role: "alert" });

	/** Undo and redo in the top bar; updated on their own, since most canvas changes don't draw the page again. */
	const undoButton = el("button", { type: "button", className: "history-button", onclick: () => undoChange() }, "↶");
	const redoButton = el("button", { type: "button", className: "history-button", onclick: () => redoChange() }, "↷");
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
	async function openStore(id: string): Promise<Store> {
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
	let store: Store = await openStore(workspaces.active.id);
	const state: UiState = {
		editingTypeId: null,
		draftName: "",
		draftContentTemplate: "",
		draftColor: nextTypeColor(store.data.types.map((t) => t.color)),
		draftProps: [],
		typeErrors: [],
		selectedTypeId: store.data.types[0]?.id ?? null,
		editingEntityId: null,
		creatingType: false,
		creatingEntity: false,
		focusForm: null,
		focusHandle: null,
		openMenu: null,
		newerStand: false,
		unexpectedError: null,
	};

	const reloadButton = () => el("button", { type: "button", onclick: () => location.reload() }, text.reload);

	function exportActiveWorkspace(): void {
		const { name } = workspaces.active;
		const date = new Date().toISOString().slice(0, 10);
		downloadFile(`${safeFileName(name)} ${date}.json`, exportWorkspace(name, store.data));
	}

	function exportView(viewScript: string, boardId: string): void {
		const name = store.data.boards.find((b) => b.id === boardId)?.name ?? "";
		downloadFile(`${safeFileName(name)}.html`, standaloneViewHtml(viewScript, store.data, boardId, language), "text/html");
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

	function resetTypeForm(): void {
		state.editingTypeId = null;
		state.draftName = "";
		state.draftContentTemplate = "";
		state.draftColor = nextTypeColor(store.data.types.map((t) => t.color));
		state.draftProps = [];
		state.typeErrors = [];
		state.creatingType = false;
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
		if (!store.data.types.some((t) => t.id === state.selectedTypeId)) {
			state.selectedTypeId = store.data.types[0]?.id ?? null;
			state.editingEntityId = null;
		}
		const route = routeFromHash(location.hash);
		const entitiesTab = route === "types" || route === "entities";
		renderBanner();
		renderHistoryButtons();
		root.replaceChildren(
			// One header, so the page keeps its two rows (top, content) with or without warnings.
			el("header", {}, navBar(route), ...(entitiesTab ? [subNav(route)] : []), banner),
			entitiesTab
				? el("div", { className: "data-view" }, route === "types" ? typesSection() : entitiesSection())
				: canvasView(store, {
						readOnly: route === "view",
						...(viewScript ? { onExportView: (boardId: string) => exportView(viewScript, boardId) } : {}),
						// The details panel's Edit button: open the entity in the Entities page's form.
						onEditEntity: (entityId) => {
							const entity = store.data.entities.find((e) => e.id === entityId);
							if (!entity) return;
							state.selectedTypeId = entity.typeId;
							state.editingEntityId = entityId;
							state.focusForm = "entity";
							location.hash = "#entities";
						},
					}),
		);
		if (state.focusHandle !== null) {
			root.querySelectorAll<HTMLElement>(".drag-handle")[state.focusHandle]?.focus();
			state.focusHandle = null;
		}
		if (state.focusForm) {
			const form = root.querySelector<HTMLFormElement>(`#${state.focusForm}-form`);
			state.focusForm = null;
			form?.scrollIntoView({ block: "nearest", behavior: "smooth" });
			form?.querySelector<HTMLElement>("input, select, textarea")?.focus({ preventScroll: true });
		}
	}

	function navBar(route: Route): HTMLElement {
		const tab = (id: Route, label: string, current = route === id) =>
			el("a", { href: `#${id}`, className: current ? "tab current" : "tab" }, label);
		const nav = el(
			"nav",
			{ className: "app-nav" },
			tab("entities", text.tabEntities, route === "entities" || route === "types"),
			tab("boards", text.tabBoards),
			tab("view", text.tabView),
			el("div", { className: "nav-menus" }, historyButtons, workspaceMenu(), settingsMenu()),
		);
		nav.querySelector(".current")?.setAttribute("aria-current", "page");
		return nav;
	}

	/** The Entities tab's two pages: the entity types and the entities themselves. */
	function subNav(route: "types" | "entities"): HTMLElement {
		const tab = (id: "types" | "entities", label: string) =>
			el("a", { href: `#${id}`, className: route === id ? "tab current" : "tab" }, label);
		const nav = el("nav", { className: "sub-nav" }, tab("types", text.entityTypes), tab("entities", text.entities));
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

	/** ⚙ Settings: the UI language. */
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
		return popover(
			"settings",
			el("button", {}, el("span", { ariaHidden: "true" }, "⚙"), text.settings),
			text.settings,
			el("h2", {}, text.settings),
			el("label", { className: "field" }, el("span", {}, text.language), languageSelect),
		);
	}

	/** The current workspace's name; opens the list of workspaces, rename/delete, and the form for a new one. */
	function workspaceMenu(): HTMLElement {
		const current = workspaces.active;
		const isLast = workspaces.list.length <= 1;

		const list = el(
			"ul",
			{ className: "workspace-list" },
			...workspaces.list.map((w) => {
				const option = el(
					"button",
					{ type: "button", className: "workspace-option", onclick: () => switchWorkspace(w.id) },
					w.name,
				);
				if (w.id === current.id) option.setAttribute("aria-current", "true");
				return el("li", {}, option);
			}),
		);

		const nameInput = el("input", {
			ariaLabel: text.name,
			value: text.defaultWorkspaceName(workspaces.list.length + 1),
		});
		const copyTypes = el("input", { type: "checkbox", disabled: store.data.types.length === 0 });
		const newForm = el(
			"form",
			{
				className: "workspace-new",
				onsubmit: async (e) => {
					e.preventDefault();
					const added = await workspaces.add(nameInput.value, copyTypes.checked ? store.data.types : []);
					if (!added) return alert(text.createFailed);
					await switchWorkspace(added.id);
				},
			},
			el("h3", {}, text.newWorkspace),
			nameInput,
			el("label", { className: "checkbox-setting" }, copyTypes, ` ${text.copyTypesFrom(current.name)}`),
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
				const read = readWorkspaceFile(await file.text().catch(() => ""));
				if (!read) return alert(text.importInvalid);
				const added = await workspaces.addImported(read.name ?? file.name.replace(/\.json$/i, ""), read.data);
				if (!added) return alert(text.importFailed);
				await switchWorkspace(added.id);
			},
		});
		const transfer = el(
			"div",
			{ className: "row" },
			el(
				"button",
				{
					type: "button",
					title: text.exportWorkspace,
					onclick: exportActiveWorkspace,
				},
				text.exportButton,
			),
			el("button", { type: "button", title: text.importWorkspace, onclick: () => fileInput.click() }, text.importButton),
			fileInput,
		);

		const button = el(
			"button",
			{ title: text.workspaces, ariaLabel: text.workspaceMenuLabel(current.name) },
			el("span", { ariaHidden: "true" }, "▤"),
			el("span", { className: "workspace-name" }, current.name),
		);
		return popover(
			"workspace",
			button,
			text.workspaces,
			el("h2", {}, text.workspaces),
			list,
			el(
				"div",
				{ className: "row" },
				el(
					"button",
					{
						type: "button",
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
						disabled: isLast,
						title: isLast ? text.lastWorkspace : text.deleteWorkspace,
						onclick: () => {
							const { types, entities, boards } = store.data;
							if (!confirm(text.confirmDeleteWorkspace(current.name, types.length, entities.length, boards.length))) return;
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

	/** Opens another workspace: its own types, entities and boards, in the same tab. */
	async function switchWorkspace(id: string): Promise<void> {
		workspaces.setActive(id);
		store = await openStore(workspaces.active.id);
		state.newerStand = false; // the opened stand is the one to look from now on
		resetTypeForm();
		state.selectedTypeId = store.data.types[0]?.id ?? null;
		state.editingEntityId = null;
		state.creatingEntity = false;
		state.openMenu = null;
		rerender();
	}

	function propertyRow(prop: DraftProperty, i: number): HTMLElement {
		const kindSelect = el(
			"select",
			{
				onchange: () => {
					prop.kind = kindSelect.value as PropertyKind;
					prop.cardDisplay = effectiveCardDisplay(prop);
					if (prop.kind === "reference" && !prop.reference) {
						prop.reference = newReference(store.data.types[0]?.id ?? "");
					}
					rerender();
				},
			},
			...PROPERTY_KINDS.map((kind) => el("option", { value: kind, selected: kind === prop.kind }, text.kinds[kind])),
		);
		const moveTo = (to: number) => {
			if (to < 0 || to >= state.draftProps.length || to === i) return;
			state.draftProps = moveItem(state.draftProps, i, to);
			state.focusHandle = to;
			rerender();
		};
		const handle = el(
			"button",
			{
				type: "button",
				className: "drag-handle",
				title: text.dragToReorder,
				ariaLabel: text.moveProperty(prop.name.trim() || String(i + 1)),
				onkeydown: (e) => {
					if (e.key === "ArrowUp" || e.key === "ArrowDown") {
						e.preventDefault();
						moveTo(e.key === "ArrowUp" ? i - 1 : i + 1);
					}
				},
				// Only the handle makes the card draggable, so text in its inputs stays selectable.
				onpointerdown: () => {
					row.draggable = true;
				},
				// A click without a drag: stop the card being draggable again (a real drag ends in dragend).
				onpointerup: () => {
					row.draggable = false;
				},
			},
			"⠿",
		);
		const nameInput = el("input", {
			placeholder: text.propertyName,
			ariaLabel: text.propertyName,
			value: prop.name,
			oninput: (e) => {
				prop.name = (e.target as HTMLInputElement).value;
			},
		});
		const removeButton = el(
			"button",
			{
				type: "button",
				className: "property-remove",
				title: text.removeProperty,
				ariaLabel: text.removePropertyNamed(prop.name.trim() || String(i + 1)),
				onclick: () => {
					state.draftProps.splice(i, 1);
					rerender();
				},
			},
			"✕",
		);
		const displaySelect = el(
			"select",
			{
				title: text.onCardHint,
				onchange: (e) => {
					prop.cardDisplay = (e.target as HTMLSelectElement).value as CardDisplay;
					rerender(); // shows or hides the line settings
				},
			},
			...CARD_DISPLAYS.filter((display) => display !== "line" || prop.kind === "reference").map((display) =>
				el("option", { value: display, selected: display === prop.cardDisplay }, text.cardDisplays[display]),
			),
		);
		// Handle, name and remove on top; then labeled settings, two per row.
		const row = el(
			"div",
			{ className: "property" },
			el("div", { className: "property-head" }, handle, nameInput, removeButton),
			el("div", { className: "property-settings" }, setting(text.settingType, kindSelect), setting(text.settingOnCard, displaySelect)),
		);
		const clearDropMarker = () => row.classList.remove("drop-before", "drop-after");
		const dropsBefore = (e: DragEvent) => {
			const rect = row.getBoundingClientRect();
			return e.clientY < rect.top + rect.height / 2;
		};
		row.addEventListener("dragstart", (e) => {
			e.dataTransfer?.setData(PROPERTY_MIME, String(i));
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
			row.classList.add("dragging");
		});
		row.addEventListener("dragend", () => {
			row.draggable = false;
			row.classList.remove("dragging");
		});
		row.addEventListener("dragover", (e) => {
			if (!e.dataTransfer?.types.includes(PROPERTY_MIME)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			const before = dropsBefore(e);
			row.classList.toggle("drop-before", before);
			row.classList.toggle("drop-after", !before);
		});
		row.addEventListener("dragleave", clearDropMarker);
		row.addEventListener("drop", (e) => {
			const from = Number(e.dataTransfer?.getData(PROPERTY_MIME));
			clearDropMarker();
			if (!Number.isInteger(from)) return;
			e.preventDefault();
			// Index among the other properties, once the dragged one is taken out.
			const target = dropsBefore(e) ? i : i + 1;
			state.draftProps = moveItem(state.draftProps, from, from < target ? target - 1 : target);
			rerender();
		});
		if (prop.kind === "options") {
			row.append(
				setting(
					text.optionsOnePerLine,
					el("textarea", {
						rows: Math.max(3, prop.options.length + 1),
						value: prop.options.join("\n"),
						oninput: (e) => {
							prop.options = (e.target as HTMLTextAreaElement).value.split("\n");
						},
					}),
				),
			);
		}
		if (prop.kind === "reference" && prop.reference) {
			const reference = prop.reference;
			row.append(
				el(
					"div",
					{ className: "property-settings" },
					setting(
						text.references,
						el(
							"select",
							{
								onchange: (e) => {
									reference.typeId = (e.target as HTMLSelectElement).value;
								},
							},
							...(store.data.types.length === 0 ? [el("option", { value: "" }, text.noTypesOption)] : []),
							...store.data.types.map((t) => el("option", { value: t.id, selected: t.id === reference.typeId }, t.name)),
						),
					),
					el(
						"label",
						{ className: "checkbox-setting" },
						el("input", {
							type: "checkbox",
							checked: reference.multiple,
							onchange: (e) => {
								reference.multiple = (e.target as HTMLInputElement).checked;
							},
						}),
						` ${text.allowMultiple}`,
					),
				),
			);
			row.append(
				setting(
					text.shownOnTargetAs,
					el("input", {
						value: reference.inverseLabel,
						placeholder: text.shownOnTargetAsPlaceholder,
						title: text.shownOnTargetAsHint,
						oninput: (e) => {
							reference.inverseLabel = (e.target as HTMLInputElement).value;
						},
					}),
				),
			);
			if (effectiveCardDisplay(prop) === "line") {
				row.append(
					el(
						"div",
						{ className: "property-settings" },
						setting(
							text.arrow,
							el(
								"select",
								{
									onchange: (e) => {
										reference.arrow = (e.target as HTMLSelectElement).value as LineArrow;
									},
								},
								...LINE_ARROWS.map((arrow) =>
									el("option", { value: arrow, selected: arrow === reference.arrow }, text.arrows[arrow]),
								),
							),
						),
						setting(
							text.lineLabel,
							el("input", {
								value: reference.lineLabel,
								placeholder: prop.name.trim() || text.lineLabelPlaceholder,
								oninput: (e) => {
									reference.lineLabel = (e.target as HTMLInputElement).value;
								},
							}),
						),
					),
				);
			}
		}
		return row;
	}

	/** Palette swatches for the type form; the current color is pressed. */
	function colorPicker(): HTMLElement {
		return el(
			"div",
			{ className: "field" },
			el("span", {}, text.color),
			el(
				"div",
				{ className: "swatches" },
				...TYPE_COLORS.map(({ name, value }) => {
					const swatch = el("button", {
						type: "button",
						className: "swatch",
						title: text.colorNames[name] ?? name,
						ariaLabel: text.colorNames[name] ?? name,
						ariaPressed: String(value === state.draftColor),
						onclick: () => {
							state.draftColor = value;
							rerender();
						},
					});
					swatch.style.background = value;
					return swatch;
				}),
			),
		);
	}

	function typesSection(): HTMLElement {
		const editingType = store.data.types.find((t) => t.id === state.editingTypeId);

		const form = el(
			"form",
			{
				id: "type-form",
				className: "card",
				onsubmit: (e) => {
					e.preventDefault();
					const props = state.draftProps.map((p) => ({
						...p,
						options: p.kind === "options" ? p.options.map((o) => o.trim()).filter((o) => o !== "") : [],
					}));
					state.typeErrors = validateType(state.draftName, props, new Set(store.data.types.map((t) => t.id)));
					if (state.typeErrors.length > 0) return rerender();

					if (editingType) {
						const entities = store.data.entities.filter((en) => en.typeId === editingType.id);
						const changed = countChangedValues(entities, props, entityTypeMap(store.data));
						if (changed > 0 && !confirm(text.confirmChangedValues(changed))) return;
						store.updateType(editingType.id, state.draftName, props, state.draftContentTemplate, state.draftColor);
						state.selectedTypeId = editingType.id;
					} else {
						state.selectedTypeId = store.addType(state.draftName, props, state.draftContentTemplate, state.draftColor).id;
					}
					state.editingEntityId = null;
					resetTypeForm();
					rerender();
				},
			},
			el("h3", {}, editingType ? text.editNamed(editingType.name) : text.newType),
			el(
				"label",
				{ className: "field" },
				el("span", {}, text.typeName),
				el("input", {
					value: state.draftName,
					placeholder: text.typeNamePlaceholder,
					oninput: (e) => {
						state.draftName = (e.target as HTMLInputElement).value;
					},
				}),
			),
			colorPicker(),
			el("h3", {}, text.properties),
			el(
				"div",
				{ className: "builtin" },
				el("p", {}, el("strong", {}, "id"), text.builtinId),
				el("p", {}, el("strong", {}, "name"), text.builtinName),
				el("p", {}, el("strong", {}, "description"), text.builtinDescription),
				// The template below belongs to content, so content comes last.
				el("p", {}, el("strong", {}, "content"), text.builtinContent),
				el(
					"label",
					{ className: "field wide" },
					el("span", {}, text.contentTemplate),
					el("textarea", {
						rows: 4,
						value: state.draftContentTemplate,
						oninput: (e) => {
							state.draftContentTemplate = (e.target as HTMLTextAreaElement).value;
						},
					}),
				),
			),
			...state.draftProps.map(propertyRow),
			el(
				"div",
				{ className: "row" },
				el(
					"button",
					{
						type: "button",
						onclick: () => {
							state.draftProps.push(newDraftProperty());
							rerender();
						},
					},
					text.addProperty,
				),
				el("button", { type: "submit", className: "primary" }, editingType ? text.save : text.createType),
				el(
					"button",
					{
						type: "button",
						onclick: () => {
							resetTypeForm();
							rerender();
						},
					},
					text.cancel,
				),
			),
			...state.typeErrors.map((error) => el("p", { className: "error" }, text.validation(error))),
		);

		const list = el(
			"ul",
			{ className: "type-list" },
			...store.data.types.map((type) =>
				el(
					"li",
					{ className: type.id === state.editingTypeId ? "type-item current" : "type-item" },
					// Name and buttons on top; the properties below, one per line, across the full width.
					el("strong", { className: "type-name" }, typeDot(type.color), type.name),
					type.properties.length > 0
						? el(
								"ul",
								{ className: "type-summary muted" },
								...type.properties.map((p) => el("li", {}, describeProperty(p, store.data.types))),
							)
						: el("p", { className: "type-summary muted" }, text.noProperties),
					el(
						"div",
						{ className: "actions" },
						el(
							"button",
							{
								type: "button",
								onclick: () => {
									state.editingTypeId = type.id;
									state.draftName = type.name;
									state.draftContentTemplate = type.contentTemplate;
								state.draftColor = type.color;
									state.draftProps = type.properties.map((p) => ({
										...p,
										options: [...p.options],
										reference: p.reference && { ...p.reference },
									}));
									state.typeErrors = [];
									state.focusForm = "type";
									rerender();
								},
							},
							text.edit,
						),
						el(
							"button",
							{
								type: "button",
								onclick: () => {
									const referrers = store.typeReferrers(type.id);
									if (referrers.length > 0) {
										alert(text.cannotDeleteType(type.name, referrers.join(", ")));
										return;
									}
									const count = store.data.entities.filter((e) => e.typeId === type.id).length;
									if (confirm(text.confirmDeleteType(type.name, count))) {
										store.deleteType(type.id);
										if (state.editingTypeId === type.id) resetTypeForm();
										rerender();
									}
								},
							},
							text.delete,
						),
					),
				),
			),
		);

		const createButton = el(
			"button",
			{
				type: "button",
				className: "primary",
				onclick: () => {
					resetTypeForm();
					state.creatingType = true;
					state.focusForm = "type";
					rerender();
				},
			},
			text.createNewType,
		);

		return el(
			"section",
			{},
			el("div", { className: "section-header" }, el("h2", {}, text.entityTypes), ...(editingType || state.creatingType ? [] : [createButton])),
			...(editingType || state.creatingType ? [form] : []),
			store.data.types.length > 0 ? list : el("p", { className: "muted" }, text.noTypesYet),
		);
	}

	function entitiesSection(): HTMLElement {
		const header = el("div", { className: "section-header" }, el("h2", {}, text.entities));
		const section = el("section", {}, header);
		const type = store.data.types.find((t) => t.id === state.selectedTypeId);
		if (!type) {
			section.append(el("p", { className: "muted" }, text.createTypeFirst));
			return section;
		}

		const typeSelect = el(
			"select",
			{
				ariaLabel: text.entityType,
				onchange: () => {
					state.selectedTypeId = typeSelect.value;
					state.editingEntityId = null;
					state.creatingEntity = false;
					rerender();
				},
			},
			...store.data.types.map((t) => el("option", { value: t.id, selected: t.id === type.id }, t.name)),
		);

		const entities = store.data.entities.filter((e) => e.typeId === type.id);
		const editing = entities.find((e) => e.id === state.editingEntityId);

		const formOpen = editing !== undefined || state.creatingEntity;
		const createButton = el(
			"button",
			{
				type: "button",
				className: "primary",
				onclick: () => {
					state.creatingEntity = true;
					state.focusForm = "entity";
					rerender();
				},
			},
			text.createNewEntity,
		);

		header.append(typeSelect, ...(formOpen ? [] : [createButton]));
		section.append(
			...(formOpen ? [entityForm(type, editing)] : []),
			entities.length > 0 ? entityTable(type, entities) : el("p", { className: "muted" }, text.noEntitiesOfType(type.name)),
		);
		return section;
	}

	function entityForm(type: EntityType, editing: Entity | undefined): HTMLFormElement {
		const nameInput = el("input", { required: true, pattern: ".*\\S.*", value: editing?.name ?? "" });
		const contentInput = el("textarea", { rows: 6, value: editing ? editing.content : type.contentTemplate });
		const descriptionInput = el("textarea", { rows: 10, value: editing?.description ?? "" });
		const fields = type.properties.map((prop) => propertyField(prop, editing?.values[prop.id] ?? null));

		return el(
			"form",
			{
				id: "entity-form",
				className: "card",
				onsubmit: (e) => {
					e.preventDefault();
					const name = nameInput.value;
					const values: Record<string, PropertyValue> = {};
					const entityTypes = entityTypeMap(store.data);
					for (const { prop, read } of fields) {
						values[prop.id] = parseValue(prop, read(), entityTypes);
					}
					if (editing) {
						store.updateEntity(editing.id, name, contentInput.value, values, descriptionInput.value);
					} else {
						store.addEntity(type.id, name, contentInput.value, values, descriptionInput.value);
					}
					state.editingEntityId = null;
					state.creatingEntity = false;
					rerender();
				},
			},
			el("h3", {}, editing ? text.editNamed(type.name) : text.newEntity(type.name)),
			...(editing
				? [el("p", { className: "field" }, el("span", {}, text.id), el("span", { className: "mono" }, editing.id))]
				: []),
			el("label", { className: "field" }, el("span", {}, text.name), nameInput),
			...fields.map((f) => f.element),
			...(editing ? inverseFields(editing) : []),
			el("label", { className: "field wide" }, el("span", {}, text.content), contentInput),
			el("label", { className: "field wide" }, el("span", {}, text.description), descriptionInput),
			el(
				"div",
				{ className: "row" },
				el("button", { type: "submit", className: "primary" }, editing ? text.save : text.create),
				el(
					"button",
					{
						type: "button",
						onclick: () => {
							state.editingEntityId = null;
							state.creatingEntity = false;
							rerender();
						},
					},
					text.cancel,
				),
			),
		);
	}

	/** Read-only fields for the reverse side of references (e.g. "responsible for"); edited on the other entities. */
	function inverseFields(entity: Entity): HTMLElement[] {
		const names = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const found = inverseReferences(store.data, entity);
		return inverseRelations(store.data.types, entity.typeId).map((relation) => {
			const ids = found.find((r) => r.prop.id === relation.prop.id)?.entityIds ?? [];
			const sourceType = store.data.types.find((t) => t.id === relation.sourceTypeId)?.name ?? "?";
			return el(
				"div",
				{ className: "field" },
				el("span", {}, relation.label),
				ids.length > 0
					? el("span", {}, ids.map((id) => names.get(id) ?? "?").join(", "))
					: el("span", { className: "muted" }, "—"),
				el("span", { className: "field-hint muted" }, text.setOn(sourceType, relation.prop.name)),
			);
		});
	}

	/** An input for one property in the entity form, plus a function reading its raw value. */
	function propertyField(
		prop: PropertyDef,
		current: PropertyValue,
	): { prop: PropertyDef; element: HTMLElement; read: () => string | string[] } {
		const label = el("span", {}, prop.name);
		if (prop.kind === "reference") {
			const targetType = store.data.types.find((t) => t.id === prop.reference?.typeId);
			const targets = store.data.entities.filter((e) => e.typeId === targetType?.id);
			const selected = new Set(current === null ? [] : typeof current === "string" ? [current] : current);
			if (targets.length === 0) {
				const note = el("span", { className: "muted" }, text.noEntitiesOfType(targetType?.name ?? ""));
				return { prop, element: el("div", { className: "field" }, label, note), read: () => [] };
			}
			if (prop.reference?.multiple) {
				const boxes = targets.map((t) => el("input", { type: "checkbox", value: t.id, checked: selected.has(t.id) }));
				const list = el(
					"div",
					{ className: "checklist" },
					...boxes.map((box, i) => el("label", {}, box, ` ${targets[i]!.name}`)),
				);
				return {
					prop,
					element: el("div", { className: "field" }, label, list),
					read: () => boxes.filter((b) => b.checked).map((b) => b.value),
				};
			}
			const select = el(
				"select",
				{},
				el("option", { value: "" }, "—"),
				...targets.map((t) => el("option", { value: t.id, selected: selected.has(t.id) }, t.name)),
			);
			return { prop, element: el("label", { className: "field" }, label, select), read: () => select.value };
		}
		const currentText = typeof current === "string" ? current : "";
		const input =
			prop.kind === "options"
				? el(
						"select",
						{},
						el("option", { value: "" }, "—"),
						...prop.options.map((o) => el("option", { value: o, selected: o === currentText }, o)),
					)
				: el("input", { value: currentText });
		return { prop, element: el("label", { className: "field" }, label, input), read: () => input.value };
	}

	function entityTable(type: EntityType, entities: Entity[]): HTMLElement {
		const names = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const format = (p: PropertyDef, value: PropertyValue | undefined): string => {
			if (value === null || value === undefined) return "—";
			const parts = typeof value === "string" ? [value] : value;
			return p.kind === "reference" ? parts.map((id) => names.get(id) ?? "?").join(", ") : parts.join(", ");
		};

		// Read-only columns for the reverse side of references to this type, e.g. "responsible for" on Role.
		const inverseColumns = inverseRelations(store.data.types, type.id);
		const sourceTypeName = (id: string) => store.data.types.find((t) => t.id === id)?.name ?? "?";
		const inverseCell = (entity: Entity, propId: string): string => {
			const ids = inverseReferences(store.data, entity).find((r) => r.prop.id === propId)?.entityIds ?? [];
			return ids.length > 0 ? ids.map((id) => names.get(id) ?? "?").join(", ") : "—";
		};

		const table = el(
			"table",
			{},
			el(
				"thead",
				{},
				el(
					"tr",
					{},
					el("th", {}, text.id),
					el("th", {}, text.name),
					...type.properties.map((p) => el("th", {}, p.name)),
					...inverseColumns.map((c) =>
						el("th", { className: "inverse", title: text.setOn(sourceTypeName(c.sourceTypeId), c.prop.name) }, c.label),
					),
					el("th", {}),
				),
			),
			el(
				"tbody",
				{},
				...entities.map((entity) =>
					el(
						"tr",
						{},
						el("td", { className: "mono nowrap", title: entity.id }, `…${entity.id.slice(-8)}`),
						el("td", {}, entity.name),
						...type.properties.map((p) => el("td", {}, format(p, entity.values[p.id]))),
						...inverseColumns.map((c) => el("td", { className: "inverse" }, inverseCell(entity, c.prop.id))),
						el(
							"td",
							{},
							el(
								"div",
								{ className: "actions" },
								el(
									"button",
									{
										type: "button",
										onclick: () => {
											state.editingEntityId = entity.id;
											state.focusForm = "entity";
											rerender();
										},
									},
									text.edit,
								),
								el(
									"button",
									{
										type: "button",
										onclick: () => {
											const refs = store.referencesTo(entity.id);
											if (confirm(text.confirmDeleteEntity(entity.name, refs))) {
												store.deleteEntity(entity.id);
												if (state.editingEntityId === entity.id) state.editingEntityId = null;
												rerender();
											}
										},
									},
									text.delete,
								),
							),
						),
					),
				),
			),
		);
		return el("div", { className: "table-wrap" }, table);
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
