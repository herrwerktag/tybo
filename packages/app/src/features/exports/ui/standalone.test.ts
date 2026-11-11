import { freshDom } from "../../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { language, setLanguage } from "../../../shared/ui/index.js";
import { renderStandaloneView, standaloneViewHtml } from "./standalone.js";
import { DRAWING_LAYER } from "../../drawings/ui.js";
import { DATA_VERSION, type AppData } from "../../../shared/core/index.js";
import { createStore } from "../../../features.core.js";

const viewport = { x: 0, y: 0, zoom: 1 };
/** Entity ids are ULIDs; others are given new ones on load. */
const DUNE = "01J00000000000000000000001";
const HERBERT = "01J00000000000000000000002";
const card = (id: string, entityId: string) => ({ id, entityId, x: 0, y: 0, width: 240, height: 160 });

/** Two boards: Dune and a text box on "Reading" (with a name that would end the script element),
 * Herbert on "Authors". */
const data = {
	types: [{ id: "book", name: "Book", color: "#c4dafa", contentTemplate: "", description: "", guide: "", properties: [] }],
	entities: [
		{ id: DUNE, typeId: "book", name: "Dune </script><b>", content: "", description: "A desert planet.", values: {} },
		{ id: HERBERT, typeId: "book", name: "Herbert", content: "", description: "", values: {} },
	],
	boards: [
		{
			id: "reading",
			name: "Reading & <more>",
			cards: [card("c1", DUNE)],
			viewport,
			drawings: [{ id: "d1", kind: "textbox", x: 300, y: 0, width: 50, height: 50, color: "#f6e8a6", text: "", textSize: "m" }],
		},
		{ id: "authors", name: "Authors", cards: [card("c2", HERBERT)], viewport, drawings: [] },
	],
} as unknown as AppData;

/** Opens an exported page the way a browser would show its body, without running the viewer's script. */
async function openExport(html: string): Promise<HTMLElement> {
	freshDom();
	document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
	const root = document.querySelector<HTMLElement>("#app")!;
	await renderStandaloneView(root, { layers: [DRAWING_LAYER], createStore });
	return root;
}

test("an exported view holds only the chosen board, its language and the script, safely escaped", () => {
	const html = standaloneViewHtml("run();", data, "reading", "de");

	assert.match(html, /<html lang="de">/);
	assert.match(html, /<title>Reading &amp; &lt;more&gt;<\/title>/);
	assert.match(html, /<script>run\(\);<\/script>/);
	// One </script> for each of the two script elements: the entity's name doesn't end one early.
	assert.equal(html.match(/<\/script>/g)?.length, 2);
	const json = /<script type="application\/json" id="tybo-view">(.*)<\/script>\n/.exec(html)![1]!;
	const view = JSON.parse(json);
	assert.equal(view.language, "de");
	assert.equal(view.data.version, DATA_VERSION);
	assert.deepEqual(view.data.boards.map((b: { id: string }) => b.id), ["reading"]);
	assert.equal(view.data.entities.length, 2); // all entities, so every reference can be shown
});

test("an exported view shows its board read-only in its language, and a click on a card shows the details", async () => {
	setLanguage("en");
	const root = await openExport(standaloneViewHtml("", data, "reading", "de"));

	assert.equal(language, "de");
	assert.equal(root.querySelector(".app-nav"), null);
	assert.equal(root.querySelector(".canvas-view.read-only .canvas-panel"), null);
	assert.ok(root.querySelector(".canvas-zoom")); // pan and zoom as in the View tab
	assert.equal(root.querySelectorAll(".drawings rect.drawing-shape").length, 1, "the text box is drawn");
	const cards = root.querySelectorAll<HTMLElement>(".canvas-board .canvas-card");
	assert.deepEqual([...cards].map((c) => c.dataset.cardId), ["c1"]);
	assert.equal(root.querySelector(".canvas-card .card-remove"), null);

	cards[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	const details = root.querySelector<HTMLElement>(".details-panel")!;
	assert.equal(details.hidden, false);
	assert.equal(details.querySelector(".details-title")?.textContent, "Dune </script><b>");
	assert.equal(details.querySelector(".details-actions"), null); // nothing to edit in an export
	setLanguage("en");
});


test("an exported view has the chain's reach too: it starts with the board's and changes it without saving", async () => {
	const ids = ["01J00000000000000000000011", "01J00000000000000000000012", "01J00000000000000000000013"];
	const reference = { typeIds: ["step"], multiple: false, required: false, arrow: "to", lineLabel: "", inverseLabel: "" };
	const next = { id: "next", name: "next", kind: "reference", options: [], reference, cardDisplay: "line", description: "" };
	// a → b → c, the board reaching one step.
	const chained = {
		types: [{ id: "step", name: "Step", color: "#c4dafa", contentTemplate: "", description: "", guide: "", properties: [next] }],
		entities: ids.map((id, i) => ({ id, typeId: "step", name: "abc"[i], content: "", description: "", values: ids[i + 1] ? { next: ids[i + 1] } : {} })),
		boards: [
			{
				id: "flow",
				name: "Flow",
				cards: ids.map((id, i) => ({ ...card(`c${i}`, id), x: i * 300 })),
				viewport,
				chain: { steps: 1, direction: "both" },
				drawings: [],
			},
		],
	} as unknown as AppData;
	const html = standaloneViewHtml("", chained, "flow", "en");
	const inChain = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".canvas-card.in-chain")].map((c) => c.dataset.cardId);

	let root = await openExport(html);
	root.querySelector<HTMLElement>('.canvas-card[data-card-id="c0"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	const slider = root.querySelector<HTMLInputElement>(".chain-reach input[type=range]")!;
	assert.deepEqual([slider.value, slider.max], ["1", "2"]);
	assert.deepEqual(inChain(root), ["c0", "c1"]);
	slider.value = "2";
	slider.dispatchEvent(new Event("input", { bubbles: true }));
	assert.deepEqual(inChain(root), ["c0", "c1", "c2"]);

	// Opened again, it reaches one step, as the board does.
	root = await openExport(html);
	root.querySelector<HTMLElement>('.canvas-card[data-card-id="c0"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	assert.deepEqual(inChain(root), ["c0", "c1"]);
});
