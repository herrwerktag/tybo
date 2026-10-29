import type { AppData } from "../../legacy/core/index.js";
import { typeName, typeOf, type ToolContext } from "../../legacy/mcp/tools.js";
import { ToolError, WORKSPACE, json, object, sameName, text, texts, type Tool } from "../../shared/mcp/index.js";
import {
	addAnalysis,
	deleteAnalysis,
	pathOptions,
	resolvePath,
	runAnalysis,
	updateAnalysis,
	type Analysis,
	type AnalysisGroup,
	type AnalysisRow,
	type PathOption,
	type PathStep,
} from "./core.js";

/** The tools on a workspace's analyses: run one, make one, change one, delete one. */
export function analysisTools({ open, answerSaved }: ToolContext): Tool[] {
	return [
		{
			name: "run_analysis",
			description:
				"Runs a saved analysis (see describe_workspace): the entities of its type as rows, nested in groups by what its grouping " +
				"paths lead to, with a cell per column (`columns` names them, in the order of the cells). At most `limit` rows are " +
				"shown (default 100); the groups' counts are always whole.",
			inputSchema: object(
				{
					workspace: WORKSPACE,
					analysis: ANALYSIS,
					limit: { type: "integer", minimum: 1, description: "At most this many rows (default 100)." },
				},
				["workspace", "analysis"],
			),
			async run(args) {
				const { data } = await open(args.workspace);
				const analysis = analysisOf(data, args.analysis);
				if (analysis.typeId === null) throw new ToolError(`The analysis "${analysis.name}" has no type picked yet.`);
				const typeId = analysis.typeId;
				const result = runAnalysis(data, analysis);
				const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 100;
				// The rows still to show; once none are left, the groups after are left out.
				let left = limit;
				let cut = false;
				const rows = (rs: readonly AnalysisRow[]) => {
					const shown = rs.slice(0, left);
					left -= shown.length;
					cut ||= shown.length < rs.length;
					return shown.map((r) => ({ entity: { id: r.entity.id, name: r.entity.name }, cells: r.cells.map((c) => c.map((v) => v.label)) }));
				};
				const groups = (gs: readonly AnalysisGroup[]): object[] =>
					gs.flatMap((g) => {
						if (left === 0) {
							cut = true;
							return [];
						}
						return [{ value: g.value?.label ?? null, count: g.count, ...(g.groups.length > 0 ? { groups: groups(g.groups) } : { rows: rows(g.rows) }) }];
					});
				const shown = result.groups.length > 0 ? { groups: groups(result.groups) } : { rows: rows(result.rows) };
				return json({
					analysis: analysis.name,
					type: typeName(data, typeId),
					groupedBy: analysis.groups.map((path) => pathLabel(data, typeId, path)),
					columns: analysis.columns.map((path) => pathLabel(data, typeId, path)),
					count: result.count,
					...shown,
					...(cut ? { truncated: `Only the first ${limit} rows are shown; ask with a higher limit for more.` } : {}),
				});
			},
		},
		{
			name: "create_analysis",
			description:
				"Creates an analysis: the entities of `type` as rows, grouped by the paths in `groups` (outermost first), with a column " +
				"per path in `columns`. " +
				PATHS,
			inputSchema: object({ workspace: WORKSPACE, name: { type: "string" }, type: { type: "string", description: "Name or id of the row type." }, groups: PATH_LIST, columns: PATH_LIST }, [
				"workspace",
				"name",
				"type",
			]),
			async run(args) {
				const store = await open(args.workspace);
				const name = analysisName(store.data, args.name, null);
				const type = typeOf(store.data, args.type);
				const groups = args.groups === undefined ? [] : paths(store.data, type.id, args.groups, "groups");
				const columns = args.columns === undefined ? [] : paths(store.data, type.id, args.columns, "columns");
				const analysis = addAnalysis(store, name);
				updateAnalysis(store, analysis.id, { typeId: type.id, groups, columns });
				return answerSaved(store, { analysis: describeAnalysis(store.data, analysisOf(store.data, analysis.id)) });
			},
		},
		{
			name: "update_analysis",
			description:
				"Changes an analysis: its name, its row type, its groups or its columns. `groups` and `columns` each replace the whole list; " +
				"a new `type` without them empties them, as the paths of the old type don't fit. " +
				PATHS,
			inputSchema: object(
				{ workspace: WORKSPACE, analysis: ANALYSIS, name: { type: "string" }, type: { type: "string", description: "Name or id of the row type." }, groups: PATH_LIST, columns: PATH_LIST },
				["workspace", "analysis"],
			),
			async run(args) {
				const store = await open(args.workspace);
				const analysis = analysisOf(store.data, args.analysis);
				const patch: Partial<Omit<Analysis, "id">> = {};
				if (args.name !== undefined) patch.name = analysisName(store.data, args.name, analysis.id);
				if (args.type !== undefined) {
					const type = typeOf(store.data, args.type);
					if (type.id !== analysis.typeId) Object.assign(patch, { typeId: type.id, groups: [], columns: [] });
				}
				const typeId = patch.typeId ?? analysis.typeId;
				if ((args.groups !== undefined || args.columns !== undefined) && typeId === null) throw new ToolError("Give the analysis a `type` first.");
				if (args.groups !== undefined) patch.groups = paths(store.data, typeId!, args.groups, "groups");
				if (args.columns !== undefined) patch.columns = paths(store.data, typeId!, args.columns, "columns");
				updateAnalysis(store, analysis.id, patch);
				return answerSaved(store, { analysis: describeAnalysis(store.data, analysisOf(store.data, analysis.id)) });
			},
		},
		{
			name: "delete_analysis",
			description: "Deletes an analysis; the entities stay as they are. Needs `confirm: true`.",
			inputSchema: object({ workspace: WORKSPACE, analysis: ANALYSIS, confirm: { type: "boolean" } }, ["workspace", "analysis", "confirm"]),
			async run(args) {
				const store = await open(args.workspace);
				const analysis = analysisOf(store.data, args.analysis);
				if (args.confirm !== true) throw new ToolError(`Deleting the analysis "${analysis.name}" needs confirm: true.`);
				deleteAnalysis(store, analysis.id);
				return answerSaved(store, { deleted: { id: analysis.id, name: analysis.name } });
			},
		},
	];
}

