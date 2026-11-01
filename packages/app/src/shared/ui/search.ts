import { el, typeDot } from "./dom.js";
import { text } from "./texts.js";

/** Something the search finds or offers: where it leads (`href`) or what it does (`run`). */
export interface SearchEntry {
	label: string;
	/** What it is, in short (its type, say), after its name. */
	detail?: string;
	/** A dot in this color before it (an entity's type, say). */
	color?: string;
	href?: string;
	run?: () => void;
}

/** What a feature puts into the search (see `ShellParts.search`): the things it finds by name, and what it offers to
 * do — never to delete. */
export interface SearchSource<S> {
	items?(store: S): SearchEntry[];
	actions?(store: S): SearchEntry[];
}

/** How many found things are listed at most. */
const SHOWN = 50;

/** A name as the search compares it: without case and accents. */
const searchKey = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();

/**
 * The search over the workspace (⌘K / Ctrl+K): a field and a list below it, as a combobox. Empty, it offers the
 * actions; typed into, it lists what has that in its name — at the start first — and the actions that do. Arrow
 * keys choose, Enter goes there (or does it), Escape closes.
 */
export function searchDialog(): { dialog: HTMLDialogElement; open(items: SearchEntry[], actions: SearchEntry[]): void } {
	const input = el("input", {
		type: "search",
		role: "combobox",
		placeholder: text.searchPlaceholder,
		ariaLabel: text.search,
		autocomplete: "off",
	});
	const list = el("ul", { className: "search-list", role: "listbox", id: "search-list", ariaLabel: text.search });
	const note = el("p", { className: "muted search-note" });
	input.setAttribute("aria-controls", list.id);
	input.setAttribute("aria-expanded", "true");
	const dialog: HTMLDialogElement = el(
		"dialog",
		{
			className: "search-dialog",
			ariaLabel: text.search,
			// No expression body: an on… handler returning false would cancel every click inside.
			onclick: (e: MouseEvent) => {
				if (e.target === dialog) dialog.close();
			},
		},
		input,
		list,
		note,
	);

	let items: SearchEntry[] = [];
	let actions: SearchEntry[] = [];
	let shown: SearchEntry[] = [];
	let active = 0;

	function go(entry: SearchEntry): void {
		dialog.close();
		if (entry.run) entry.run();
		else if (entry.href) {
			// The same address again still goes there (scrolls to the row, opens the form).
			if (location.hash === entry.href) window.dispatchEvent(new HashChangeEvent("hashchange"));
			else location.hash = entry.href;
		}
	}

	function render(): void {
		const key = searchKey(input.value.trim());
		const matching = (entries: SearchEntry[]) => {
			const hits = entries.filter((e) => searchKey(e.label).includes(key));
			// Those starting with what was typed first; otherwise in the order given.
			return key === "" ? hits : [...hits.filter((e) => searchKey(e.label).startsWith(key)), ...hits.filter((e) => !searchKey(e.label).startsWith(key))];
		};
		const found = key === "" ? [] : matching(items);
		const offered = matching(actions);
		shown = [...found.slice(0, SHOWN), ...offered];
		active = Math.min(active, Math.max(shown.length - 1, 0));
		const option = (entry: SearchEntry, i: number) => {
			const item = el(
				"li",
				{ id: `search-option-${i}`, role: "option", className: i === active ? "search-option active" : "search-option", ariaSelected: String(i === active) },
				...(entry.color ? [typeDot(entry.color)] : []),
				el("span", { className: "search-label" }, entry.label),
				...(entry.detail ? [el("span", { className: "search-detail muted" }, entry.detail)] : []),
			);
			item.addEventListener("pointerdown", (e) => e.preventDefault()); // the field keeps the focus
			item.addEventListener("click", () => go(entry));
			return item;
		};
		list.replaceChildren(
			...found.slice(0, SHOWN).map(option),
			...(offered.length > 0 ? [el("li", { className: "search-heading", role: "presentation" }, text.searchActions)] : []),
			...offered.map((entry, i) => option(entry, Math.min(found.length, SHOWN) + i)),
		);
		input.setAttribute("aria-activedescendant", shown.length > 0 ? `search-option-${active}` : "");
		note.textContent = found.length > SHOWN ? text.searchMore(SHOWN, found.length) : shown.length === 0 ? text.searchNoMatches : "";
		note.hidden = note.textContent === "";
		list.querySelector(".active")?.scrollIntoView?.({ block: "nearest" });
	}

	input.addEventListener("input", () => {
		active = 0;
		render();
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			if (shown.length === 0) return;
			active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
			render();
		} else if (e.key === "Enter") {
			e.preventDefault();
			const entry = shown[active];
			if (entry) go(entry);
		}
	});

	return {
		dialog,
		open(found, offered) {
			items = found;
			actions = offered;
			input.value = "";
			active = 0;
			render();
			if (!dialog.open) dialog.showModal();
			input.focus();
		},
	};
}
