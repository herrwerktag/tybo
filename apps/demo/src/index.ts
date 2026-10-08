import { createWorkspaces } from "@tybo/core";
import { httpData } from "./http-data.js";
import viewScript from "virtual:standalone-view";
import { activeWorkspacePreference, render, renderServerUnreachable, text } from "@tybo/ui";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("#app element not found");

// VITE_API_URL, set when starting Vite, says where the storage API (apps/api) answers: the data lives there,
// in Postgres, and nowhere else. Without it — or with an API that doesn't answer — there's nothing to show.
const apiUrl = import.meta.env.VITE_API_URL;
if (!apiUrl) {
	console.error("VITE_API_URL isn't set — the demo needs the storage API's address (see apps/demo/.env.example).");
	renderServerUnreachable(root);
} else {
	try {
		const workspaces = await createWorkspaces(httpData(apiUrl), (n) => text.defaultWorkspaceName(n), activeWorkspacePreference);
		await render(root, workspaces, { viewScript });
	} catch (error) {
		console.error(error);
		renderServerUnreachable(root);
	}
}
