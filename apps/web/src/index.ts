import { createWorkspaces } from "@tybo/app/core";
import { httpData } from "./http-data.js";
import viewScript from "virtual:standalone-view";
import { activeWorkspacePreference, render, renderServerUnreachable, sharedText } from "@tybo/app/ui";

// Each feature brings its own styles beside its code; they come after app.css (see index.html).
import.meta.glob("../../../packages/app/src/features/**/*.css", { eager: true });

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("#app element not found");

// VITE_API_URL, set when starting Vite, says where the storage API (apps/api) answers: the data lives there,
// in Postgres, and nowhere else. In the built web app the API is served from the very origin the page came from,
// so "/" is the right base there — and only an absolute base works, because the port builds its URLs from it.
const apiUrl = new URL(import.meta.env.VITE_API_URL ?? "/", globalThis.location.href).toString();
if (!apiUrl) {
	console.error("VITE_API_URL isn't set — the web app needs the storage API's address (see apps/web/.env.example).");
	renderServerUnreachable(root);
} else {
	try {
		const workspaces = await createWorkspaces(httpData(apiUrl, "web"), (n) => sharedText.defaultWorkspaceName(n), activeWorkspacePreference);
		await render(root, workspaces, { viewScript });
	} catch (error) {
		console.error(error);
		renderServerUnreachable(root);
	}
}
