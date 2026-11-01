import { svgEl } from "./dom.js";

/** Line icons on a 16×16 grid, drawn with the text color (see .icon in app.css). */
const ICONS = {
	/** A stack of layers: the workspaces. */
	workspaces: "M8 2.5 14 5.5 8 8.5 2 5.5ZM2 8.5l6 3 6-3M2 11l6 3 6-3",
	/** A menu or dropdown opens below. */
	chevronDown: "m4.5 6.5 3.5 3.5 3.5-3.5",
	/** Folded away upwards. */
	chevronUp: "m4.5 9.5 3.5-3.5 3.5 3.5",
	/** Settings: two sliders. */
	settings: "M2.5 5h3.5m3 0h4.5M2.5 11h6.5m3 0h1.5M6 5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M9 11a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0",
	/** Folds a side panel away (to the left). */
	panelClose: "M2.5 3h11v10h-11ZM6 3v10M10.5 6 8.5 8l2 2",
	/** Brings a folded side panel back. */
	panelOpen: "M2.5 3h11v10h-11ZM6 3v10M9 6l2 2-2 2",
} as const;

export type IconName = keyof typeof ICONS;

/** An icon for a button or label; its name belongs in the button's title and aria-label. */
export function icon(name: IconName): SVGSVGElement {
	return svgEl("svg", { class: "icon", viewBox: "0 0 16 16", "aria-hidden": "true" }, svgEl("path", { d: ICONS[name] }));
}
