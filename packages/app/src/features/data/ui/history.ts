import type { Store } from "../../../features.core.js";
import { isRecord, type HistoryField, type UnitDescriber } from "../../../shared/ui/index.js";
import { TYPE_COLORS, type EntityType, type PropertyDef } from "../core.js";
import { text } from "../texts.js";

/** A list of texts in a stand, or null when it isn't one. */
const texts = (value: unknown): string[] | null => (Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null);

/** A type's color by its name in the palette, else as saved. */
function colorName(color: string): string {
	const named = TYPE_COLORS.find((c) => c.value === color)?.name;
	return named ? (text.colorNames[named] ?? named) : color;
}

/** How the history tells of an entity type: its color, its properties (name and kind), its template. */
export const TYPE_HISTORY: UnitDescriber<Store> = {
	kind: "type",
	noun: text.historyTypes,
	read(value) {
		if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.properties)) return null;
		const properties = (value.properties as unknown[]).filter(isRecord).map((p) => `${String(p.name)} (${text.kinds[p.kind as PropertyDef["kind"]] ?? String(p.kind)})`);
		return {
			name: value.name,
			fields: [
				{ label: text.color, text: typeof value.color === "string" ? colorName(value.color) : "" },
				{ label: text.properties, text: properties.join(", ") },
				{ label: text.contentTemplate, text: typeof value.contentTemplate === "string" ? value.contentTemplate : "", long: true },
			],
		};
	},
};

/** How the history tells of an entity: its type, its tags and property values — references by the names of the
 * entities they point to, as far as they're still there — its content and description. Its values are read with
 * the type as it is now; a value of a property gone since isn't shown. */
export const ENTITY_HISTORY: UnitDescriber<Store> = {
	kind: "entity",
	noun: text.historyEntities,
	read(value, store) {
		if (!isRecord(value) || typeof value.name !== "string" || typeof value.typeId !== "string") return null;
		const type: EntityType | undefined = store.data.types.find((t) => t.id === value.typeId);
		const values = isRecord(value.values) ? value.values : {};
		const names = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const shown = (prop: PropertyDef, raw: unknown): string => {
			const parts = typeof raw === "string" ? [raw] : (texts(raw) ?? []);
			return (prop.kind === "reference" ? parts.map((id) => names.get(id) ?? text.historyGone) : parts).join(", ");
		};
		const fields: HistoryField[] = [
			{ label: text.tags, text: (texts(value.tags) ?? []).join(", ") },
			...(type?.properties ?? []).map((prop) => ({ label: prop.name, text: shown(prop, values[prop.id]) })),
			{ label: text.content, text: typeof value.content === "string" ? value.content : "", long: true },
			{ label: text.description, text: typeof value.description === "string" ? value.description : "", long: true },
		];
		return { name: value.name, context: type?.name ?? "?", fields };
	},
};
