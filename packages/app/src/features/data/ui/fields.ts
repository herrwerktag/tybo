import { el, icon, refused } from "../../../shared/ui/index.js";
import { entityTypeMap, parseTags, parseValue, type DataStore, type Entity, type PropertyDef, type PropertyValue } from "../core.js";
import { text } from "../texts.js";
import { propertyField } from "./entity-form.js";

/** What an entity's field editor reads: the part of the entity it changes. */
export type EntityPatch = Partial<Pick<Entity, "name" | "content" | "description" | "tags">> & { values?: Record<string, PropertyValue> };

/** An editor in a field's place: what it shows, what gets the focus, how its value is read (null: refused, it says
 * why at its control), and how it saves — when left or on Enter, or on every change (a choice is the edit). */
interface FieldEditor {
	element: HTMLElement;
	focus: HTMLElement;
	read(): EntityPatch | null;
	/** Saves as soon as it changes: a select, a reference's tags. */
	saveOnChange?: boolean;
	/** Stays open after saving, for the next change (a multiple reference's tags). */
	keepOpen?: boolean;
	/** Enter saves only with ⌘/Ctrl, as Enter alone makes a new line. */
	multiline?: boolean;
}

/**
 * Saves `patch` to the entity as one change — one step to undo, one entry in the history; nothing when nothing
 * changes. Whether something was saved.
 */
export function saveEntity(store: DataStore, entity: Entity, patch: EntityPatch): boolean {
	const next = { ...entity, ...patch, values: patch.values ? { ...entity.values, ...patch.values } : entity.values };
	if (patch.name !== undefined) next.name = patch.name.trim();
	const same =
		next.name === entity.name &&
		next.content === entity.content &&
		next.description === entity.description &&
		next.tags.join("\u0000") === entity.tags.join("\u0000") &&
		JSON.stringify(next.values) === JSON.stringify(entity.values);
	if (same) return false;
	store.updateEntity(entity.id, next.name, next.content, next.values, next.description, next.tags);
	return true;
}

/**
 * The fields of the entities a view shows, each to be edited on its own: a value is shown until clicked (or Enter on
 * it; a reference, whose tags lead elsewhere, by its pencil), then an editor stands in its place — a form of its own, so
 * someone else's changes wait while it's open. Enter or leaving it saves (`saveEntity`), Escape gives the value
 * back. `redraw` draws the view anew (after closing a field without a change, say), `onSaved` after a save (by
 * default the same).
 */
