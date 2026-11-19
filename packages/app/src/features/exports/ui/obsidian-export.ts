import type { AppData } from "../../../shared/core/index.js";
import type {} from "../../guides/core.js"; // the workspace's guide, `AppData["guide"]`
import { fillPlaceholders, optionLabel, referencedIds, uniqueNames, type Entity, type EntityType, type PropertyDef } from "../../data/core.js";
import { areaContents, isArea } from "../../drawings/core.js";
import { text } from "../texts.js";
import { boardCanvas } from "./obsidian-canvas.js";
import { propertyKind } from "./text-export.js";

type VaultData = Pick<AppData, "types" | "entities" | "boards" | "guide">;

/**
 * A workspace as a folder of Markdown notes for an Obsidian vault, under a folder of the workspace's name: a
 * handbook with the workspace's guide and what each type is for, a folder per type with a note per entity, and a
 * folder of indexes, one per group name (areas named alike on several boards make one), linking the entities with a
 * card lying in such a group and embedding the boards it lies on, and a folder of the boards as canvases (see
 * boardCanvas). An entity's properties are its note's frontmatter, references as links; its text starts with a line
 * of its tags and a line linking its indexes. Obsidian resolves `[[name]]` across the whole vault, so every note has
 * a name of its own; nothing links outside the folder, and nothing depends on where in the vault it lies.
 */
export function obsidianVault(name: string, data: VaultData): { name: string; contents: string }[] {
	const types = new Map(data.types.map((t) => [t.id, t]));
	const entities = data.entities.filter((e) => types.has(e.typeId));
	const root = vaultName(name);

	const noteName = uniquer();
	const handbook = noteName(text.obsidianHandbook);
	const shown = uniqueNames(entities);
	const notes = new Map(entities.map((e) => [e.id, noteName(vaultName(shown.get(e.id)!), types.get(e.typeId)!.name)]));

	const folderName = uniquer();
	const indexesFolder = folderName(text.obsidianIndexes);
	const boardsFolder = folderName(text.obsidianBoards);
	const folders = new Map(data.types.map((t) => [t.id, folderName(vaultName(t.name))]));
	const canvasName = uniquer();
	const canvases = new Map(data.boards.map((b) => [b.id, `${canvasName(vaultName(b.name))}.canvas`]));

	// The groups by name (ignoring case), in board order, with the entities that have a card in one of them and the
	// boards they lie on.
	const groups = new Map<string, { name: string; entityIds: Set<string>; canvases: Set<string> }>();
	let unnamed = 0;
	for (const board of data.boards) {
		const areas = board.drawings.filter(isArea);
		const cards = board.cards.filter((c) => notes.has(c.entityId));
		for (const area of areas) {
			const groupName = area.text.replace(/\s+/g, " ").trim() || `${text.groupFallbackName} ${++unnamed}`;
			const key = groupName.toLocaleLowerCase();
			const group = groups.get(key) ?? { name: groupName, entityIds: new Set<string>(), canvases: new Set<string>() };
			groups.set(key, group);
			group.canvases.add(canvases.get(board.id)!);
			const { cardIds } = areaContents(area, cards, areas);
			for (const card of cards) if (cardIds.has(card.id)) group.entityIds.add(card.entityId);
		}
	}
	const indexes = [...groups.values()].map((group) => ({ ...group, note: noteName(vaultName(group.name), text.obsidianIndex) }));

	return [
		{ name: `${root}/${handbook}.md`, contents: handbookNote(name, data, types, indexes, [...canvases.values()]) },
		...entities.map((e) => ({
			name: `${root}/${folders.get(e.typeId)!}/${notes.get(e.id)!}.md`,
			contents: entityNote(types.get(e.typeId)!, e, notes, indexes.filter((i) => i.entityIds.has(e.id)).map((i) => i.note)),
		})),
		...indexes.map((index) => ({
			name: `${root}/${indexesFolder}/${index.note}.md`,
			contents: indexNote(index, data.types, entities.filter((e) => index.entityIds.has(e.id)), notes),
		})),
		...data.boards.map((b) => ({ name: `${root}/${boardsFolder}/${canvases.get(b.id)!}`, contents: boardCanvas(data, b, (id) => notes.get(id)) })),
	];
}

function handbookNote(
	name: string,
	data: VaultData,
	types: ReadonlyMap<string, EntityType>,
	indexes: readonly { note: string }[],
	canvases: readonly string[],
): string {
	const sections = [`# ${name}`];
	if (data.guide.trim() !== "") sections.push(data.guide.trim());
	sections.push(`## ${text.obsidianTypes}`);
	for (const type of data.types) {
		const parts = [`### ${type.name}`];
		if (type.description.trim() !== "") parts.push(type.description.trim());
		if (type.guide.trim() !== "") parts.push(type.guide.trim());
		if (type.properties.length > 0) {
			const lines = type.properties.map((prop) => {
				const note = prop.description.trim() === "" ? "" : ` — ${prop.description.trim()}`;
				return `- **${prop.name}**: ${propertyKind(prop, types)}${note}`;
			});
			parts.push([`**${text.obsidianProperties}:**`, ...lines].join("\n"));
		}
		sections.push(parts.join("\n\n"));
	}
	if (indexes.length > 0) sections.push([`## ${text.obsidianIndexes}`, ...indexes.map((i) => `- [[${i.note}]]`)].join("\n"));
	if (canvases.length > 0) sections.push([`## ${text.obsidianBoards}`, ...canvases.map((c) => `- [[${c}]]`)].join("\n"));
	return `${sections.join("\n\n")}\n`;
}

