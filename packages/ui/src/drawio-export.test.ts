import "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppData, Board, PropertyDef } from "@tybo/core";
import { boardDrawio } from "./drawio-export.js";

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
	reference: { typeIds, multiple: false, arrow: "to" as const, lineLabel: "", inverseLabel: "", ...more },
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
			frames: [],
			drawings: [],
			stories: [],
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

test("cards are boxes where they are on the board; without content, as tall as what they show", () => {
	const doc = parse(boardDrawio(data, "b"));
	const geometry = (id: string) => cell(doc, id).querySelector("mxGeometry")!;
	assert.deepEqual(
		["x", "y", "width", "height"].map((a) => geometry("card-ca").getAttribute(a)),
		["0", "0", "240", "168"],
	);
	// Bar and name only: three grid steps.
	assert.equal(geometry("card-cr").getAttribute("height"), "72");
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
	assert.equal(cell(doc, "card-ca").getAttribute("tooltip"), "Status: offen, durch Buchhaltung");
	assert.equal(cell(doc, "card-cr").getAttribute("tooltip"), "");
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
