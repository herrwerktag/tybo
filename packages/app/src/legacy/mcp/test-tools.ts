import assert from "node:assert/strict";
import { DATA_VERSION } from "../core/index.js";
import { memoryDataPort } from "../core/memory-port.js";
import { tyboTools } from "../../features.mcp.js";
import { ToolError } from "../../shared/mcp/index.js";

/** The tools on a port in memory holding one empty workspace, "Projekt"; `call` runs one and parses its answer. */
export function setup() {
	const storage = memoryDataPort({ Projekt: { version: DATA_VERSION, types: [], entities: [], boards: [] } });
	const tools = tyboTools(storage.port);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `no tool ${name}`);
		return JSON.parse(await tool.run({ workspace: "Projekt", ...args }));
	};
	/** The tool's refusal, as the model gets to read it. */
	const refusal = async (name: string, args: Record<string, unknown>) => {
		const tool = tools.find((t) => t.name === name)!;
		const error = await tool.run({ workspace: "Projekt", ...args }).then(
			() => assert.fail(`${name} didn't refuse`),
			(e: unknown) => e,
		);
		assert.ok(error instanceof ToolError, String(error));
		return error.message;
	};
	return { storage, call, refusal };
}

/** Two types, a Person and a Task referencing its owner, with Ada and Alan and one task of Ada's. */
export async function withPeople() {
	const tools = setup();
	await tools.call("create_type", { name: "Person", properties: [{ name: "Role", kind: "options", options: ["Dev", "Lead"] }] });
	await tools.call("create_type", {
		name: "Task",
		properties: [{ name: "Owner", kind: "reference", targets: ["person"], inverseLabel: "owns" }],
	});
	await tools.call("create_entity", { type: "Person", name: "Ada", values: { role: "Lead" } });
	await tools.call("create_entity", { type: "Person", name: "Alan", values: { Role: "Dev" } });
	await tools.call("create_entity", { type: "Task", name: "Write the spec", values: { Owner: "ada" }, tags: ["q4"] });
	return tools;
}
