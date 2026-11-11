import type { AppData } from "../../shared/core/index.js";
import { WORKSPACE, object, text, type Tool, type ToolContext } from "../../shared/mcp/index.js";
import { setGuide, type GuideStore } from "./core.js";

/** The tool on a workspace's guide: replace it. (describe_workspace reads it.) */
export function guideTools({ open, answerSaved }: ToolContext<GuideStore>): Tool[] {
	return [
		{
			name: "update_workspace_guide",
			description:
				"Replaces the workspace's guide: one Markdown text saying how the workspace is worked with — its method, how its types " +
				"play together, an example. The whole text is replaced (read it with describe_workspace first to change a part); an empty " +
				"text removes it. What a single type or property is for goes into its own `description` and `guide` (update_type).",
			inputSchema: object({ workspace: WORKSPACE, guide: { type: "string", description: "The new guide, Markdown; empty removes it." } }, ["workspace", "guide"]),
			async run(args) {
				const store = await open(args.workspace);
				setGuide(store, text(args.guide, "guide"));
				return answerSaved(store, describeGuide(store.data));
			},
		},
	];
}

/** What describe_workspace says of the guide: its whole text, empty when there is none. */
export function describeGuide(data: AppData) {
	return { guide: data.guide };
}
