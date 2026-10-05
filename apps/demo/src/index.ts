import { createWorkspaces } from "@bekbon/core";
import { localStoragePort } from "./local-storage.js";
import { httpStorage } from "./http-storage.js";
import { render, text } from "@bekbon/ui";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("#app element not found");

// VITE_API_URL, set when starting Vite, decides where the data is saved: through the storage API
// (into Postgres), or — empty, the standard — in the browser's localStorage, as before.
const apiUrl = import.meta.env.VITE_API_URL;

const workspaces = await createWorkspaces(apiUrl ? httpStorage(apiUrl) : localStoragePort(), (n) =>
	text.defaultWorkspaceName(n),
);
await render(root, workspaces);
