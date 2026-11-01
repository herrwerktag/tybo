import { fillPlaceholders, optionLabel, referencedIds, type Entity, type EntityType, type PropertyDef, uniqueNames } from "../data/core.js";
import type { AppData } from "../../shared/core/index.js";
import { uniqueFileNames } from "../../shared/ui/index.js";
import { text as dataText } from "../data/texts.js";
import {
	analysisFrom,
	groupingPaths,
	isRoleOption,
	resolvePath,
	rowTypeIds,
	runAnalysis,
	type Analysis,
	type AnalysisGroup,
	type AnalysisRow,
	type AnalysisValue,
	type PathData,
	type PathFrom,
	type PathOption,
	type PathStep,
} from "./core.js";
import { text } from "./texts.js";

/** How a step reads: a property's or role's name, an inverse one by its label or the referencing type and property. */
export function stepName(types: readonly { id: string; name: string }[], option: PathOption): string {
	if (isRoleOption(option)) return option.role.name;
	if (option.step.direction === "forward") return option.prop.name;
	return option.prop.reference?.inverseLabel || text.inverseStep(types.find((t) => t.id === option.ownerTypeId)?.name ?? "?", option.prop.name);
}

/** How a path reads as a heading: its steps' names. */
export function pathLabel(data: PathData, from: PathFrom, path: readonly PathStep[]): string {
	const { options } = resolvePath(data, from, path);
	if (options.length === 0) return "—";
	return options.map((o) => stepName(data.types, o)).join(" › ");
}

/**
 * The result of an analysis as Markdown files. The first holds all of it: its groups as headings, nested like in the
 * Analyses tab, and in them a section per row with its content, a table of what each column leads to and its
 * description. After them, every entity a column names that isn't a row itself, once, with its content and
 * description. Then one more file per outermost group, with the group as its title, its entity's content and
 * description first and the entities named in it last.
 * Entities are named by type and name, like in the text export; headings in contents and descriptions become
 * subheadings of their section.
 */
