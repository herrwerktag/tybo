/** One tool as the client sees it — `inputSchema` is a JSON Schema of its arguments — and what it does. */
export interface Tool {
	name: string;
	description: string;
	inputSchema: object;
	/** The tool's answer, as text for the model. Throws a `ToolError` for what the model asked wrongly. */
	run(args: Record<string, unknown>): Promise<string>;
}

/** What the model asked for doesn't fit (an unknown type, an option that isn't one …): its message goes back to
 * the model as the tool's answer, so it can ask again. */
export class ToolError extends Error {}

/** What the tools on a workspace share: opening the workspace a call names, and answering once its change is saved. */
export interface ToolContext<S> {
	/** The store of the workspace `ref` names, read just now. */
	open(ref: unknown): Promise<S>;
	/** The tool's answer once its change is saved, with a warning when it collided with someone else's. */
	answerSaved(store: S, value: object): Promise<string>;
}

/** The argument naming the workspace, which every tool on a workspace takes. */
export const WORKSPACE = { type: "string", description: "Name or id of the workspace." };
/** A JSON Schema of an object with `properties`, of which `required` must be there. */
export const object = (properties: Record<string, object>, required: string[]) => ({ type: "object", properties, required });

export const json = (value: unknown) => JSON.stringify(value, null, 2);

export function text(value: unknown, what: string): string {
	if (typeof value !== "string") throw new ToolError(`\`${what}\` must be a text.`);
	return value;
}

export function texts(value: unknown, what: string): string[] {
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new ToolError(`\`${what}\` must be a list of texts.`);
	return value;
}

export function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ToolError(`\`${what}\` must be an object.`);
	return value as Record<string, unknown>;
}
