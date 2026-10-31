import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { DATA_VERSION } from "@tybo/app/core";
import { STORED_UNITS, parseChanges, type Api, type HistoryPage } from "@tybo/app/api";

/** The port the server listens on when the PORT environment variable doesn't say otherwise.
 * Not 3000: that one is taken by Forgejo on this host. */
export const DEFAULT_PORT = 3001;

/** Reads the port to listen on from a PORT-style environment value, falling back to the default. */
export function portFromEnv(value: string | undefined): number {
	const port = Number(value);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

/** The origin the API tells the browser it may be called from, so the web app can save through it from
 * its own origin. CORS_ORIGIN says otherwise; the default fits the development setup, where the web app
 * runs on its usual Vite port. */
export const DEFAULT_CORS_ORIGIN = "http://localhost:5173";

/** The folder the built web app is served from when CLIENT_DIR doesn't say otherwise. Empty means the API
 * answers only its own routes, the way it does in development, where Vite serves the web app itself. */
export const DEFAULT_CLIENT_DIR = process.env.CLIENT_DIR ?? "";

/** The HTTP interface of the app's data.
 *
 * GET /workspaces answers the workspaces as JSON (`[{ id, name }]`), in their order. POST /workspaces makes
 * an empty one from the body `{ id, name, dataVersion }` — 201, or 409 when that id is taken, or that name (by
 * another workspace, ignoring case and surrounding spaces). PATCH /workspaces/{id} renames it (`{ name }`) or
 * moves it to another index in the list (`{ position }`) — 204, or 404 when there is none; a name another
 * workspace has answers 409. DELETE /workspaces/{id}
 * deletes it with all its data, 204 either way.
 *
 * GET /workspaces/{id}/data answers the workspace's data as JSON — the app's data marked with the format it
 * is in (`version`) — with its revision in the `etag` header, or 404. HEAD answers the same without the
 * data: one look on the wire for asking "has someone saved in between?".
 *
 * PUT /workspaces/{id}/changes saves a change set (JSON): only the rows of the units it names are written,
 * so units decide for themselves which of them collided with someone else's in-between save — the answer
 * says which, and writes them anyway (last one wins): 200 with `{ version, collided }`, the new revision in
 * `etag`. A body that isn't a change set answers 400 and writes nothing; no workspace of that id, 404. The
 * saver names the format its units are in (`X-Tybo-Data-Version`): one other than the API's own answers 409 and
 * writes nothing — a tab still running an older app, which has to reload first, so no units of an older format
 * end up in the tables, or in the history as the current one. A save that names none is taken as the API's own.
 *
 * GET /workspaces/{id}/history answers the workspace's history as JSON, newest first: every write of its
 * data, unit by unit, and of the workspace itself — also once it is deleted. `limit` (1 to 1000, 100 when
 * not given) says how many entries, `before` (an entry's id) where to go on from; anything else there
 * answers 400. Writes name who makes them in the `X-Tybo-Source` header, which the history keeps.
 *
 * GET /health answers 200 while the database answers, 503 when it doesn't.
 *
 * The web app calls the API from another origin, so the browser checks first: it asks before most of these
 * (a "preflight" OPTIONS request) and looks at the answer's cross-origin headers. Every answer, the
 * preflight included, says them — without that, the browser keeps the answers from the web app, and it can't
 * even see a 404 or a 503, let alone act on it.
 */
export function createApp(
	api: Api,
	allowedOrigin: string = process.env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN,
	clientDir: string = DEFAULT_CLIENT_DIR,
): Server {
	return createServer((req, res) => {
		allowCrossOrigin(res, allowedOrigin);
		// The preflight is answered where it's asked, before any route: 204, saying nothing yet.
		if (req.method === "OPTIONS") return sendEmpty(res, 204);
		void reply(req, res, api, clientDir);
	});
}

/** The types the built web app is served as; anything else goes out as a byte stream. */
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json",
	".woff2": "font/woff2",
};

/** The built web app from `clientDir`. A GET/HEAD of a file that is there answers it; every other path is
 * answered with index.html, because the web app routes in the browser. Only without a clientDir does the
 * API answer its own routes alone (development, where Vite serves the web app) — then a 404 here. */
