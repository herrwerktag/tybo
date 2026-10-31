import { NameTaken, sameName, type AppData, type DataPort } from "./shared/core/index.js";
import { ToolError, WORKSPACE, json, object, text, type Tool, type ToolContext } from "./shared/mcp/index.js";
import { createStore, type Store } from "./features.core.js";
import { dataTools, describeData } from "./features/data/mcp.js";
import { analysisTools, describeAnalyses } from "./features/analyses/mcp.js";
import { boardTools, describeBoards } from "./features/boards/mcp.js";

/**
 * The features' parts of the MCP server, in one place: a feature joins with a line in each list, and leaves without
 * a trace by its lines going.
 */

/** The features' tools, on the store of the workspace a call names, in the order the model gets them. */
const TOOLS = [boardTools, dataTools, analysisTools];

/** What the features add to describe_workspace. */
const DESCRIBES = [describeData, describeAnalyses, describeBoards];

/**
 * The tools a model gets on tybo: read a workspace's types and entities, run its analyses, and make or change
 * types and entities. Each call reads the workspace anew and writes through the core's store — the same rules
 * as the app's forms (`validateType`, `parseValue`), the same change sets to the API.
 *
 * The model names everything the way a person would: workspaces, types, properties and entities by name (or
 * by id where a name is ambiguous), options by their text.
 */
export function tyboTools(port: DataPort): Tool[] {
	const context = toolContext(port);
	const describe = (data: AppData) => Object.assign({}, ...DESCRIBES.map((part) => part(data)));
	return [...workspaceTools(port, context, describe), ...TOOLS.flatMap((tools) => tools(context))].map(refusingTakenNames);
}

/** The tool, answering a name the core refused as taken (see `NameTaken`) the way it answers what the model asked
 * wrongly. */
function refusingTakenNames(tool: Tool): Tool {
	return {
		...tool,
		run: (args) =>
			tool.run(args).catch((error: unknown) => {
				throw error instanceof NameTaken ? new ToolError(error.message) : error;
			}),
	};
}

/** Opening the workspace a call names, through `port`, and answering once a change is saved. */
export function toolContext(port: DataPort): ToolContext<Store> {
	/** The store of the workspace `ref` names, read just now. */
	async function open(ref: unknown): Promise<Store> {
		const workspaces = await port.listWorkspaces();
		const wanted = text(ref, "workspace");
		const byId = workspaces.find((w) => w.id === wanted);
		const byName = workspaces.filter((w) => sameName(w.name, wanted));
		const workspace = byId ?? (byName.length === 1 ? byName[0] : undefined);
		if (!workspace) {
			const known = workspaces.map((w) => `${w.name} (${w.id})`).join(", ") || "none";
			throw new ToolError(`${byName.length > 1 ? "Several workspaces are" : "No workspace is"} called "${wanted}". Workspaces: ${known}.`);
		}
		const store = await createStore(port, workspace.id);
		if (store.problems.load?.code === "newerVersion") throw new ToolError("The workspace was saved by a newer version of tybo; update tybo first.");
		if (store.problems.load) throw new ToolError("The workspace couldn't be read.");
		return store;
	}

	/** Waits for the store's saves and says how they went; a failed one is the tool's failure. */
	async function saved(store: Store): Promise<string | null> {
		await store.saved();
		if (store.problems.saveFailed) throw new ToolError("The change couldn't be saved; nothing was written.");
		return store.problems.saveConflict ? "Someone else changed this in between; this change was written over theirs." : null;
	}

	/** The tool's answer once its change is saved, with a warning when it collided with someone else's. */
	async function answerSaved(store: Store, value: object): Promise<string> {
		const warning = await saved(store);
		return json(warning ? { ...value, warning } : value);
	}

	return { open, answerSaved };
}

/** The tools on the workspaces; `describe` makes describe_workspace of the features' parts. */
function workspaceTools(port: DataPort, { open }: ToolContext<Store>, describe: (data: AppData) => object): Tool[] {
	return [
		{
			name: "list_workspaces",
			description: "Lists the tybo workspaces. Every other tool names one of them in `workspace` (by name or id).",
			inputSchema: { type: "object", properties: {} },
			async run() {
				return json(await port.listWorkspaces());
			},
		},
		{
			name: "describe_workspace",
			description:
				"The schema of a workspace: its entity types with their color and properties (kind, options, which types a reference points to, " +
				"how cards show it, the arrow and label of its line), " +
				"how many entities each type has, the tags in use, the saved analyses and the boards with how many cards each has. " +
				"Read this before creating or changing anything.",
			inputSchema: object({ workspace: WORKSPACE }, ["workspace"]),
			async run(args) {
				const { data } = await open(args.workspace);
				return json(describe(data));
			},
		},
	];
}
