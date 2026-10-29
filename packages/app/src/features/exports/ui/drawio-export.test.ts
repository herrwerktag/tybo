import "../../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppData } from "../../../shared/core/index.js";
import type { Board } from "../../boards/core.js";
import type { PropertyDef } from "../../data/core.js";
import { boardDrawio, boardDrawioFiles } from "./drawio-export.js";
import { text } from "../texts.js";

const prop = (id: string, name: string, more: Partial<PropertyDef> = {}): PropertyDef => ({
	id,
	name,
	kind: "text",
	options: [],
	reference: null,
	cardDisplay: "list",
	...more,
});
const reference = (typeIds: string[], more: Partial<NonNullable<PropertyDef["reference"]>> = {}) => ({
	kind: "reference" as const,
	cardDisplay: "line" as const,
	reference: { typeIds, multiple: false, required: false, arrow: "to" as const, lineLabel: "", inverseLabel: "", ...more },
});
const entity = (id: string, typeId: string, name: string, values: AppData["entities"][number]["values"] = {}, more = {}) => ({
	id,
	typeId,
	name,
	content: "",
	description: "",
	tags: [],
	values,
	...more,
});
const card = (id: string, entityId: string, x: number, y: number) => ({ id, entityId, x, y, width: 240, height: 168 });

/** An activity drawn to its role (whose second card is far away) and its input (from the input, labelled), a status,
 * and a reference to a role without a card on the board. */
const data: Pick<AppData, "types" | "entities" | "boards"> = {
	types: [
		{
			id: "activity",
			name: "Aktivität",
			color: "#c4dafa",
			contentTemplate: "",
			properties: [
				prop("responsible", "Verantwortlich", reference(["role"])),
				prop("input", "Eingabe", reference(["artifact"], { arrow: "from", lineLabel: "liefert" })),
				prop("informed", "Informiert", reference(["role"])),
				prop("status", "Status", { kind: "options", options: ["offen", "fertig"] }),
				prop("secret", "Intern", { cardDisplay: "hidden" }),
			],
		},
		{ id: "role", name: "Rolle", color: "#c8ebbf", contentTemplate: "", properties: [] },
		{ id: "artifact", name: "Artefakt", color: "#f6e8a6", contentTemplate: "", properties: [] },
	],
	entities: [
		entity(
			"a1",
			"activity",
			"Rechnung <prüfen> & buchen",
			{ responsible: "r1", input: "f1", informed: "r2", status: "offen", secret: "geheim" },
			{ content: "Zeile 1\nZeile 2", description: "Status: {{Status}}, durch {{Verantwortlich}}" },
		),
		entity("r1", "role", "Buchhaltung"),
		entity("r2", "role", "Einkauf"),
		entity("f1", "artifact", "Rechnung"),
	],
	boards: [
		{
			id: "b",
			name: "Prozess \"Rechnung\"",
			cards: [card("ca", "a1", 0, 0), card("cr-far", "r1", 2400, 0), card("cr", "r1", 480, 0), card("cf", "f1", 0, 480)],
			viewport: { x: 0, y: 0, zoom: 1 },
			viewFrame: { x: 0, y: 0, width: 960, height: 540 },
			drawings: [],
		} satisfies Board,
	],
};

const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");
const cell = (doc: Document, id: string) => doc.querySelector(`[id="${id}"]`)!;
const label = (doc: Document, id: string) => cell(doc, id).getAttribute("label")!;

test("the board is one diagram page named after it", () => {
	const doc = parse(boardDrawio(data, "b"));
	assert.equal(doc.querySelector("diagram")!.getAttribute("name"), 'Prozess "Rechnung"');
	assert.equal(doc.querySelector("mxGraphModel")!.getAttribute("gridSize"), "24");
});

