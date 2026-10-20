import { fillPlaceholders, referencedIds, type AppData, type Entity, type EntityType, type PropertyDef } from "@tybo/core";
import { text } from "./i18n.js";

/**
 * A workspace as plain text for reading, e.g. by an LLM: first the entity types, then one section per entity with
 * its properties and the references to it, each naming the other entity by type and name. Every section stands on
 * its own, so it still makes sense when the text is cut into pieces. Boards and drawings are left out, and so are
 * the card display settings: every property with a value is in, like in the details panel.
 */
export function workspaceText(name: string, data: Pick<AppData, "types" | "entities">, date: string): string {
	const types = new Map(data.types.map((t) => [t.id, t]));
	const entities = data.entities.filter((e) => types.has(e.typeId));
	const names = uniqueNames(entities);
	const mentions = new Map(entities.map((e) => [e.id, text.textExportEntity(types.get(e.typeId)!.name, names.get(e.id)!)]));
	// The other side of references: per referenced entity and property id, the entities referencing it, in entity order.
	const referencing = new Map<string, Map<string, string[]>>();
	for (const e of entities) {
		for (const prop of types.get(e.typeId)!.properties) {
			for (const id of referencedIds(prop, e.values[prop.id])) {
				const byProp = referencing.get(id) ?? new Map<string, string[]>();
				byProp.set(prop.id, [...(byProp.get(prop.id) ?? []), e.id]);
				referencing.set(id, byProp);
			}
		}
	}
	const sections = [
		`# ${text.textExportTitle(name, date)}\n\n${text.textExportIntro}`,
		[`## ${text.textExportTypes}`, ...data.types.map((type) => typeSection(type, types))].join("\n\n"),
		...data.types.flatMap((type) =>
			entities
				.filter((e) => e.typeId === type.id)
				.map((e) => entitySection(data.types, type, e, mentions, referencing.get(e.id) ?? new Map())),
		),
	];
	return `${sections.join("\n\n")}\n`;
}

function typeSection(type: EntityType, types: ReadonlyMap<string, EntityType>): string {
	const lines = type.properties.map((prop) => {
		let kind = text.kinds[prop.kind];
		if (prop.kind === "options" && prop.options.length > 0) kind += ` (${prop.options.join(", ")})`;
		if (prop.kind === "reference" && prop.reference) {
			kind += ` → ${prop.reference.typeIds.flatMap((id) => types.get(id)?.name ?? []).join(", ")}`;
			if (prop.reference.multiple) kind += ` ${text.multipleSuffix}`;
		}
		return `- ${prop.name}: ${kind}`;
	});
	return [`### ${type.name}`, ...(lines.length > 0 ? lines : [`- ${text.noProperties}`])].join("\n");
}

function entitySection(
	types: readonly EntityType[],
	type: EntityType,
	entity: Entity,
	mentions: ReadonlyMap<string, string>,
	referencing: ReadonlyMap<string, string[]>,
): string {
	const lines = [`## ${mentions.get(entity.id)!}`];
	if (entity.tags.length > 0) lines.push(`${text.tags}: ${entity.tags.join(", ")}`);
	for (const prop of type.properties) {
		const value = entity.values[prop.id];
		if (prop.kind === "reference") {
			const linked = referencedIds(prop, value).flatMap((id) => mentions.get(id) ?? []);
			if (linked.length > 0) lines.push(`${prop.name}: ${linked.join(", ")}`);
		} else if (typeof value === "string" && value.trim() !== "") {
			lines.push(field(prop.name, value));
		}
	}
	// The other side of references, in type and property order, whether or not they have a label for it.
	for (const prop of types.flatMap((t) => t.properties)) {
		const linked = referencing.get(prop.id);
		if (!linked) continue;
		const label = prop.reference?.inverseLabel.trim() || text.textExportReferencedVia(prop.name);
		lines.push(`${label}: ${linked.map((id) => mentions.get(id)!).join(", ")}`);
	}
	if (entity.content.trim() !== "") lines.push(field(text.content, entity.content));
	// {{Property}} in the description: the value, references by type and name like above, "—" when empty.
	const placeholder = (prop: PropertyDef): string => {
		const value = entity.values[prop.id];
		const linked = referencedIds(prop, value).flatMap((id) => mentions.get(id) ?? []);
		const shown = prop.kind === "reference" ? linked.join(", ") : typeof value === "string" ? value.trim() : "";
		return shown || "—";
	};
	if (entity.description.trim() !== "") lines.push(field(text.description, fillPlaceholders(entity.description, type, placeholder)));
	return lines.join("\n");
}

/**
 * "Label: value" for one line; several lines go below the label, indented, so they read as part of it. A "#" at the
 * start of a line is escaped, so free text never reads as a heading of its own.
 */
function field(label: string, value: string): string {
	const lines = escapeHeadings(value.trim()).split("\n");
	return lines.length === 1 ? `${label}: ${lines[0]}` : [`${label}:`, ...lines.map((line) => `  ${line}`)].join("\n");
}

/** The lines of free text with a "#" at their start escaped, so none reads as a heading of its own. */
export function escapeHeadings(value: string): string {
	return value
		.split(/\r?\n/)
		.map((line) => line.replace(/^(\s*)#/, "$1\\#"))
		.join("\n");
}

/** Entity names, made unique within each type: the second "Dune" is "Dune (2)", and so on. */
export function uniqueNames(entities: readonly Entity[]): Map<string, string> {
	const seen = new Map<string, number>();
	return new Map(
		entities.map((e) => {
			const key = `${e.typeId}\u0000${e.name}`;
			const count = (seen.get(key) ?? 0) + 1;
			seen.set(key, count);
			return [e.id, count === 1 ? e.name : `${e.name} (${count})`];
		}),
	);
}
