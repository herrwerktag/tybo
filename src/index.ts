import { text } from "./i18n.js";
import { render } from "./ui.js";
import { createWorkspaces } from "./workspaces.js";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("#app element not found");

render(
	root,
	createWorkspaces(localStorage, (n) => text.defaultWorkspaceName(n)),
);