test("cards are boxes where they are on the board, as large as the editor measured them", () => {
	const doc = parse(boardDrawio(data, "b"));
	const geometry = (id: string) => cell(doc, id).querySelector("mxGeometry")!;
	assert.deepEqual(
		["x", "y", "width", "height"].map((a) => geometry("card-ca").getAttribute(a)),
		["0", "0", "240", "168"],
	);
	assert.equal(geometry("card-cr").getAttribute("x"), "480");
});

test("a card shows its type, name, properties shown on cards and content, escaped", () => {
	const doc = parse(boardDrawio(data, "b"));
	const html = label(doc, "card-ca");
	assert.match(html, /background:#c4dafa;[^>]*>Aktivität</);
	assert.match(html, /Rechnung &lt;prüfen&gt; &amp; buchen/);
	assert.match(html, />Status<\/td><td><span [^>]*background:#ebebeb;">offen</);
	// A line target without a card on the board is listed instead, in its type color.
	assert.match(html, />Informiert<\/td><td><span [^>]*background:#c8ebbf;">Einkauf</);
	assert.match(html, /Zeile 1<br>Zeile 2/);
	assert.doesNotMatch(html, /Verantwortlich|Eingabe|Intern|geheim/);
});

test("the description is the tooltip, with its placeholders filled in", () => {
	const doc = parse(boardDrawio(data, "b"));
	assert.equal(cell(doc, "card-ca").getAttribute("tooltip"), "<p>Status: offen, durch Buchhaltung</p>");
	assert.equal(cell(doc, "card-cr").getAttribute("tooltip"), "");
});

test("the tooltip shows the description's Markdown as HTML, filled-in values as typed", () => {
	const description = "**Wichtig:** {{Status}}\n\n- [Doku](https://example.org)\n- <b>nein</b>";
	const withMarkdown = {
		...data,
		entities: data.entities.map((e) => (e.id === "a1" ? { ...e, description, values: { ...e.values, status: "*offen*" } } : e)),
	};
	assert.equal(
		cell(parse(boardDrawio(withMarkdown, "b")), "card-ca").getAttribute("tooltip"),
		'<p><strong>Wichtig:</strong> *offen*</p><ul><li><a href="https://example.org" target="_blank" rel="noopener noreferrer">Doku</a></li><li>&lt;b&gt;nein&lt;/b&gt;</li></ul>',
	);
});

test("line references are edges to the nearest card, with their label and arrow", () => {
	const doc = parse(boardDrawio(data, "b"));
	const edges = [...doc.querySelectorAll("mxCell[edge]")].map((e) => ({
		source: e.getAttribute("source"),
		target: e.getAttribute("target"),
		value: e.getAttribute("value"),
		style: e.getAttribute("style")!,
	}));
	assert.equal(edges.length, 2);
	assert.deepEqual(edges.map(({ source, target, value }) => [source, target, value]), [
		["card-ca", "card-cr", "Verantwortlich"],
		["card-ca", "card-cf", "liefert"],
	]);
	assert.match(edges[0]!.style, /endArrow=block;startArrow=none;/);
	assert.match(edges[1]!.style, /endArrow=none;startArrow=block;/);
});

test("cards of deleted entities are left out", () => {
	const gone = structuredClone(data);
	gone.entities = gone.entities.filter((e) => e.id !== "r1");
	const doc = parse(boardDrawio(gone, "b"));
	assert.equal(doc.querySelector('[id="card-cr"]'), null);
	assert.equal(doc.querySelectorAll("mxCell[edge]").length, 1);
});

const area = (id: string, name: string, x: number, y: number, width: number, height: number) =>
	({ id, kind: "area" as const, x, y, width, height, color: "#c4dafa", text: name, textSize: "m" as const });

/** The board with groups: "Rechnungswesen" around the activity and its role, "Kern" in it around the activity only,
 * another "Rechnungswesen" around the far role card, and an empty group without a name. */
const grouped = structuredClone(data);
grouped.boards[0]!.drawings = [
	area("outer", "Rechnungswesen", -24, -48, 792, 300),
	area("kern", "Kern", -12, -24, 300, 240),
	area("far", "Rechnungswesen", 2376, -24, 288, 216),
	area("empty", " ", 0, 1000, 240, 240),
];
const geometryOf = (doc: Document, id: string) =>
	["x", "y"].map((a) => cell(doc, id).querySelector("mxGeometry")!.getAttribute(a));
const parentOf = (doc: Document, id: string) => (cell(doc, id).tagName === "UserObject" ? cell(doc, id).firstElementChild! : cell(doc, id)).getAttribute("parent");

test("without groups, the board is exported as one file", () => {
	assert.deepEqual(boardDrawioFiles(data, "b").map((f) => f.name), ["Prozess -Rechnung-.drawio"]);
	assert.equal(boardDrawioFiles(data, "b")[0]!.contents, boardDrawio(data, "b"));
});

test("groups are named containers; cards and groups hang in the smallest group around their middle, placed relative to it", () => {
	const doc = parse(boardDrawio(grouped, "b"));
	assert.equal(cell(doc, "area-outer").getAttribute("value"), "Rechnungswesen");
	assert.match(cell(doc, "area-outer").getAttribute("style")!, /container=1;.*fillColor=#c4dafa;/);
	assert.deepEqual([parentOf(doc, "area-outer"), ...geometryOf(doc, "area-outer")], ["1", "-24", "-48"]);
	assert.deepEqual([parentOf(doc, "area-kern"), ...geometryOf(doc, "area-kern")], ["area-outer", "12", "24"]);
	assert.deepEqual([parentOf(doc, "card-ca"), ...geometryOf(doc, "card-ca")], ["area-kern", "12", "24"]);
	assert.deepEqual([parentOf(doc, "card-cr"), ...geometryOf(doc, "card-cr")], ["area-outer", "504", "48"]);
	assert.deepEqual([parentOf(doc, "card-cf"), ...geometryOf(doc, "card-cf")], ["1", "0", "480"]);
	// Containers come before what's in them.
	const ids = [...doc.querySelectorAll("[id]")].map((n) => n.getAttribute("id"));
	assert.ok(ids.indexOf("area-outer") < ids.indexOf("area-kern") && ids.indexOf("area-kern") < ids.indexOf("card-ca"));
	assert.equal(doc.querySelectorAll("mxCell[edge]").length, 2, "lines between groups stay");
});

test("each group gets a file of its own: what lies in it, from (0, 0); lines out of it are listed instead", () => {
	const files = boardDrawioFiles(grouped, "b");
	assert.deepEqual(files.map((f) => f.name), [
		"Prozess -Rechnung-.drawio",
		"Rechnungswesen.drawio",
		"Kern.drawio",
		"Rechnungswesen 2.drawio",
		`${text.groupFallbackName} 1.drawio`,
	]);
	const outer = parse(files[1]!.contents);
	assert.equal(outer.querySelector("diagram")!.getAttribute("name"), "Rechnungswesen");
	assert.deepEqual(geometryOf(outer, "area-outer"), ["0", "0"]);
	assert.deepEqual([...outer.querySelectorAll("UserObject")].map((n) => n.getAttribute("id")), ["card-ca", "card-cr"]);
	assert.deepEqual([...outer.querySelectorAll("mxCell[edge]")].map((e) => e.getAttribute("target")), ["card-cr"]);
	assert.match(label(outer, "card-ca"), />Eingabe<\/td><td><span [^>]*>Rechnung</, "the input's card is outside: listed");

	const kern = parse(files[2]!.contents);
	assert.deepEqual([...kern.querySelectorAll("[id^=area-]")].map((n) => n.getAttribute("id")), ["area-kern"]);
	assert.deepEqual(geometryOf(kern, "card-ca"), ["12", "24"]);
	assert.match(label(kern, "card-ca"), />Verantwortlich<\/td><td><span [^>]*>Buchhaltung</);

	assert.equal(parse(files[4]!.contents).querySelectorAll("UserObject").length, 0, "an empty group is an empty file");
});