export function fieldEditing(store: DataStore, redraw: () => void, onSaved: () => void = redraw) {
	/** The field being edited, by its key (`<entity>:<field>`). */
	let open: string | null = null;

	function close(): void {
		open = null;
		redraw();
	}

	/** The field `field` of `entity` (see `fieldEditing`): `shown` while closed, `editor()` while open. */
	function field(
		entity: Entity,
		field: string,
		{ label, shown, editor, byButton = false }: { label: string; shown: Node[]; editor: () => FieldEditor; byButton?: boolean },
	): HTMLElement {
		const key = `${entity.id}:${field}`;
		if (open !== key) {
			const start = () => {
				open = key;
				redraw();
			};
			if (byButton) {
				return el(
					"div",
					{ className: "field-value" },
					...shown,
					el("button", { type: "button", className: "field-edit", title: text.editField(label), ariaLabel: text.editField(label), onclick: start }, icon("edit")),
				);
			}
			const value = el("div", { className: "field-value editable", role: "button", tabIndex: 0, title: text.editField(label), ariaLabel: text.editField(label) }, ...shown);
			value.addEventListener("click", (e) => {
				// A link in it (a reference) goes where it leads.
				if (!(e.target as Element).closest("a, button")) start();
			});
			value.addEventListener("keydown", (e) => {
				if (e.key !== "Enter" && e.key !== "F2") return;
				e.preventDefault();
				start();
			});
			return value;
		}

		const made = editor();
		const form = el("form", { className: "field-editor", ariaLabel: label }, made.element);
		form.dataset.field = key;
		let done = false;
		const commit = () => {
			if (done) return;
			const patch = made.read();
			if (patch === null) return; // refused: it says why, and stays open
			done = !made.keepOpen;
			if (!made.keepOpen) open = null;
			const current = store.data.entities.find((e) => e.id === entity.id);
			// Gone meanwhile: nothing to save to.
			if (current && saveEntity(store, current, patch)) onSaved();
			else if (!made.keepOpen) redraw();
		};
		form.addEventListener("submit", (e) => {
			e.preventDefault();
			commit();
		});
		form.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation(); // closes the field, not the panel around it
				done = true;
				close();
			} else if (e.key === "Enter" && made.multiline && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				commit();
			}
		});
		if (made.saveOnChange) form.addEventListener("change", commit);
		// Leaving it saves (or, saving on every change, just closes it) — once the focus has settled elsewhere: a
		// control drawn anew inside it takes the focus back.
		form.addEventListener("focusout", () => {
			setTimeout(() => {
				if (done || !form.isConnected || form.contains(document.activeElement)) return;
				if (made.saveOnChange) {
					done = true;
					close();
				} else commit();
			});
		});
		// Focused once on the page (the view is drawn into it right after).
		queueMicrotask(() => {
			if (form.isConnected && !form.contains(document.activeElement)) {
				made.focus.focus();
				if (made.focus instanceof HTMLInputElement) made.focus.select();
			}
		});
		return form;
	}

	/** A one-line text: the name (which may not be empty) or the tags. */
	function textEditor(value: string, read: (input: HTMLInputElement) => EntityPatch | null): FieldEditor {
		const input = el("input", { value });
		return { element: input, focus: input, read: () => read(input) };
	}

	return {
		field,
		/** Whether a field of the view is open (its view keeps it while drawn anew). */
		isOpen: () => open !== null,
		/** The name, never empty. */
		name: (entity: Entity, shown: Node[]) =>
			field(entity, "name", {
				label: text.nameField,
				shown,
				editor: () =>
					textEditor(entity.name, (input) => (refused(input, input.value.trim() === "" ? text.nameRequired : null) ? null : { name: input.value })),
			}),
		/** The description or the content: Markdown, edited as written. */
		markdown: (entity: Entity, which: "description" | "content", label: string, shown: Node[]) =>
			field(entity, which, {
				label,
				shown,
				editor: () => {
					const area = el("textarea", { rows: which === "description" ? 10 : 5, value: entity[which] });
					return { element: area, focus: area, read: () => ({ [which]: area.value }), multiline: true };
				},
			}),
		/** The tags, separated by commas. */
		tags: (entity: Entity, shown: Node[]) =>
			field(entity, "tags", {
				label: text.tags,
				shown,
				editor: () => {
					const editor = textEditor(entity.tags.join(", "), (input) => ({ tags: parseTags(input.value) }));
					(editor.element as HTMLInputElement).placeholder = text.tagsHint;
					return editor;
				},
			}),
		/** A property: a text, an options property's select, a reference's select or tags (by its pencil). */
		property: (entity: Entity, prop: PropertyDef, shown: Node[]) =>
			field(entity, `prop:${prop.id}`, {
				label: prop.name,
				shown,
				byButton: prop.kind === "reference",
				editor: () => {
					const multiple = prop.kind === "reference" && prop.reference?.multiple === true;
					let changed = () => {};
					const made = propertyField(store, prop, entity.values[prop.id] ?? null, () => changed());
					const read = (): EntityPatch => ({ values: { [prop.id]: parseValue(prop, made.read(), entityTypeMap(store.data)) } });
					// The field's own label is the row's already.
					const control = made.element.querySelector<HTMLElement>("input, select, .reference-values") ?? made.element;
					const focus = made.element.querySelector<HTMLElement>("input, select") ?? control;
					const editor: FieldEditor = { element: control, focus, read, saveOnChange: prop.kind !== "text", keepOpen: multiple };
					// A multiple reference saves each tag added or taken out, as the form's change.
					changed = () => control.closest("form")?.dispatchEvent(new Event("change"));
					return editor;
				},
			}),
	};
}

export type FieldEditing = ReturnType<typeof fieldEditing>;
