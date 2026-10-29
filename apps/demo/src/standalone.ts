import resetCss from "./reset.css?inline";
import appCss from "./app.css?inline";
import { renderStandaloneView } from "@tybo/app/ui";

/** The features' own styles (see index.ts), as text. */
const featureCss = Object.values(
	import.meta.glob<string>("../../../packages/app/src/features/**/*.css", { eager: true, query: "?inline", import: "default" }),
).join("\n");

// The entry of an exported view (see vite.config.ts): one script with the app's styles, run in a page that holds
// its board (standaloneViewHtml in @tybo/app/ui).
document.head.append(Object.assign(document.createElement("style"), { textContent: resetCss + appCss + featureCss }));
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("#app element not found");
renderStandaloneView(root).catch((error: unknown) => console.error(error));
