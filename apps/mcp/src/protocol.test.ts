import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ToolError, answer, serve, type Tool } from "./protocol.js";

const SERVER = { name: "tybo", version: "1.0.0" };

/** A tool that echoes its `say`, refuses without it, and fails the way an API that's gone does on `crash`. */
const echo: Tool = {
	name: "echo",
	description: "Echoes.",
	inputSchema: { type: "object", properties: { say: { type: "string" } } },
	async run(args) {
		if (args.crash) throw new Error("fetch failed");
		if (typeof args.say !== "string") throw new ToolError("say something");
		return args.say;
	},
};

const request = (id: number, method: string, params?: object) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

test("initialize answers the version the client asks for when it's spoken here, else the newest", async () => {
	assert.deepEqual(await answer(request(1, "initialize", { protocolVersion: "2025-03-26" }), [echo], SERVER), {
		jsonrpc: "2.0",
		id: 1,
		result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: SERVER },
	});
	const newest = (await answer(request(2, "initialize", { protocolVersion: "1999-01-01" }), [echo], SERVER)) as { result: { protocolVersion: string } };
	assert.equal(newest.result.protocolVersion, "2025-06-18");
});

test("tools are listed without what they do, and called with their arguments", async () => {
	assert.deepEqual(await answer(request(1, "tools/list"), [echo], SERVER), {
		jsonrpc: "2.0",
		id: 1,
		result: { tools: [{ name: "echo", description: "Echoes.", inputSchema: echo.inputSchema }] },
	});
	assert.deepEqual(await answer(request(2, "tools/call", { name: "echo", arguments: { say: "hi" } }), [echo], SERVER), {
		jsonrpc: "2.0",
		id: 2,
		result: { content: [{ type: "text", text: "hi" }] },
	});
});

test("a refusal and a failure are the tool's answer, marked as errors; an unknown tool or method is a protocol error", async () => {
	assert.deepEqual(await answer(request(1, "tools/call", { name: "echo", arguments: {} }), [echo], SERVER), {
		jsonrpc: "2.0",
		id: 1,
		result: { content: [{ type: "text", text: "say something" }], isError: true },
	});
	const failed = (await answer(request(2, "tools/call", { name: "echo", arguments: { crash: true } }), [echo], SERVER)) as {
		result: { content: { text: string }[]; isError: boolean };
	};
	assert.equal(failed.result.isError, true);
	assert.match(failed.result.content[0]!.text, /couldn't be reached.*fetch failed/);
	assert.equal(((await answer(request(3, "tools/call", { name: "nope" }), [echo], SERVER)) as { error: { code: number } }).error.code, -32602);
	assert.equal(((await answer(request(4, "resources/list"), [echo], SERVER)) as { error: { code: number } }).error.code, -32601);
	assert.equal(((await answer({ id: 5, method: "ping" }, [echo], SERVER)) as { error: { code: number } }).error.code, -32600);
});

test("notifications get no answer", async () => {
	assert.equal(await answer({ jsonrpc: "2.0", method: "notifications/initialized" }, [echo], SERVER), null);
});

test("over stdio, each line is answered on a line of its own, in order, and a line that isn't JSON is a parse error", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	serve(input, output, [echo], SERVER);
	const lines: unknown[] = [];
	output.on("data", (chunk: Buffer) => lines.push(...chunk.toString().trim().split("\n").map((l) => JSON.parse(l))));
	input.write(`${JSON.stringify(request(1, "tools/call", { name: "echo", arguments: { say: "one" } }))}\n`);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	input.write("{not json\n");
	input.write(`${JSON.stringify(request(2, "ping"))}\n`);
	input.end();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(lines, [
		{ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "one" }] } },
		{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } },
		{ jsonrpc: "2.0", id: 2, result: {} },
	]);
});
