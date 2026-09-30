import { createStore } from "./store.js";
import { render } from "./ui.js";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("#app element not found");

render(root, createStore(localStorage));
