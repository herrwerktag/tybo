import { freshDom } from "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { language, setLanguage } from "./i18n.js";
import { renderStandaloneView, standaloneViewHtml } from "./standalone.js";
import { DATA_VERSION, type AppData } from "@bekbon/core";

const viewport = { x: 0, y: 0, zoom: 1 };
/** Entity ids are ULIDs; others are given new ones on load. */
const DUNE = "01J00000000000000000000001";
const HERBERT = "01J00000000000000000000002";
const card = (id: string, entityId: string) => ({ id, entityId, x: 0, y: 0, width: 240, height: 160 });

/** Two boards: Dune on "Reading" (with a name that would end the script element), Herbert on "Authors". */
const data = {
	types: [{ id: "book", name: "Book", color: "#c4dafa", contentTemplate: "", properties: [] }],
	entities: [
		{ id: DUNE, typeId: "book", name: "Dune </script><b>", content: "", description: "A desert planet.", values: {} },
		{ id: HERBERT, typeId: "book", name: "Herbert", content: "", description: "", values: {} },
	],
	boards: [
		{ id: "reading", name: "Reading & <more>", cards: [card("c1", DUNE)], viewport, drawings: [] },
		{ id: "authors", name: "Authors", cards: [card("c2", HERBERT)], viewport, drawings: [] },
	],
} as unknown as AppData;

/** Opens an exported page the way a browser would show its body, without running the viewer's script. */
async function openExport(html: string): Promise<HTMLElement> {
	freshDom();
	document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
	const root = document.querySelector<HTMLElement>("#app")!;
	await renderStandaloneView(root);
	return root;
}

test("an exported view holds only the chosen board, its language and the script, safely escaped", () => {
	const html = standaloneViewHtml("run();", data, "reading", "de");

	assert.match(html, /<html lang="de">/);
	assert.match(html, /<title>Reading &amp; &lt;more&gt;<\/title>/);
	assert.match(html, /<script>run\(\);<\/script>/);
	// One </script> for each of the two script elements: the entity's name doesn't end one early.
	assert.equal(html.match(/<\/script>/g)?.length, 2);
	const json = /<script type="application\/json" id="bekbon-view">(.*)<\/script>\n/.exec(html)![1]!;
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

test("an exported storyboard starts on its first page and steps through its pages", async () => {
	setLanguage("en");
	const page = (id: string, name: string, cardIds: string[]) => ({ id, name, description: "", viewport, cardIds, drawingIds: [] });
	const story = {
		...data,
		boards: [
			{
				id: "story",
				name: "Story",
				kind: "storyboard",
				cards: [card("c1", DUNE), card("c2", HERBERT)],
				viewport,
				drawings: [],
				pages: [page("p1", "Book", ["c1"]), page("p2", "Author", ["c1", "c2"])],
			},
		],
	} as unknown as AppData;
	const root = await openExport(standaloneViewHtml("", story, "story", "en"));
	const shown = () => [...root.querySelectorAll<HTMLElement>(".canvas-board .canvas-card")].map((c) => c.dataset.cardId);

	assert.deepEqual(shown(), ["c1"]);
	assert.equal(root.querySelector(".page-bar .page-name")?.textContent, "Book");
	root.querySelector<HTMLButtonElement>('.page-bar button[title="Next step"]')!.click();
	assert.deepEqual(shown(), ["c1", "c2"]);
	assert.equal(root.querySelector(".page-bar .page-name")?.textContent, "Author");
});
