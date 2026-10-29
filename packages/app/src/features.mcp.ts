import type { AppData, DataPort } from "./legacy/core/index.js";
import { legacyTools, toolContext } from "./legacy/mcp/tools.js";
import type { Tool } from "./shared/mcp/index.js";
import { analysisTools, describeAnalyses } from "./features/analyses/mcp.js";

/**
 * The features' parts of the MCP server, in one place: a feature joins with a line in each list, and leaves without
 * a trace by its lines going.
 */

/** The features' tools, on the store of the workspace a call names. */
const TOOLS = [analysisTools];

/** What the features add to describe_workspace. */
const DESCRIBES = [describeAnalyses];

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
	return [...legacyTools(port, context, describe), ...TOOLS.flatMap((tools) => tools(context))];
}
