import { el } from "./dom.js";

/** The next step an empty list offers: a link to where it's done, or a button doing it. */
export interface NextStep {
	label: string;
	href?: string;
	run?: () => void;
}

/** What an empty list shows instead: one sentence saying what belongs in it, and at most one step to take next — the
 * page's main one then, so a button for it elsewhere on the page steps aside. */
export function emptyState(message: string, step?: NextStep): HTMLElement {
	const action = step?.href
		? el("a", { className: "button primary", href: step.href }, step.label)
		: step?.run
			? el("button", { type: "button", className: "primary", onclick: step.run }, step.label)
			: null;
	return el("div", { className: "empty-state" }, el("p", { className: "muted" }, message), ...(action ? [action] : []));
}
