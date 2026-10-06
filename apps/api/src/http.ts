import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { StoragePort } from "@bekbon/core";
import { APP_KEY } from "./mirror.js";

/** The port the server listens on when the PORT environment variable doesn't say otherwise.
 * Not 3000: that one is taken by Forgejo on this host. */
export const DEFAULT_PORT = 3001;

/** Reads the port to listen on from a PORT-style environment value, falling back to the default. */
export function portFromEnv(value: string | undefined): number {
	const port = Number(value);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

/** The origin the API tells the browser it may be called from, so the demo can save through it from
 * its own origin. CORS_ORIGIN says otherwise; the default fits the development setup, where the demo
 * runs on its usual Vite port. */
export const DEFAULT_CORS_ORIGIN = "http://localhost:5173";

/** Reads the origin allowed across the browser's cross-origin rules from a CORS_ORIGIN-style environment
 * value, falling back to the default. */
export function corsOriginFromEnv(value: string | undefined): string {
	return value ? value : DEFAULT_CORS_ORIGIN;
}

/** What createApp needs besides the routing: the stored texts, whether their storage answers, and the
 * version each stored text is at (the HTTP layer hands it to and from the requests). */
export interface Api extends StoragePort {
	/** Resolves once it's known whether the database answers; /health says ok only then. */
	healthy(): Promise<boolean>;
	/** The stored text under `key` together with its version, in one look (so the two can't disagree), or null
	 * if none is stored. */
	read(key: string): Promise<{ text: string; version: string } | null>;
	/** Saves the text only for the version the reader saw — `version` is what a read answered, or null for a
	 * first write. Answers the row's new version, or null when the save was refused: the stored text was
	 * changed by someone else in the meantime, or one already exists where the saver named no stand. */
	write(key: string, value: string, version: string | null): Promise<string | null>;
	/** Optional, the Postgres side: handed the text after a successful save, so its tables can mirror the app
	 * data. Without it (an API not on Postgres, for instance), saving stands alone. */
	syncFromText?(text: string): Promise<void>;
}

/** The HTTP interface of the storage port.
 *
 * GET /texts/{key} answers the saved text as plain text, or 404 if none is saved under the key — with
 * the text's version in the `etag` header, so a saver can name the stand it read on its next save. PUT
 * /texts/{key} saves the request body under the key, but only for such a stand: its `if-match` header
 * must name the version a read answered. Over what someone else saved in between it answers 409 and
 * writes nothing at all — the others' data stays instead of being silently run over. Without `if-match`,
 * a save passes only under a key nothing is stored under yet (the first write); over already stored
 * data it answers 409 as well. A successful save answers 204 with the new version in `etag`.
 * DELETE /texts/{key} removes the text (if any) and answers 204 either way. GET /health answers
 * 200 while the database answers, 503 when it doesn't.
 *
 * The demo calls the API from another origin, so the browser checks first: it asks before PUT and
 * DELETE (a "preflight" OPTIONS request) and looks at the answer's cross-origin headers. Every
 * answer, the preflight included, says them — without that, the browser keeps the answers from the
 * demo, and it can't even see a 404, a 409 or a 503, let alone act on it.
 */
export function createApp(api: Api, allowedOrigin: string = corsOriginFromEnv(process.env.CORS_ORIGIN)): Server {
	return createServer((req, res) => {
		allowCrossOrigin(res, allowedOrigin);
		// The preflight is answered where it's asked, before any route: 204, saying nothing yet.
		if (req.method === "OPTIONS") return sendEmpty(res, 204);
		void reply(req, res, api);
	});
}

/** The headers the browser's cross-origin rules ask for: whose origin may call (which ways, sending what),
 * and which answer headers JavaScript may read — a saved text's version travels in them. */
function allowCrossOrigin(res: ServerResponse, origin: string): void {
	res.setHeader("access-control-allow-origin", origin);
	res.setHeader("access-control-allow-methods", "GET, PUT, DELETE");
	// A save names the stand it builds on with If-Match, so that header has to be allowed through.
	res.setHeader("access-control-allow-headers", "Content-Type, If-Match");
	// etag isn't among the headers a cross-origin answer shows JavaScript by default; say it may be seen.
	res.setHeader("access-control-expose-headers", "ETag");
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
				const stored = await api.read(key);
				if (!stored) return sendEmpty(res, 404);
				// The version this text is at, so the next save under it can name the stand it read.
				res.setHeader("etag", stored.version);
				return sendText(res, 200, stored.text);
			}
			case "PUT": {
				const text = await body(req);
				// The version the save builds on: the stand its reader saw. Naming none passes only as a first
				// write, under a key nothing is stored under — never over stored data.
				const version = await api.write(key, text, header(req, "if-match"));
				if (version === null) {
					// Outdated, or over something already stored without naming a stand: nothing was written.
					return sendEmpty(res, 409);
				}
				// Saving the app's key keeps the Postgres mirror in step. The text is stored already, so a mirror
				// that can't be updated never fails the save — and one the text doesn't fit stays as it was.
				if (key === APP_KEY && api.syncFromText) {
					try {
						await api.syncFromText(text);
					} catch {
						// The mirror is display only; the saved text is safe.
					}
				}
				res.setHeader("etag", version);
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

/** The first value of a `name`d request header, or null when the request doesn't carry it. */
function header(req: IncomingMessage, name: string): string | null {
	const value = req.headers[name];
	if (typeof value === "string") return value;
	return Array.isArray(value) ? (value[0] ?? null) : null;
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