async function serveClient(res: ServerResponse, clientDir: string, pathname: string, head: boolean): Promise<void> {
	if (clientDir === "") return sendEmpty(res, 404);
	const requested = pathname === "/" ? "/index.html" : pathname;
	const inside = normalize(requested).replace(/^(\.\.[/\\])+/, "");
	let file = join(clientDir, inside);
	let content: Buffer;
	try {
		content = await readFile(file);
	} catch {
		// Nothing of that name: the web app itself, so its own routing can take over.
		file = join(clientDir, "index.html");
		try {
			content = await readFile(file);
		} catch {
			return sendEmpty(res, 404);
		}
	}
	res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
	res.end(head ? undefined : content);
}

/** The headers the browser's cross-origin rules ask for: whose origin may call (which ways, sending what),
 * and which answer headers JavaScript may read — a workspace's revision travels in them. */
function allowCrossOrigin(res: ServerResponse, origin: string): void {
	res.setHeader("access-control-allow-origin", origin);
	res.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE");
	res.setHeader("access-control-allow-headers", "Content-Type, X-Tybo-Source, X-Tybo-Data-Version");
	// etag isn't among the headers a cross-origin answer shows JavaScript by default; say it may be seen.
	res.setHeader("access-control-expose-headers", "ETag");
}

async function reply(req: IncomingMessage, res: ServerResponse, api: Api, clientDir: string): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	try {
		const method = req.method ?? "GET";
		if (url.pathname === "/health") {
			if (method !== "GET") return notAllowed(res, "GET");
			return (await api.healthy()) ? sendText(res, 200, "ok") : sendEmpty(res, 503);
		}
		const route = routeOf(url.pathname);
		if (!route) {
			// Not one of the API's own paths: hand it to the web app, which routes in the browser itself.
			if (method === "GET" || method === "HEAD") return await serveClient(res, clientDir, url.pathname, method === "HEAD");
			return sendEmpty(res, 404);
		}

		if (route.id === null) {
			switch (method) {
				case "GET":
					return sendJson(res, 200, await api.listWorkspaces());
				case "POST": {
					const created = parseCreate(await readJson(req));
					if (!created) return sendEmpty(res, 400);
					const made = await api.createWorkspace({ id: created.id, name: created.name }, created.dataVersion, sourceOf(req));
					return sendEmpty(res, made ? 201 : 409);
				}
				default:
					return notAllowed(res, "GET, POST");
			}
		}

		const { id } = route;
		const source = sourceOf(req);
		switch (route.part) {
			case null:
				switch (method) {
					case "PATCH": {
						const body = await readJson(req);
						const position = parsePosition(body);
						if (position !== null) return sendEmpty(res, (await api.moveWorkspace(id, position, source)) ? 204 : 404);
						const name = parseName(body);
						if (name === null) return sendEmpty(res, 400);
						const renamed = await api.renameWorkspace(id, name, source);
						return sendEmpty(res, renamed === "nameTaken" ? 409 : renamed ? 204 : 404);
					}
					case "DELETE":
						await api.deleteWorkspace(id, source);
						return sendEmpty(res, 204);
					default:
						return notAllowed(res, "PATCH, DELETE");
				}
			case "data":
				switch (method) {
					case "GET": {
						const stored = await api.readWorkspace(id);
						if (!stored) return sendEmpty(res, 404);
						res.setHeader("etag", stored.revision);
						return sendJson(res, 200, stored.data);
					}
					case "HEAD": {
						const revision = await api.workspaceRevision(id);
						if (revision === null) return sendEmpty(res, 404);
						res.setHeader("etag", revision);
						return sendEmpty(res, 200);
					}
					default:
						return notAllowed(res, "GET, HEAD");
				}
			case "changes": {
				if (method !== "PUT") return notAllowed(res, "PUT");
				const changes = parseChanges(await readJson(req), STORED_UNITS);
				if (changes === null) return sendEmpty(res, 400);
				if (!inOwnFormat(req)) return sendEmpty(res, 409);
				const answer = await api.writeChanges(id, changes, source);
				if (!answer) return sendEmpty(res, 404);
				res.setHeader("etag", answer.version);
				return sendJson(res, 200, answer);
			}
			case "history": {
				if (method !== "GET") return notAllowed(res, "GET");
				const page = parsePage(url.searchParams);
				if (!page) return sendEmpty(res, 400);
				return sendJson(res, 200, await api.readHistory(id, page));
			}
		}
	} catch {
		// The storage didn't answer, or refused what it was asked to write. What went wrong stays here:
		// a driver's error can quote the user it tried to connect as, which is part of the URL.
		return sendEmpty(res, 503);
	}
}

