import { messages } from "./i18n.js";

/** Messages of the controls in shared/ui, which several features use. */
const en = {
	resizePanel: "Drag to change the width; double-click to reset",
	filterByTag: "Filter by tag",
	allTags: "All tags",
	dragToReorder: "Drag to reorder, or use the arrow keys",
};

export const text = messages<typeof en>({
	en,
	de: {
		resizePanel: "Ziehen ändert die Breite, Doppelklick setzt sie zurück",
		filterByTag: "Nach Tag filtern",
		allTags: "Alle Tags",
		dragToReorder: "Ziehen zum Umsortieren, oder die Pfeiltasten verwenden",
	},
});
