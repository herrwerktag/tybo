import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ToolError, type Tool } from "@tybo/app/mcp";

/**
 * The Model Context Protocol over stdio, as far as a server offering tools needs it: JSON-RPC 2.0, one message
 * per line. A client opens with `initialize`, lists the tools and calls them; nothing else is offered (no
 * resources, no prompts). Kept to the few methods by hand rather than pulling in the SDK, which brings a web
 * server and its kin along for a transport this server doesn't use.
 */

/** The protocol versions this server speaks, newest first; a client asking for another gets the newest. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface Request {
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

/** The answer to one message as it came in (parsed from its line), or null for a notification, which nobody
 * answers. */
export async function answer(message: unknown, tools: readonly Tool[], server: { name: string; version: string }): Promise<object | null> {
	if (!isRequest(message)) return failure(null, INVALID_REQUEST, "not a JSON-RPC request");
	const { id, method, params = {} } = message;
	if (id === undefined) return null;
	switch (method) {
		case "initialize": {
			const asked = params.protocolVersion;
			const protocolVersion = PROTOCOL_VERSIONS.includes(asked as string) ? asked : PROTOCOL_VERSIONS[0];
			return success(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: server });
		}
		case "ping":
			return success(id, {});
		case "tools/list":
			return success(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
		case "tools/call": {
			const tool = tools.find((t) => t.name === params.name);
			if (!tool) return failure(id, INVALID_PARAMS, `there is no tool ${JSON.stringify(params.name)}`);
			const args = typeof params.arguments === "object" && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
			try {
				return success(id, { content: [{ type: "text", text: await tool.run(args) }] });
			} catch (error) {
				// Both go back to the model as the tool's answer — a request it can fix, or the API that didn't answer.
				const text = error instanceof ToolError ? error.message : `The tybo API couldn't be reached or refused: ${(error as Error).message}`;
				return success(id, { content: [{ type: "text", text }], isError: true });
			}
		}
		default:
			return failure(id, METHOD_NOT_FOUND, `the method ${method} isn't offered`);
	}
}

/** Answers the messages coming in on `input` on `output`, one after the other: a tool that writes only starts
 * once the one before it is done, so two calls never save over each other's stand. */
export function serve(input: Readable, output: Writable, tools: readonly Tool[], server: { name: string; version: string }): void {
	let turn: Promise<void> = Promise.resolve();
	createInterface({ input }).on("line", (line) => {
		if (line.trim() === "") return;
		turn = turn.then(async () => {
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				return void output.write(`${JSON.stringify(failure(null, PARSE_ERROR, "not JSON"))}\n`);
			}
			const reply = await answer(message, tools, server);
			if (reply) output.write(`${JSON.stringify(reply)}\n`);
		});
	});
}

function isRequest(message: unknown): message is Request {
	if (typeof message !== "object" || message === null) return false;
	const { jsonrpc, method, params } = message as Record<string, unknown>;
	return jsonrpc === "2.0" && typeof method === "string" && (params === undefined || (typeof params === "object" && params !== null));
}

const success = (id: Request["id"], result: object) => ({ jsonrpc: "2.0", id, result });

const failure = (id: Request["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
