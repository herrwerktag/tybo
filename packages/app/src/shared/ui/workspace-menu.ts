import { freeName, nameTaken, readWorkspaceFileOf, type DataFormat, type StoreCore, type WorkspacesOf } from "../core/index.js";
import { dragHandle, el, refused, reorderable } from "./dom.js";
import { text } from "./texts.js";

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

const WORKSPACE_MIME = "application/x-workspace-index";

/** What the workspace menu works with: the workspaces, the active one's store, the features' parts of the menu, and
 * what the shell does for it. */
export interface WorkspaceMenu<D, S> {
	workspaces: WorkspacesOf<D, S>;
	/** The active workspace's data. */
	store: S;
	format: DataFormat<D>;
	workspaceActions: readonly WorkspaceAction<S>[];
	newWorkspaceOptions: readonly NewWorkspaceOption<D, S>[];
	/** The question before deleting the workspace named, saying what it holds. */
	deleteQuestion(name: string, store: S): string;
	rerender(): void;
	/** Opens another workspace: its own data, in the same tab. */
	switchWorkspace(id: string): Promise<void>;
	/** Downloads the active workspace as a file. */
	exportWorkspace(): void;
	/** After the next drawing, focuses the drag handle with this `data-focus-key` (keyboard reordering). */
	focusHandle(key: string): void;
}

/**
 * The workspace menu: its button, the current workspace's name, and what its panel holds — the list of workspaces (to
 * switch to and reorder), rename and delete, export, the features' actions and import, and the form for a new one.
 */
export function workspaceMenu<D, S extends StoreCore<D>>(menu: WorkspaceMenu<D, S>): { button: HTMLButtonElement; content: Node[] } {
	const { workspaces, store, rerender, switchWorkspace } = menu;
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
					menu.focusHandle(`workspace:${moved}`);
					rerender();
				},
			});
			return item;
		}),
	);

	const nameInput = el("input", {
		ariaLabel: text.name,
		value: freeName(workspaces.list, text.defaultWorkspaceName),
	});
	const options = menu.newWorkspaceOptions.map((option) => ({
		option,
		checkbox: el("input", { type: "checkbox", disabled: !option.available(store) }),
	}));
	const newForm = el(
		"form",
		{
			className: "workspace-new",
			onsubmit: async (e) => {
				e.preventDefault();
				if (refused(nameInput, nameTaken(workspaces.list, nameInput.value) ? text.workspaceNameTaken(nameInput.value.trim()) : null)) return;
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
			const read = readWorkspaceFileOf(menu.format, await file.text().catch(() => ""));
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
				onclick: menu.exportWorkspace,
			},
			text.exportButton,
		),
		...menu.workspaceActions.map((action) =>
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
	return {
		button,
		content: [
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
							if (nameTaken(workspaces.list, name, current.id)) return alert(text.workspaceNameTaken(name.trim()));
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
							if (!confirm(menu.deleteQuestion(current.name, store))) return;
							workspaces.remove(current.id);
							switchWorkspace(workspaces.active.id);
						},
					},
					text.delete,
				),
			),
			transfer,
			newForm,
		],
	};
}
