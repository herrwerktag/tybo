import { sameName, type AppData } from "../../shared/core/index.js";
import type { DataStore } from "../data/core.js";
import { typeName, typeOf } from "../data/mcp.js";
import { traitName, traitOf } from "../traits/mcp.js";
import { ToolError, WORKSPACE, json, object, text, texts, type Tool, type ToolContext } from "../../shared/mcp/index.js";
import {
	addAnalysis,
	analysisFrom,
	deleteAnalysis,
	isRoleOption,
	nextOptions,
	resolvePath,
	runAnalysis,
	updateAnalysis,
	type Analysis,
	type AnalysisGroup,
	type AnalysisRow,
	type PathFrom,
	type PathOption,
	type PathStep,
} from "./core.js";

/** The tools on a workspace's analyses: run one, make one, change one, delete one. */
export function analysisTools({ open, answerSaved }: ToolContext<DataStore>): Tool[] {
	return [
		{
			name: "run_analysis",
			description:
				"Runs a saved analysis (see describe_workspace): the entities of its type (or of the types bearing its trait, each row " +
				"with its type) as rows, nested in groups by what its grouping paths lead to, with a cell per column (`columns` names " +
				"them, in the order of the cells). At most `limit` rows are shown (default 100); the groups' counts are always whole.",
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
				const from = analysisFrom(data, analysis);
				if (!from) throw new ToolError(`The analysis "${analysis.name}" has no type or trait picked yet.`);
				const ofTrait = "traitIds" in from;
				const result = runAnalysis(data, analysis);
				const limit = typeof args.limit === "number" && args.limit >= 1 ? Math.floor(args.limit) : 100;
				// The rows still to show; once none are left, the groups after are left out.
				let left = limit;
				let cut = false;
				const rows = (rs: readonly AnalysisRow[]) => {
					const shown = rs.slice(0, left);
					left -= shown.length;
					cut ||= shown.length < rs.length;
					return shown.map((r) => ({
						entity: { id: r.entity.id, name: r.entity.name, ...(ofTrait ? { type: typeName(data, r.entity.typeId) } : {}) },
						cells: r.cells.map((c) => c.map((v) => v.label)),
					}));
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
					...basisOf(data, analysis),
					groupedBy: analysis.groups.map((path) => pathLabel(data, from, path)),
					columns: analysis.columns.map((path) => pathLabel(data, from, path)),
					count: result.count,
					...shown,
					...(cut ? { truncated: `Only the first ${limit} rows are shown; ask with a higher limit for more.` } : {}),
				});
			},
		},
		{
			name: "create_analysis",
			description:
				"Creates an analysis: the entities of `type` (or of every type bearing `trait`; give one of them) as rows, grouped by " +
				"the paths in `groups` (outermost first), with a column per path in `columns`. " +
				PATHS,
			inputSchema: object({ workspace: WORKSPACE, name: { type: "string" }, type: ROW_TYPE, trait: ROW_TRAIT, groups: PATH_LIST, columns: PATH_LIST }, ["workspace", "name"]),
			async run(args) {
				const store = await open(args.workspace);
				const name = analysisName(args.name);
				if ((args.type === undefined) === (args.trait === undefined)) throw new ToolError("Give the analysis a `type` or a `trait`, one of them.");
				const basis = basisPatch(store.data, args);
				const from = analysisFrom(store.data, basis)!;
				const groups = args.groups === undefined ? [] : paths(store.data, from, args.groups, "groups");
				const columns = args.columns === undefined ? [] : paths(store.data, from, args.columns, "columns");
				const analysis = addAnalysis(store, name);
				updateAnalysis(store, analysis.id, { ...basis, groups, columns });
				return answerSaved(store, { analysis: describeAnalysis(store.data, analysisOf(store.data, analysis.id)) });
			},
		},
		{
			name: "update_analysis",
			description:
				"Changes an analysis: its name, its row type or trait, its groups or its columns. `groups` and `columns` each replace the " +
				"whole list; a new `type` or `trait` without them empties them, as the paths of the old one don't fit. " +
				PATHS,
			inputSchema: object(
				{ workspace: WORKSPACE, analysis: ANALYSIS, name: { type: "string" }, type: ROW_TYPE, trait: ROW_TRAIT, groups: PATH_LIST, columns: PATH_LIST },
				["workspace", "analysis"],
			),
			async run(args) {
				const store = await open(args.workspace);
				const analysis = analysisOf(store.data, args.analysis);
				const patch: Partial<Omit<Analysis, "id">> = {};
				if (args.name !== undefined) patch.name = analysisName(args.name);
				if (args.type !== undefined && args.trait !== undefined) throw new ToolError("Give the analysis a `type` or a `trait`, not both.");
				if (args.type !== undefined || args.trait !== undefined) {
					const basis = basisPatch(store.data, args);
					if (basis.typeId !== analysis.typeId || basis.traitId !== analysis.traitId) Object.assign(patch, { ...basis, groups: [], columns: [] });
				}
				const from = analysisFrom(store.data, { ...analysis, ...patch });
				if ((args.groups !== undefined || args.columns !== undefined) && !from) throw new ToolError("Give the analysis a `type` or a `trait` first.");
				if (args.groups !== undefined) patch.groups = paths(store.data, from!, args.groups, "groups");
				if (args.columns !== undefined) patch.columns = paths(store.data, from!, args.columns, "columns");
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
const ROW_TYPE = { type: "string", description: "Name or id of the row type." };
const ROW_TRAIT = { type: "string", description: "Name or id of a trait: the rows are the entities of every type bearing it, and paths go over its roles." };
const PATH_LIST = {
	type: "array",
	items: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
	description: "Paths: each a list of steps, or the steps in one text joined by ›.",
};
const PATHS =
	"A path goes from the row type step by step: a property's name (a reference leads on to the entities it points to, a text or " +
	"options property ends the path), or for the entities referencing these, the reference's inverse label or Type.Property. " +
	"`Owner › Role` is the role of the owner. From a trait, every step is a role: of the trait, and after a reference role of " +
	"a trait the entities reached bear (by its name, or Trait.Role). describe_workspace and run_analysis write paths the same way.";

/** How a path reads: its steps' names, an inverse step by its label or the referencing type and property. */
function pathLabel(data: AppData, from: PathFrom, path: readonly PathStep[]): string {
	return resolvePath(data, from, path)
		.options.map((o) => stepLabel(data, o))
		.join(" › ");
}

function stepLabel(data: AppData, o: PathOption): string {
	if (isRoleOption(o)) return o.role.name;
	return o.step.direction === "inverse" ? o.prop.reference?.inverseLabel || `${typeName(data, o.ownerTypeId)}.${o.prop.name} (inverse)` : o.prop.name;
}

/** Whether the model named the option `wanted`: a property or role by name or id, an inverse step also as
 * Type.Property, a role also as Trait.Role. */
function names(data: AppData, o: PathOption, wanted: string): boolean {
	if (isRoleOption(o)) return o.role.id === wanted || sameName(o.role.name, wanted) || sameName(`${o.trait.name}.${o.role.name}`, wanted);
	return o.step.direction === "forward"
		? o.prop.id === wanted || sameName(o.prop.name, wanted)
		: sameName(stepLabel(data, o), wanted) || sameName(`${typeName(data, o.ownerTypeId)}.${o.prop.name}`, wanted);
}

/** The paths the model gave from where the analysis's paths start, each step named the way `stepLabel` reads it (see
 * `names`). */
function paths(data: AppData, from: PathFrom, raw: unknown, what: string): PathStep[][] {
	if (!Array.isArray(raw)) throw new ToolError(`\`${what}\` must be a list of paths.`);
	return raw.map((item, index) => {
		const steps = typeof item === "string" ? item.split("›") : texts(item, `${what}[${index}]`);
		if (steps.every((s) => s.trim() === "")) throw new ToolError(`${what}[${index}] needs at least one step.`);
		const path: PathStep[] = [];
		let ended: PathOption | null = null;
		for (const step of steps) {
			const wanted = step.trim();
			if (ended) throw new ToolError(`${what}[${index}]: "${stepLabel(data, ended)}" is a text or options ${isRoleOption(ended) ? "role" : "property"}; the path ends there.`);
			const options = nextOptions(data, from, path);
			const fits = options.filter((o) => names(data, o, wanted));
			if (fits.length !== 1) {
				const known = options.map((o) => stepLabel(data, o)).join(", ") || "none";
				throw new ToolError(`${what}[${index}]: ${fits.length > 1 ? `"${wanted}" is ambiguous` : `there is no step "${wanted}"`} here. Steps: ${known}.`);
			}
			path.push(fits[0]!.step);
			if (fits[0]!.typeIds.length === 0) ended = fits[0]!;
		}
		return path;
	});
}

/** The analysis `ref` names by id or name. */
function analysisOf(data: AppData, ref: unknown): Analysis {
	const wanted = text(ref, "analysis");
	const analysis = data.analyses.find((a) => a.id === wanted) ?? data.analyses.find((a) => sameName(a.name, wanted));
	if (!analysis) throw new ToolError(`There is no analysis "${wanted}". Analyses: ${data.analyses.map((a) => a.name).join(", ") || "none"}.`);
	return analysis;
}

/** `raw` as the name of an analysis, refused when empty; one another analysis has the core refuses. */
function analysisName(raw: unknown): string {
	const name = text(raw, "name");
	if (name.trim() === "") throw new ToolError("An analysis needs a name.");
	return name;
}

/** The type or the trait the analysis's rows are of, by name. */
function basisOf(data: AppData, analysis: Analysis) {
	return analysis.traitId !== null ? { trait: traitName(data, analysis.traitId) } : { type: typeName(data, analysis.typeId) };
}

/** The type or the trait the model gave the analysis's rows. */
function basisPatch(data: AppData, args: Record<string, unknown>): Pick<Analysis, "typeId" | "traitId"> {
	return args.trait !== undefined ? { typeId: null, traitId: traitOf(data, args.trait).id } : { typeId: typeOf(data, args.type).id, traitId: null };
}

function describeAnalysis(data: AppData, analysis: Analysis) {
	const from = analysisFrom(data, analysis);
	return {
		id: analysis.id,
		name: analysis.name,
		...basisOf(data, analysis),
		groupedBy: from === null ? [] : analysis.groups.map((path) => pathLabel(data, from, path)),
		columns: from === null ? [] : analysis.columns.map((path) => pathLabel(data, from, path)),
	};
}