export function analysisMarkdownFiles(
	data: Pick<AppData, "types" | "entities" | "traits">,
	analysis: Analysis,
	date: string,
): { name: string; contents: string }[] {
	const title = `# ${text.analysisExportTitle(analysis.name, date)}`;
	const fileName = `${analysis.name} ${date}`;
	const from = analysisFrom(data, analysis);
	if (!from) return uniqueFileNames([{ name: fileName, contents: `${title}\n` }], "md");
	const types = new Map(data.types.map((t) => [t.id, t]));
	const entities = data.entities.filter((e) => types.has(e.typeId));
	const names = uniqueNames(entities);
	const mentions = new Map(entities.map((e) => [e.id, dataText.entityMention(types.get(e.typeId)!.name, names.get(e.id)!)]));
	const mention = (value: AnalysisValue) => (value.entityId !== null ? (mentions.get(value.entityId) ?? value.label) : value.label);

	const result = runAnalysis(data, analysis);
	const levels = groupingPaths(data, from, analysis);
	const headers = analysis.columns.map((path) => pathLabel(data, from, path));
	const groupLabel = (group: AnalysisGroup, level: number) =>
		group.value ? group.value.label : text.analysisNoValue(pathLabel(data, from, levels[level]!));

	/** A row's section; the entities its columns name are added to `named`. */
	const rowSection = (row: AnalysisRow, depth: number, named: Set<string>): string => {
		const lines = [`${heading(depth)} ${mentions.get(row.entity.id)!}`];
		const content = contentText(row.entity, depth);
		if (content) lines.push(content);
		if (headers.length > 0) {
			const cells = row.cells.map((values) => {
				for (const value of values) if (value.entityId !== null) named.add(value.entityId);
				return values.length > 0 ? values.map(mention).join(", ") : "—";
			});
			lines.push([tableRow(headers), tableRow(headers.map(() => "---")), tableRow(cells)].join("\n"));
		}
		const description = descriptionText(row.entity, types.get(row.entity.typeId)!, mentions, depth);
		if (description) lines.push(description);
		return lines.join("\n\n");
	};
	/** What's inside a group: its subgroups or its rows, from the given heading level on. */
	const groupBody = (group: AnalysisGroup, level: number, depth: number, named: Set<string>): string[] =>
		group.groups.length > 0
			? group.groups.flatMap((sub) => [`${heading(depth)} ${groupLabel(sub, level + 1)}`, ...groupBody(sub, level + 1, depth + 1, named)])
			: group.rows.map((row) => rowSection(row, depth, named));

	/** An entity's content and description, those it has, in a section on the given heading level. */
	const entityTexts = (entity: Entity, depth: number): string[] =>
		[contentText(entity, depth), descriptionText(entity, types.get(entity.typeId)!, mentions, depth)].filter((t) => t !== "");

	const rowTypes = new Set(rowTypeIds(data, analysis));
	const rowIds = new Set(entities.filter((e) => rowTypes.has(e.typeId)).map((e) => e.id));
	/** A file: its title, its sections and then the entities they name, but for the one the file is about. */
	const markdown = (heading: string, sections: (named: Set<string>) => string[], about?: Entity): string => {
		const named = new Set<string>();
		const all = [heading, ...sections(named)];
		const mentioned = data.types.flatMap((t) =>
			entities.filter((e) => e.typeId === t.id && named.has(e.id) && !rowIds.has(e.id) && e !== about),
		);
		if (mentioned.length > 0) {
			all.push("---", `## ${text.analysisExportMentioned}`);
			for (const entity of mentioned) all.push([`### ${mentions.get(entity.id)!}`, ...entityTexts(entity, 3)].join("\n\n"));
		}
		return `${all.join("\n\n")}\n`;
	};

	return uniqueFileNames(
		[
			{
				name: fileName,
				contents: markdown(title, (named) =>
					result.groups.length > 0
						? result.groups.flatMap((group) => [`## ${groupLabel(group, 0)}`, ...groupBody(group, 0, 3, named)])
						: result.rows.map((row) => rowSection(row, 2, named)),
				),
			},
			...result.groups.map((group) => {
				const entity = entities.find((e) => e.id === group.value?.entityId);
				return {
					name: groupLabel(group, 0),
					contents: markdown(
						`# ${groupLabel(group, 0)}`,
						(named) => [...(entity ? entityTexts(entity, 1) : []), ...groupBody(group, 0, 2, named)],
						entity,
					),
				};
			}),
		],
		"md",
	);
}

/** A heading's marker on the given level, no deeper than Markdown's sixth. */
function heading(depth: number): string {
	return "#".repeat(Math.min(depth, 6));
}

/** A row of a Markdown table; a "|" in a cell doesn't end it. */
function tableRow(cells: readonly string[]): string {
	return `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;
}

/**
 * Free text in a section whose heading is on the given level: its headings become subheadings of that section ("#"
 * one level below it, "##" two, …), no deeper than the sixth. Lines in fenced code blocks stay as they are.
 */
function nestHeadings(value: string, depth: number): string {
	let fence: string | null = null;
	return value
		.split(/\r?\n/)
		.map((line) => {
			const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
			if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
				fence = fence === null ? marker : null;
				return line;
			}
			if (fence !== null) return line;
			return line.replace(/^( {0,3})(#{1,6})(?=\s|$)/, (_, indent: string, marks: string) => indent + heading(depth + marks.length));
		})
		.join("\n");
}

/** The entity's content, as on its card, in a section on the given heading level; empty when it has none. */
function contentText(entity: Entity, depth: number): string {
	return nestHeadings(entity.content.trim(), depth);
}

/** The entity's description with {{Property}} filled in (references by type and name, "—" when empty), in a section
 * on the given heading level; empty when it has none. */
function descriptionText(entity: Entity, type: EntityType, mentions: ReadonlyMap<string, string>, depth: number): string {
	if (entity.description.trim() === "") return "";
	const placeholder = (prop: PropertyDef): string => {
		const value = entity.values[prop.id];
		const shown =
			prop.kind === "reference"
				? referencedIds(prop, value)
						.flatMap((id) => mentions.get(id) ?? [])
						.join(", ")
				: prop.kind === "options"
					? (optionLabel(prop, String(value)) ?? "")
					: typeof value === "string"
						? value.trim()
						: "";
		return shown || "—";
	};
	return nestHeadings(fillPlaceholders(entity.description, type, placeholder).trim(), depth);
}
