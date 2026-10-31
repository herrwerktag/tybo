import type { DataStore } from "../core.js";
import { el, type EntityLink, type Page, type PageMaker, type Shell } from "../../../shared/ui/index.js";
import { text } from "../texts.js";
import { entitiesSection } from "./entities-section.js";
import { typesSection } from "./types-section.js";

/** What the data pages' sections get from the page. */
export interface DataPage {
	/** Draws the page anew. */
	rerender(): void;
	/** After the next drawing, scrolls this form into view and focuses it (e.g. when Edit is clicked). */
	focusForm(form: "type" | "entity"): void;
	/** After the next drawing, focuses the drag handle with this `data-focus-key`, so keyboard reordering keeps focus
	 * on the moved item. */
	focusHandle(key: string): void;
	/** In place of the data pages' heading: switches between them, the entity types and the entities. */
	dataSwitch(route: "types" | "entities"): HTMLElement;
}

/**
 * The Data tab: the entity types with their properties (#types), and the entities of a type in a table (#entities),
 * each with its form — where the features' `entityLinks` lead from an entity to their pages. What is being edited
 * stays while the page is drawn anew; another workspace starts afresh.
 */
export function dataPage({ entityLinks = [] }: { entityLinks?: readonly EntityLink[] } = {}): PageMaker<DataStore> {
	return (shell) => dataPageIn(shell, entityLinks);
}

function dataPageIn(shell: Shell, entityLinks: readonly EntityLink[]): Page<DataStore> {
	/** The store the page last started afresh for. */
	let shownStore: DataStore | null = null;
	let focusForm: "type" | "entity" | null = null;
	let focusHandle: string | null = null;
	const page: DataPage = {
		rerender: () => shell.rerender(),
		focusForm: (form) => {
			focusForm = form;
		},
		focusHandle: (key) => {
			focusHandle = key;
		},
		dataSwitch(route) {
			const tab = (id: "types" | "entities", label: string) =>
				el("a", { href: `#${id}`, className: route === id ? "current" : "" }, label);
			const nav = el("nav", { className: "data-switch", ariaLabel: text.tabEntities }, tab("types", text.entityTypes), tab("entities", text.entities));
			nav.querySelector(".current")?.setAttribute("aria-current", "page");
			return nav;
		},
	};
	const entities = entitiesSection(page, entityLinks);
	// A type just saved: the entities page shows its entities.
	const types = typesSection(page, { onSaved: (typeId) => entities.showType(typeId) });

	return {
		routes: ["entities", "types"],
		label: () => text.tabEntities,
		render(current: DataStore): HTMLElement {
			if (current !== shownStore) {
				// Another workspace (or the first): nothing of the one before is being edited here.
				shownStore = current;
				types.reset(current);
				entities.reset(current);
			}
			const route = location.hash.slice(1).split("/")[0] === "types" ? "types" : "entities";
			return el("div", { className: "data-view" }, route === "types" ? types.render(current) : entities.render(current));
		},
		afterRender(root: HTMLElement): void {
			if (focusHandle !== null) {
				root.querySelector<HTMLElement>(`.drag-handle[data-focus-key="${focusHandle}"]`)?.focus();
				focusHandle = null;
			}
			if (focusForm) {
				const form = root.querySelector<HTMLFormElement>(`#${focusForm}-form`);
				focusForm = null;
				form?.scrollIntoView({ block: "nearest", behavior: "smooth" });
				form?.querySelector<HTMLElement>("input, select, textarea")?.focus({ preventScroll: true });
			}
		},
	};
}
