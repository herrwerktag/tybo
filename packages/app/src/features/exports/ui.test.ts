import { library, memoryStorage, startApp } from "../../test-app.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { text } from "./texts.js";

/** Opens the boards' export dropdown and clicks the export titled `title`. */
function exportBoard(app: HTMLElement, title: string): void {
	app.querySelector<HTMLButtonElement>(".export-switch")!.click();
	app.querySelector<HTMLButtonElement>(`.export-dialog button[title="${title}"]`)!.click();
}

test("the boards export the current board as an HTML file with the viewer inside", async () => {
	const data = structuredClone(library) as { boards: unknown[] };
	data.boards = [{ id: "b", name: "Shelf", cards: [{ id: "c", entityId: "01J00000000000000000000000", x: 0, y: 0, width: 240, height: 160 }], viewport: { x: 0, y: 0, zoom: 1 }, drawings: [] }];
	// Without the viewer's script there's nothing to export with.
	const withoutScript = await startApp(data, "#boards");
	withoutScript.querySelector<HTMLButtonElement>(".export-switch")!.click();
	assert.equal(withoutScript.querySelector(`.export-dialog button[title="${text.exportView}"]`), null);

	const app = await startApp(data, "#boards", memoryStorage(data), { viewScript: "viewer();" });
	const downloads: Blob[] = [];
	const createObjectURL = URL.createObjectURL;
	URL.createObjectURL = (blob: Blob) => (downloads.push(blob), "blob:export");
	try {
		exportBoard(app, text.exportView);
	} finally {
		URL.createObjectURL = createObjectURL;
	}
	assert.equal(downloads[0]?.type, "text/html");
	const html = await downloads[0]!.text();
	assert.match(html, /<title>Shelf<\/title>/);
	assert.match(html, /<script>viewer\(\);<\/script>/);
	assert.match(html, /"name":"Dune"/);
});

test("the boards export the current board for draw.io", async () => {
	const data = structuredClone(library) as { boards: unknown[] };
	data.boards = [{ id: "b", name: "Shelf", cards: [{ id: "c", entityId: "01J00000000000000000000000", x: 0, y: 0, width: 240, height: 160 }], viewport: { x: 0, y: 0, zoom: 1 }, drawings: [] }];
	const app = await startApp(data, "#boards");
	const downloads: Blob[] = [];
	const createObjectURL = URL.createObjectURL;
	URL.createObjectURL = (blob: Blob) => (downloads.push(blob), "blob:export");
	try {
		exportBoard(app, text.exportDrawio);
	} finally {
		URL.createObjectURL = createObjectURL;
	}
	assert.equal(downloads[0]?.type, "application/xml");
	const xml = await downloads[0]!.text();
	assert.match(xml, /<diagram id="b" name="Shelf">/);
	assert.match(xml, /<UserObject id="card-c" label="[^"]*Dune/);
});

test("with groups on the board, the draw.io export is a ZIP with one more file per group", async () => {
	const data = structuredClone(library) as { boards: unknown[] };
	const group = { id: "g", kind: "area", x: -24, y: -24, width: 480, height: 312, color: "#c4dafa", text: "Regal", textSize: "m" };
	data.boards = [{ id: "b", name: "Shelf", cards: [{ id: "c", entityId: "01J00000000000000000000000", x: 0, y: 0, width: 240, height: 160 }], viewport: { x: 0, y: 0, zoom: 1 }, drawings: [group] }];
	const app = await startApp(data, "#boards");
	const downloads: Blob[] = [];
	const names: string[] = [];
	const createObjectURL = URL.createObjectURL;
	const click = HTMLAnchorElement.prototype.click;
	URL.createObjectURL = (blob: Blob) => (downloads.push(blob), "blob:export");
	HTMLAnchorElement.prototype.click = function () {
		names.push(this.download);
	};
	try {
		exportBoard(app, text.exportDrawio);
	} finally {
		URL.createObjectURL = createObjectURL;
		HTMLAnchorElement.prototype.click = click;
	}
	assert.deepEqual([names[0], downloads[0]?.type], ["Shelf.zip", "application/zip"]);
	const zip = new TextDecoder().decode(await downloads[0]!.arrayBuffer());
	assert.match(zip, /Shelf\.drawio/);
	assert.match(zip, /Regal\.drawio/);
	assert.match(zip, /<mxCell id="area-g" value="Regal"/);
});

test("the workspace menu exports the workspace as a text file", async () => {
	const root = await startApp(library);
	const downloads: Blob[] = [];
	const createObjectURL = URL.createObjectURL;
	URL.createObjectURL = (blob: Blob) => (downloads.push(blob), "blob:export");
	try {
		root.querySelector<HTMLButtonElement>(`button[title="${text.exportText}"]`)!.click();
	} finally {
		URL.createObjectURL = createObjectURL;
	}
	assert.equal(downloads[0]?.type, "text/plain;charset=utf-8");
	assert.match(await downloads[0]!.text(), /^## Book "Dune"$/m);
});
