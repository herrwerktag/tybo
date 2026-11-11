import { el, renderMarkdown } from "../../../shared/ui/index.js";
import type { EntityType, PropertyDef } from "../core.js";
import { text } from "../texts.js";

/** The types whose guide is unfolded: it stays so while the view around it is drawn anew (a field saved, someone
 * else's change taken over) — it is read while filling in. */
const openGuides = new Set<string>();

/**
 * A type's help where its entities are made and read: what it is for, in a sentence, and its guide to unfold.
 * Nothing for a type without either.
 */
export function typeHelp(type: EntityType | undefined): HTMLElement[] {
	if (!type || (type.description === "" && type.guide === "")) return [];
	const help = el("div", { className: "type-help" });
	if (type.description !== "") help.append(el("p", { className: "type-help-description" }, type.description));
	if (type.guide !== "") {
		const guide = el("details", { className: "type-help-guide", open: openGuides.has(type.id) }, el("summary", {}, text.typeGuideOf(type.name)), renderMarkdown(type.guide));
		guide.addEventListener("toggle", () => {
			if (guide.open) openGuides.add(type.id);
			else openGuides.delete(type.id);
		});
		help.append(guide);
	}
	return [help];
}

/** A property's note at its field, where its value is entered; nothing without one. */
export function propertyHint(prop: PropertyDef): HTMLElement[] {
	return prop.description === "" ? [] : [el("small", { className: "field-hint" }, prop.description)];
}
