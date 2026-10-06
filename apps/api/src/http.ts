import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Change, SavedChanges, WorkspaceInfo } from "@bekbon/core";
import { parseChanges } from "./changes.js";
import type { StoredWorkspace } from "./data.js";

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

/** What createApp needs besides the routing: the workspaces and their data, and whether their storage answers. */
export interface Api {
	/** Resolves once it's known whether the database answers; /health says ok only then. */
	healthy(): Promise<boolean>;
	/** The workspaces, in their order. */
	listWorkspaces(): Promise<WorkspaceInfo[]>;
	/** Makes an empty workspace; false when one of that id is there already (nothing written then). */
	createWorkspace(info: WorkspaceInfo, dataVersion: number): Promise<boolean>;
	/** Renames a workspace; false when there is none of that id. */
	renameWorkspace(id: string, name: string): Promise<boolean>;
	/** Deletes a workspace and all its data; there being none of that id is no error. */
	deleteWorkspace(id: string): Promise<void>;
	/** The workspace's data with its revision, read as one — or null when there is none of that id. */
	readWorkspace(id: string): Promise<StoredWorkspace | null>;
	/** The revision the workspace is at, or null when there is none of that id. */
	workspaceRevision(id: string): Promise<string | null>;
	/** Writes a change set — only the rows of the units it names — into the workspace. The units' `before`
	 * stands decide, one at a time, which of them collided: answered, written anyway (last one wins).
	 * Null when there is no workspace of that id. */
	writeChanges(id: string, changes: Change[]): Promise<SavedChanges | null>;
}

/** The HTTP interface of the app's data.
 *
 * GET /workspaces answers the workspaces as JSON (`[{ id, name }]`), in their order. POST /workspaces makes
 * an empty one from the body `{ id, name, dataVersion }` — 201, or 409 when that id is taken. PATCH
 * /workspaces/{id} renames it (`{ name }`) — 204, or 404 when there is none. DELETE /workspaces/{id}
 * deletes it with all its data, 204 either way.
 *
 * GET /workspaces/{id}/data answers the workspace's data as JSON — the app's data marked with the format it
 * is in (`version`) — with its revision in the `etag` header, or 404. HEAD answers the same without the
 * data: one look on the wire for asking "has someone saved in between?".
 *
 * PUT /workspaces/{id}/changes saves a change set (JSON): only the rows of the units it names are written,
 * so units decide for themselves which of them collided with someone else's in-between save — the answer
 * says which, and writes them anyway (last one wins): 200 with `{ version, collided }`, the new revision in
 * `etag`. A body that isn't a change set answers 400 and writes nothing; no workspace of that id, 404.
 *
 * GET /health answers 200 while the database answers, 503 when it doesn't.
 *
 * The demo calls the API from another origin, so the browser checks first: it asks before most of these
 * (a "preflight" OPTIONS request) and looks at the answer's cross-origin headers. Every answer, the
 * preflight included, says them — without that, the browser keeps the answers from the demo, and it can't
 * even see a 404 or a 503, let alone act on it.
 */
export function createApp(api: Api, allowedOrigin: string = process.env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN): Server {
	return createServer((req, res) => {
		allowCrossOrigin(res, allowedOrigin);
		// The preflight is answered where it's asked, before any route: 204, saying nothing yet.
		if (req.method === "OPTIONS") return sendEmpty(res, 204);
		void reply(req, res, api);
	});
}

/** The headers the browser's cross-origin rules ask for: whose origin may call (which ways, sending what),
 * and which answer headers JavaScript may read — a workspace's revision travels in them. */
function allowCrossOrigin(res: ServerResponse, origin: string): void {
	res.setHeader("access-control-allow-origin", origin);
	res.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE");
	res.setHeader("access-control-allow-headers", "Content-Type");
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
		const route = routeOf(url.pathname);
		if (!route) return sendEmpty(res, 404);

		if (route.id === null) {
			switch (method) {
				case "GET":
					return sendJson(res, 200, await api.listWorkspaces());
				case "POST": {
					const created = parseCreate(await readJson(req));
					if (!created) return sendEmpty(res, 400);
					const made = await api.createWorkspace({ id: created.id, name: created.name }, created.dataVersion);
					return sendEmpty(res, made ? 201 : 409);
				}
				default:
					return notAllowed(res, "GET, POST");
			}
		}

		const { id } = route;
		switch (route.part) {
			case null:
				switch (method) {
					case "PATCH": {
						const name = parseName(await readJson(req));
						if (name === null) return sendEmpty(res, 400);
						return sendEmpty(res, (await api.renameWorkspace(id, name)) ? 204 : 404);
					}
					case "DELETE":
						await api.deleteWorkspace(id);
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
				const changes = parseChanges(await readJson(req));
				if (changes === null) return sendEmpty(res, 400);
				const answer = await api.writeChanges(id, changes);
				if (!answer) return sendEmpty(res, 404);
				res.setHeader("etag", answer.version);
				return sendJson(res, 200, answer);
			}
		}
	} catch {
		// The storage didn't answer, or refused what it was asked to write. What went wrong stays here:
		// a driver's error can quote the user it tried to connect as, which is part of the URL.
		return sendEmpty(res, 503);
	}
}

/** Where a path leads: the workspaces (`id` null), one workspace (`part` null), or its data or changes.
 * Null for a path that leads nowhere. Ids are percent-decoded, so any id can name its workspace. */
function routeOf(pathname: string): { id: null } | { id: string; part: null | "data" | "changes" } | null {
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
	if (segments.length === 3 && (segments[2] === "data" || segments[2] === "changes")) return { id, part: segments[2] };
	return null;
}

/** A workspace's name as a request names it: a string with something in it; null otherwise. */
function parseName(raw: unknown): string | null {
	const name = (raw as { name?: unknown } | null)?.name;
	return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
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