/** The saved analyses in describe_workspace. */
export function describeAnalyses(data: AppData): object {
	return { analyses: data.analyses.map((a) => describeAnalysis(data, a)) };
}

const ANALYSIS = { type: "string", description: "Name or id of the analysis." };
const PATH_LIST = {
	type: "array",
	items: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
	description: "Paths: each a list of steps, or the steps in one text joined by ›.",
};
const PATHS =
	"A path goes from the row type step by step: a property's name (a reference leads on to the entities it points to, a text or " +
	"options property ends the path), or for the entities referencing these, the reference's inverse label or Type.Property. " +
	"`Owner › Role` is the role of the owner; describe_workspace and run_analysis write paths the same way.";

/** How a path reads: its steps' names, an inverse step by its label or the referencing type and property. */
function pathLabel(data: AppData, typeId: string, path: readonly PathStep[]): string {
	return resolvePath(data.types, typeId, path)
		.options.map((o) => stepLabel(data, o))
		.join(" › ");
}

const stepLabel = (data: AppData, o: PathOption) =>
	o.step.direction === "inverse" ? o.prop.reference?.inverseLabel || `${typeName(data, o.ownerTypeId)}.${o.prop.name} (inverse)` : o.prop.name;

/** The paths the model gave from entities of `typeId`, each step named the way `stepLabel` reads it (an inverse
 * one also as Type.Property). */
function paths(data: AppData, typeId: string, raw: unknown, what: string): PathStep[][] {
	if (!Array.isArray(raw)) throw new ToolError(`\`${what}\` must be a list of paths.`);
	return raw.map((item, index) => {
		const steps = typeof item === "string" ? item.split("›") : texts(item, `${what}[${index}]`);
		if (steps.every((s) => s.trim() === "")) throw new ToolError(`${what}[${index}] needs at least one step.`);
		let from = [typeId];
		return steps.map((step, i) => {
			const wanted = step.trim();
			if (from.length === 0) throw new ToolError(`${what}[${index}]: "${steps[i - 1]!.trim()}" is a text or options property; the path ends there.`);
			const options = pathOptions(data.types, from);
			const fits = options.filter((o) =>
				o.step.direction === "forward"
					? o.prop.id === wanted || sameName(o.prop.name, wanted)
					: sameName(stepLabel(data, o), wanted) || sameName(`${typeName(data, o.ownerTypeId)}.${o.prop.name}`, wanted),
			);
			if (fits.length !== 1) {
				const known = options.map((o) => stepLabel(data, o)).join(", ") || "none";
				throw new ToolError(`${what}[${index}]: ${fits.length > 1 ? `"${wanted}" is ambiguous` : `there is no step "${wanted}"`} here. Steps: ${known}.`);
			}
			from = fits[0]!.typeIds;
			return fits[0]!.step;
		});
	});
}

/** The analysis `ref` names by id or name. */
function analysisOf(data: AppData, ref: unknown): Analysis {
	const wanted = text(ref, "analysis");
	const analysis = data.analyses.find((a) => a.id === wanted) ?? data.analyses.find((a) => sameName(a.name, wanted));
	if (!analysis) throw new ToolError(`There is no analysis "${wanted}". Analyses: ${data.analyses.map((a) => a.name).join(", ") || "none"}.`);
	return analysis;
}

/** `raw` as the name of an analysis, refused when empty or another one (than `selfId`) has it. */
function analysisName(data: AppData, raw: unknown, selfId: string | null): string {
	const name = text(raw, "name");
	if (name.trim() === "") throw new ToolError("An analysis needs a name.");
	if (data.analyses.some((a) => a.id !== selfId && sameName(a.name, name))) throw new ToolError(`There is an analysis "${name}" already.`);
	return name;
}

function describeAnalysis(data: AppData, analysis: Analysis) {
	const typeId = analysis.typeId;
	return {
		id: analysis.id,
		name: analysis.name,
		type: typeName(data, typeId),
		groupedBy: typeId === null ? [] : analysis.groups.map((path) => pathLabel(data, typeId, path)),
		columns: typeId === null ? [] : analysis.columns.map((path) => pathLabel(data, typeId, path)),
	};
}
