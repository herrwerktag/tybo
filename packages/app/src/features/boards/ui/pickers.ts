import { nameTaken } from "../../../shared/core/index.js";
import { dragHandle, el, refused, reorderable, svgEl } from "../../../shared/ui/index.js";
import { text as dataText } from "../../data/texts.js";

const PICKER_MIME = "application/x-picker-index";
/** The pickers' row actions, drawn: a pencil (rename) and a bin (delete). */
const RENAME_ICON = "M10.5 2.5l3 3-8 8h-3v-3z M9 4l3 3";
const DELETE_ICON = "M2.5 4.5h11 M6 4.5V2.5h4v2 M4 4.5l.7 9h6.6l.7-9 M6.8 7v4 M9.2 7v4";

/**
 * A picker dropdown (boards): its items, the current one marked; clicking one picks it. In the editor (with
 * `editing`), each can be renamed in place and deleted, and a form below adds one; with `move`, too, the items can
 * be reordered. A name another item has is refused (see `nameTaken`).
 */
export interface Picker {
	dialog: HTMLDialogElement;
	title: string;
	items: readonly { id: string; name: string }[];
	currentId: string;
	/** The item shown with a name field instead, if any. */
	renamingId: string | null;
	pick(id: string): void;
	/** Draws the dropdown again (with an item being renamed). */
	rerender(renamingId?: string | null): void;
	editing?: {
		renameTitle: string;
		deleteTitle: string;
		rename(id: string, name: string): void;
		remove(id: string): void;
		newTitle: string;
		newName: string;
		add(name: string): void;
		/** Why a name is refused: another item has it. */
		nameTaken(name: string): string;
		/** Moves the item to index `to` among the items. */
		move?(id: string, to: number): void;
		/** The label of an item's drag handle. */
		moveTitle?(name: string): string;
	};
}

/** A row's rename or delete in a picker: a small drawn icon, its name in the tooltip. */
function pickerAction(title: string, icon: string, onclick: () => void): HTMLButtonElement {
	return el(
		"button",
		{ type: "button", className: "picker-action", title, ariaLabel: title, onclick },
		svgEl("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, svgEl("path", { d: icon })),
	);
}

export function renderPicker({ dialog, title, items, currentId, renamingId, pick, rerender, editing }: Picker): void {
	const refusal = (name: string, selfId: string | null) => (editing && nameTaken(items, name, selfId) ? editing.nameTaken(name.trim()) : null);
	const rows = items.map((item, i) => {
		if (editing && item.id === renamingId) {
			const input = el("input", { value: item.name, ariaLabel: editing.renameTitle, required: true });
			// Escape leaves the name as it was, instead of closing the dropdown.
			input.addEventListener("keydown", (e) => {
				if (e.key !== "Escape") return;
				e.preventDefault();
				rerender();
			});
			requestAnimationFrame(() => input.select());
			return el(
				"li",
				{},
				el(
					"form",
					{
						className: "picker-rename",
						onsubmit: (e: SubmitEvent) => {
							e.preventDefault();
							if (refused(input, refusal(input.value, item.id))) return;
							editing.rename(item.id, input.value);
							rerender();
						},
					},
					input,
					el("button", { type: "submit", className: "primary" }, dataText.save),
					el("button", { type: "button", onclick: () => rerender() }, dataText.cancel),
				),
			);
		}
		const option = el(
			"button",
			{
				type: "button",
				className: "picker-option",
				title: item.name,
				onclick: () => {
					dialog.close();
					if (item.id !== currentId) pick(item.id);
				},
			},
			item.name,
		);
		if (item.id === currentId) option.setAttribute("aria-current", "true");
		if (!editing) return el("li", {}, option);
		const { move, moveTitle } = editing;
		const handle = move ? dragHandle(moveTitle?.(item.name) ?? item.name, item.id) : null;
		const row = el(
			"li",
			{},
			...(handle ? [handle] : []),
			option,
			pickerAction(editing.renameTitle, RENAME_ICON, () => rerender(item.id)),
			pickerAction(editing.deleteTitle, DELETE_ICON, () => editing.remove(item.id)),
		);
		if (handle && move) {
			reorderable(row, handle, {
				index: i,
				count: items.length,
				mime: PICKER_MIME,
				move: (from, to) => {
					const moved = items[from]!.id;
					move(moved, to);
					rerender();
					dialog.querySelector<HTMLElement>(`.drag-handle[data-focus-key="${moved}"]`)?.focus();
				},
			});
		}
		return row;
	});

	const nameInput = el("input", { ariaLabel: dataText.name, value: editing?.newName ?? "", required: true });
	const newForm = el(
		"form",
		{
			className: "picker-new",
			onsubmit: (e: SubmitEvent) => {
				e.preventDefault();
				if (refused(nameInput, refusal(nameInput.value, null))) return;
				dialog.close();
				editing?.add(nameInput.value);
			},
		},
		el("h3", {}, editing?.newTitle ?? ""),
		nameInput,
		el("button", { type: "submit", className: "primary" }, dataText.create),
	);
	dialog.replaceChildren(el("h2", {}, title), el("ul", { className: "picker-list" }, ...rows), ...(editing ? [newForm] : []));
}

/**
 * A picker as a dropdown under its button (`buttonClass`, showing what's current), the way the workspace menu opens:
 * a dialog that isn't modal, filled by `render` as it opens. Picking closes it, and so do Escape, a click beside it,
 * or its button again.
 */
export function pickerDropdown(dialogClass: string, label: string, buttonClass: string, title: string, render: () => void) {
	const dialog: HTMLDialogElement = el("dialog", { className: `picker-dropdown ${dialogClass}`, ariaLabel: label });
	const button = el("button", {
		type: "button",
		className: `picker-switch ${buttonClass}`,
		title,
		ariaHasPopup: "dialog",
		onclick: () => (dialog.open ? dialog.close() : open()),
	});
	button.setAttribute("aria-expanded", "false");
	function open(): void {
		render();
		dialog.show();
		// Under the button, kept on the screen; what doesn't fit below scrolls.
		const at = button.getBoundingClientRect();
		dialog.style.top = `${at.bottom + 6}px`;
		dialog.style.left = `${Math.max(8, Math.min(at.left, innerWidth - dialog.offsetWidth - 8))}px`;
		dialog.style.maxHeight = `${innerHeight - at.bottom - 14}px`;
		button.setAttribute("aria-expanded", "true");
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
	}
	function onPointerDown(e: PointerEvent): void {
		if (!dialog.contains(e.target as Node) && !button.contains(e.target as Node)) dialog.close();
	}
	function onKeyDown(e: KeyboardEvent): void {
		// A rename field takes its own Escape (it keeps the old name).
		if (e.key !== "Escape" || e.defaultPrevented) return;
		dialog.close();
		button.focus();
	}
	dialog.addEventListener("close", () => {
		button.setAttribute("aria-expanded", "false");
		document.removeEventListener("pointerdown", onPointerDown);
		document.removeEventListener("keydown", onKeyDown);
	});
	return { dialog, button };
}
export const pickerLabel = (name: string) => [el("span", { className: "picker-name" }, name), el("span", { ariaHidden: "true" }, "▾")];
