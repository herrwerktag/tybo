import { createWorkspaces } from "@bekbon/core";
import { localStoragePort } from "./local-storage.js";
import { render, text } from "@bekbon/ui";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("#app element not found");

const workspaces = await createWorkspaces(localStoragePort(), (n) => text.defaultWorkspaceName(n));
await render(root, workspaces);
