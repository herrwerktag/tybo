import {
	fillPlaceholders,
	referencedIds,
	resolvePath,
	runAnalysis,
	type Analysis,
	type AnalysisGroup,
	type AnalysisRow,
	type AnalysisValue,
	type AppData,
	type Entity,
	type EntityType,
	type PathStep,
	type PropertyDef,
} from "@tybo/core";
import { text } from "./i18n.js";
import { escapeHeadings, uniqueNames } from "./text-export.js";

/** How a path reads as a heading: its steps' names. */
export function pathLabel(types: readonly EntityType[], typeId: string, path: readonly PathStep[]): string {
	const { options } = resolvePath(types, typeId, path);
	if (options.length === 0) return "—";
	const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? "?";
	return options
		.map((o) =>
			o.step.direction === "inverse" ? o.prop.reference?.inverseLabel || text.inverseStep(typeName(o.ownerTypeId), o.prop.name) : o.prop.name,
		)
		.join(" › ");
}

/**
 * The result of an analysis as Markdown: its groups as headings, nested like in the Analyses tab, and in them a
 * section per row with what each column leads to and the row's description. After them, every entity a column names
 * that isn't a row itself, once, with its description. Entities are named by type and name, like in the text export.
 */
export function analysisMarkdown(data: Pick<AppData, "types" | "entities">, analysis: Analysis, date: string): string {
	const title = `# ${text.analysisExportTitle(analysis.name, date)}`;
	const type = data.types.find((t) => t.id === analysis.typeId);
	if (!type) return `${title}\n`;
	const types = new Map(data.types.map((t) => [t.id, t]));
	const entities = data.entities.filter((e) => types.has(e.typeId));
	const names = uniqueNames(entities);
	const mentions = new Map(entities.map((e) => [e.id, text.textExportEntity(types.get(e.typeId)!.name, names.get(e.id)!)]));
	const mention = (value: AnalysisValue) => (value.entityId !== null ? (mentions.get(value.entityId) ?? value.label) : value.label);

	const result = runAnalysis(data, analysis);
	const levels = analysis.groups.filter((path) => path.length > 0 && resolvePath(data.types, type.id, path).broken === null);
	const headers = analysis.columns.map((path) => pathLabel(data.types, type.id, path));
	const heading = (depth: number) => "#".repeat(Math.min(depth, 6));
	/** The entities the columns name, by id. */
	const named = new Set<string>();

	const rowSection = (row: AnalysisRow, depth: number): string => {
		const lines = [`${heading(depth)} ${mentions.get(row.entity.id)!}`];
		const cells = row.cells.map((values, i) => {
			for (const value of values) if (value.entityId !== null) named.add(value.entityId);
			return `- ${headers[i]}: ${values.length > 0 ? values.map(mention).join(", ") : "—"}`;
		});
		if (cells.length > 0) lines.push(cells.join("\n"));
		const description = descriptionText(row.entity, type, mentions);
		if (description) lines.push(description);
		return lines.join("\n\n");
	};
	const groupSections = (groups: AnalysisGroup[], level: number): string[] =>
		groups.flatMap((group) => [
			`${heading(2 + level)} ${group.value ? group.value.label : text.analysisNoValue(pathLabel(data.types, type.id, levels[level]!))} (${text.analysisCount(group.count)})`,
			...(group.groups.length > 0 ? groupSections(group.groups, level + 1) : group.rows.map((row) => rowSection(row, 3 + level))),
		]);

	const sections = [
		title,
		text.analysisCount(result.count),
		...(result.groups.length > 0 ? groupSections(result.groups, 0) : result.rows.map((row) => rowSection(row, 2))),
	];
	const rowIds = new Set(entities.filter((e) => e.typeId === type.id).map((e) => e.id));
	const mentioned = data.types.flatMap((t) => entities.filter((e) => e.typeId === t.id && named.has(e.id) && !rowIds.has(e.id)));
	if (mentioned.length > 0) {
		sections.push("---", `## ${text.analysisExportMentioned}`);
		for (const entity of mentioned) {
			const description = descriptionText(entity, types.get(entity.typeId)!, mentions);
			sections.push([`### ${mentions.get(entity.id)!}`, ...(description ? [description] : [])].join("\n\n"));
		}
	}
	return `${sections.join("\n\n")}\n`;
}

/** The entity's description with {{Property}} filled in (references by type and name, "—" when empty) and no line
 * reading as a heading; empty when it has none. */
function descriptionText(entity: Entity, type: EntityType, mentions: ReadonlyMap<string, string>): string {
	if (entity.description.trim() === "") return "";
	const placeholder = (prop: PropertyDef): string => {
		const value = entity.values[prop.id];
		const shown =
			prop.kind === "reference"
				? referencedIds(prop, value)
						.flatMap((id) => mentions.get(id) ?? [])
						.join(", ")
				: typeof value === "string"
					? value.trim()
					: "";
		return shown || "—";
	};
	return escapeHeadings(fillPlaceholders(entity.description, type, placeholder).trim());
}