/** Where a path leads: the workspaces (`id` null), one workspace (`part` null), or its data, changes or history.
 * Null for a path that leads nowhere. Ids are percent-decoded, so any id can name its workspace. */
function routeOf(pathname: string): { id: null } | { id: string; part: null | "data" | "changes" | "history" } | null {
	const segments = pathname.split("/").slice(1);
	if (segments[0] !== "workspaces") return null;
	if (segments.length === 1) return { id: null };
	let id: string;
	try {
		id = decodeURIComponent(segments[1]!);
	} catch {
		return null;
	}
	if (id === "") return null;
	if (segments.length === 2) return { id, part: null };
	if (segments.length === 3 && (segments[2] === "data" || segments[2] === "changes" || segments[2] === "history")) {
		return { id, part: segments[2] };
	}
	return null;
}

/** The longest source the history keeps; a longer one is taken as none. */
const MAX_SOURCE_LENGTH = 64;

/** Who makes the request, as it names itself in `X-Tybo-Source` (say "web" or "mcp"); null when it doesn't. */
function sourceOf(req: IncomingMessage): string | null {
	const raw = req.headers["x-tybo-source"];
	const source = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
	return source !== "" && source.length <= MAX_SOURCE_LENGTH ? source : null;
}

/** Whether the request's units are in the API's data format, as `X-Tybo-Data-Version` names it — or it names none. */
function inOwnFormat(req: IncomingMessage): boolean {
	const raw = req.headers["x-tybo-data-version"];
	const named = Array.isArray(raw) ? raw[0] : raw;
	return named === undefined || named.trim() === String(DATA_VERSION);
}

/** How many entries a history read answers when it doesn't say, and at most. */
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 1000;

/** The page a history read asks for; null when `limit` or `before` say something else than a count and an id. */
function parsePage(params: URLSearchParams): HistoryPage | null {
	const count = (raw: string) => (/^\d{1,18}$/.test(raw) ? Number(raw) : null);
	const rawLimit = params.get("limit");
	const limit = rawLimit === null ? DEFAULT_HISTORY_LIMIT : count(rawLimit);
	if (limit === null || limit < 1 || limit > MAX_HISTORY_LIMIT) return null;
	const before = params.get("before");
	if (before === null) return { limit };
	return count(before) === null ? null : { before, limit };
}

/** A workspace's name as a request names it: a string with something in it; null otherwise. */
function parseName(raw: unknown): string | null {
	const name = (raw as { name?: unknown } | null)?.name;
	return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

/** The index a PATCH moves the workspace to; null when the body names none. */
function parsePosition(raw: unknown): number | null {
	const position = (raw as { position?: unknown } | null)?.position;
	return typeof position === "number" && Number.isInteger(position) && position >= 0 ? position : null;
}

/** What a POST must say to make a workspace; null when the body says something else. */
function parseCreate(raw: unknown): { id: string; name: string; dataVersion: number } | null {
	const { id, dataVersion } = (raw ?? {}) as { id?: unknown; dataVersion?: unknown };
	const name = parseName(raw);
	if (typeof id !== "string" || id === "" || name === null) return null;
	if (typeof dataVersion !== "number" || !Number.isInteger(dataVersion) || dataVersion < 0) return null;
	return { id, name, dataVersion };
}

/** The request body, as the text it is. */
async function body(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

/** The request body parsed as JSON, or null when it doesn't parse (the caller answers 400 for it). */
async function readJson(req: IncomingMessage): Promise<unknown> {
	try {
		return JSON.parse(await body(req));
	} catch {
		return null;
	}
}

function sendEmpty(res: ServerResponse, status: number): void {
	res.writeHead(status);
	res.end();
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	sendText(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function sendText(res: ServerResponse, status: number, text: string, type = "text/plain; charset=utf-8"): void {
	res.writeHead(status, { "content-type": type });
	res.end(text);
}

function notAllowed(res: ServerResponse, allow: string): void {
	res.writeHead(405, { allow });
	res.end();
}
