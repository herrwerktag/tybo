import type { AddressInfo } from "node:net";
import { createApp, type Api } from "./http.js";

/** Starts the API on a free port and says where it answers; close() ends it again. `allowedOrigin` says
 * which origin the answers name as allowed; without it, the server itself falls back to CORS_ORIGIN's. */
export async function startApp(api: Api, allowedOrigin?: string): Promise<{ url: URL; close: () => Promise<void> }> {
	const server = createApp(api, allowedOrigin);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: new URL(`http://127.0.0.1:${port}/`),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** Calls the API and answers the status and body the server replied with, and its headers as well. */
export async function call(
	base: URL,
	path: string,
	init?: RequestInit,
): Promise<{ status: number; text: string; header: (name: string) => string | null }> {
	const response = await fetch(new URL(path, base), init);
	return { status: response.status, text: await response.text(), header: (name) => response.headers.get(name) };
}
