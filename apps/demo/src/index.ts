import { createWorkspaces } from "@bekbon/core";
import { render, text } from "@bekbon/ui";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("#app element not found");

render(
	root,
	createWorkspaces(localStorage, (n) => text.defaultWorkspaceName(n)),
);
