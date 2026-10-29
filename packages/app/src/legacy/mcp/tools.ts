import { createStore, type AppData, type DataPort, type Store } from "../core/index.js";
import { ToolError, WORKSPACE, json, object, sameName, text, type Tool, type ToolContext as Context } from "../../shared/mcp/index.js";

/** What the tools on a workspace share (see `toolContext`). */
export type ToolContext = Context<Store>;

/** Opening the workspace a call names, through `port`, and answering once a change is saved. */
export function toolContext(port: DataPort): ToolContext {
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
export function legacyTools(port: DataPort, { open }: ToolContext, describe: (data: AppData) => object): Tool[] {
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
				"The schema of a workspace: its entity types with their properties (kind, options, which types a reference points to), " +
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
