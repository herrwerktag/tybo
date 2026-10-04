import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { StoragePort } from "@bekbon/core";

/** The port the server listens on when the PORT environment variable doesn't say otherwise.
 * Not 3000: that one is taken by Forgejo on this host. */
export const DEFAULT_PORT = 3001;

/** Reads the port to listen on from a PORT-style environment value, falling back to the default. */
export function portFromEnv(value: string | undefined): number {
	const port = Number(value);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

/** What createApp needs besides the routing: the stored texts, and whether their storage answers. */
export interface Api extends StoragePort {
	/** Resolves once it's known whether the database answers; /health says ok only then. */
	healthy(): Promise<boolean>;
}

/** The HTTP interface of the storage port.
 *
 * GET /texts/{key} answers the saved text as plain text, or 404 if none is saved under the key. PUT
 * /texts/{key} saves the request body under the key, overwriting what was there, answering 204.
 * DELETE /texts/{key} removes the text (if any) and answers 204 either way. GET /health answers
 * 200 while the database answers, 503 when it doesn't.
 */
export function createApp(api: Api): Server {
	return createServer((req, res) => {
		void reply(req, res, api);
	});
}

async function reply(req: IncomingMessage, res: ServerResponse, api: Api): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	try {
		const method = req.method ?? "GET";
		if (url.pathname === "/health") {
			if (method !== "GET") return notAllowed(res, "GET");
			return (await api.healthy()) ? sendText(res, 200, "ok") : sendEmpty(res, 503);
		}
		const key = keyOf(url.pathname);
		if (!key) return sendEmpty(res, 404);
		switch (method) {
			case "GET": {
				const text = await api.getItem(key);
				return text === null ? sendEmpty(res, 404) : sendText(res, 200, text);
			}
			case "PUT": {
				await api.setItem(key, await body(req));
				return sendEmpty(res, 204);
			}
			case "DELETE": {
				await api.removeItem(key);
				return sendEmpty(res, 204);
			}
			default:
				return notAllowed(res, "GET, PUT, DELETE");
		}
	} catch {
		// The storage didn't answer, or its text couldn't even be read. What went wrong stays here:
		// a driver's error can quote the user it tried to connect as, which is part of the URL.
		return sendEmpty(res, 503);
	}
}

/** The key of a /texts/{key} path, percent-decoded so any key can name its text; "" if there's none to have. */
function keyOf(pathname: string): string {
	if (!pathname.startsWith("/texts/")) return "";
	try {
		return decodeURIComponent(pathname.slice("/texts/".length));
	} catch {
		return "";
	}
}

/** The request body, as the text it is. */
async function body(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function sendEmpty(res: ServerResponse, status: number): void {
	res.writeHead(status);
	res.end();
}

function sendText(res: ServerResponse, status: number, text: string): void {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(text);
}

function notAllowed(res: ServerResponse, allow: string): void {
	res.writeHead(405, { allow });
	res.end();
}