function entityNote(type: EntityType, entity: Entity, notes: ReadonlyMap<string, string>, indexes: readonly string[]): string {
	const linksOf = (prop: PropertyDef) => referencedIds(prop, entity.values[prop.id]).flatMap((id) => (notes.has(id) ? [`[[${notes.get(id)!}]]`] : []));
	const properties: [string, string][] = [];
	for (const prop of type.properties) {
		const value = entity.values[prop.id];
		if (prop.kind === "reference") {
			const links = linksOf(prop);
			if (links.length === 0) continue;
			properties.push([prop.name, prop.reference?.multiple ? `[${links.map((l) => JSON.stringify(l)).join(", ")}]` : JSON.stringify(links[0])]);
		} else if (typeof value === "string" && value.trim() !== "") {
			const shown = prop.kind === "options" ? optionLabel(prop, value) : value.trim();
			if (shown !== null) properties.push([prop.name, JSON.stringify(shown)]);
		}
	}
	// The type first, unless a property has its key: two keys alike would make the frontmatter unreadable.
	const keys = new Set(properties.map(([key]) => key.toLocaleLowerCase()));
	if (!keys.has(text.obsidianTypeKey.toLocaleLowerCase())) properties.unshift([text.obsidianTypeKey, JSON.stringify(type.name)]);
	const front = ["---", ...properties.filter(([key]) => key.trim() !== "").map(([key, value]) => `${yamlKey(key)}: ${value}`), "---"];

	const head: string[] = [];
	const tags = entity.tags.map(obsidianTag).filter((t) => t !== "");
	if (tags.length > 0) head.push(`**${text.obsidianTags}:** ${tags.join(" ")}`);
	if (indexes.length > 0) head.push(`**${text.obsidianIndex}:** ${indexes.map((i) => `[[${i}]]`).join(" ")}`);
	const body = [head.join("\n")];
	if (entity.content.trim() !== "") body.push(entity.content.trim());
	// {{Property}} in the description: the value, references as links, "—" when empty.
	const placeholder = (prop: PropertyDef): string => {
		const value = entity.values[prop.id];
		const shown =
			prop.kind === "reference" ? linksOf(prop).join(", ") : prop.kind === "options" ? (optionLabel(prop, String(value)) ?? "") : typeof value === "string" ? value.trim() : "";
		return shown || "—";
	};
	if (entity.description.trim() !== "") body.push(fillPlaceholders(entity.description, type, placeholder).trim());
	const rest = body.filter((part) => part !== "").join("\n\n");
	return `${front.join("\n")}\n${rest === "" ? "" : `${rest}\n`}`;
}

function indexNote(
	{ name, canvases }: { name: string; canvases: ReadonlySet<string> },
	types: readonly EntityType[],
	members: readonly Entity[],
	notes: ReadonlyMap<string, string>,
): string {
	const sections = [`# ${name}`];
	for (const type of types) {
		const ofType = members.filter((e) => e.typeId === type.id);
		if (ofType.length > 0) sections.push([`## ${type.name}`, ...ofType.map((e) => `- [[${notes.get(e.id)!}]]`)].join("\n"));
	}
	sections.push([`## ${text.obsidianBoards}`, ...[...canvases].map((c) => `![[${c}]]`)].join("\n"));
	return `${sections.join("\n\n")}\n`;
}

/**
 * Names made unique (ignoring case) as they're handed out: a repeat gets `suffix` in brackets, e.g. "Dune (Book)",
 * then a number, "Dune (Book) 2"; without a suffix just the number, "Dune 2".
 */
function uniquer(): (base: string, suffix?: string) => string {
	const taken = new Set<string>();
	return (base, suffix) => {
		const tagged = suffix ? `${base} (${vaultName(suffix)})` : base;
		let unique = base;
		for (let n = 1; taken.has(unique.toLocaleLowerCase()); n++) unique = n === 1 ? tagged : `${tagged} ${n}`;
		taken.add(unique.toLocaleLowerCase());
		return unique;
	};
}

/** A name as a file or folder name Obsidian takes and links to: without the characters it doesn't allow there or
 * that end a link (`# ^ [ ] |`), not hidden by a leading dot. */
function vaultName(name: string): string {
	const safe = name
		.replace(/[\\/:*?"<>|#^[\]]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^[\s.]+|[\s.]+$/g, "");
	return safe || text.obsidianUnnamed;
}

/** A tag as Obsidian reads one: letters, digits, `_`, `-` and `/`; anything else (a space, say) becomes `-`. */
function obsidianTag(tag: string): string {
	const safe = tag.trim().replace(/[^\p{L}\p{N}_/-]+/gu, "-").replace(/^-+|-+$/g, "");
	return safe === "" ? "" : `#${safe}`;
}

/** A frontmatter key, quoted unless it's plain words. */
function yamlKey(key: string): string {
	return /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(key) && !key.endsWith(" ") ? key : JSON.stringify(key);
}
