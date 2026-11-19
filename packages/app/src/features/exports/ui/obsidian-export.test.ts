import "../../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppData } from "../../../shared/core/index.js";
import type { Board } from "../../boards/core.js";
import type { PropertyDef } from "../../data/core.js";
import { setLanguage } from "../../../shared/ui/index.js";
import { obsidianVault } from "./obsidian-export.js";

const prop = (id: string, name: string, more: Partial<PropertyDef> = {}): PropertyDef => ({
	id,
	name,
	kind: "text",
	options: [],
	reference: null,
	cardDisplay: "list",
	description: "",
	...more,
});
const reference = (typeIds: string[], multiple = false) => ({
	kind: "reference" as const,
	reference: { typeIds, multiple, required: false, arrow: "to" as const, lineLabel: "", inverseLabel: "" },
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
const area = (id: string, text: string, x: number, y: number, width: number, height: number) => ({
	id,
	kind: "area" as const,
	x,
	y,
	width,
	height,
	color: "#c4dafa",
	text,
	textSize: "m" as const,
});
const board = (id: string, name: string, cards: Board["cards"], drawings: Board["drawings"]): Board => ({
	id,
	name,
	cards,
	viewport: { x: 0, y: 0, zoom: 1 },
	viewFrame: { x: 0, y: 0, width: 960, height: 540 },
	chain: { steps: null, direction: "both" },
	drawings,
});

/**
 * Roles and activities: "Buchhaltung" lies where the groups "Verwaltung" and "Finanzen" overlap, "Rechnung prüfen"
 * in a group also named "Verwaltung" on another board; "Vertrieb" has no tags and lies in no group; a role and an
 * activity are both named "Prüfung".
 */
const data: Pick<AppData, "types" | "entities" | "boards" | "guide"> = {
	guide: "So arbeiten wir: erst Rollen, dann Aktivitäten.",
	types: [
		{
			id: "role",
			name: "Rolle",
			color: "#c8ebbf",
			contentTemplate: "",
			description: "Wer etwas verantwortet",
			guide: "Eine Rolle ist keine Person.",
			properties: [prop("status", "Status", { kind: "options", options: [{ id: "o-active", label: "aktiv" }], description: "Ob es sie gibt" })],
		},
		{
			id: "activity",
			name: "Aktivität",
			color: "#c4dafa",
			contentTemplate: "",
			description: "",
			guide: "",
			properties: [
				prop("responsible", "Verantwortlich", reference(["role"])),
				prop("informed", "Informiert", reference(["role"], true)),
				prop("note", "Hinweis: intern"),
			],
		},
	],
	entities: [
		entity("r1", "role", "Buchhaltung", { status: "o-active" }, { tags: ["Finanzen", "Projekt X"], content: "Bucht alles.", description: "Mehr dazu." }),
		entity("r2", "role", "Vertrieb", {}, { content: "Verkauft." }),
		entity("r3", "role", "Prüfung"),
		entity(
			"a1",
			"activity",
			"Rechnung prüfen",
			{ responsible: "r1", informed: ["r2", "r1"], note: 'sagt "nein"\nzweite Zeile' },
			{ description: "Durch {{Verantwortlich}}." },
		),
		entity("a2", "activity", "Prüfung"),
	],
	boards: [
		board(
			"b1",
			"Übersicht",
			[card("c1", "r1", 240, 240), card("c2", "r2", 2400, 0)],
			[area("g1", "Verwaltung", 0, 0, 720, 720), area("g2", "Finanzen", 240, 240, 720, 720)],
		),
		board("b2", "Abläufe", [card("c3", "a1", 0, 0)], [area("g3", " Verwaltung ", -24, -24, 480, 312)]),
	],
};

function vault(data: Pick<AppData, "types" | "entities" | "boards" | "guide">): Map<string, string> {
	setLanguage("de");
	try {
		return new Map(obsidianVault("Projekt X", data).map((f) => [f.name, f.contents]));
	} finally {
		setLanguage("en");
	}
}

test("the vault has a handbook, a folder per type with a note per entity, and an index per group name", () => {
	assert.deepEqual(
		[...vault(data).keys()],
		[
			"Projekt X/Handbuch.md",
			"Projekt X/Rolle/Buchhaltung.md",
			"Projekt X/Rolle/Vertrieb.md",
			"Projekt X/Rolle/Prüfung.md",
			"Projekt X/Aktivität/Rechnung prüfen.md",
			"Projekt X/Aktivität/Prüfung (Aktivität).md",
			"Projekt X/Indizes/Verwaltung.md",
			"Projekt X/Indizes/Finanzen.md",
		],
	);
});

test("the handbook has the guide and per type what it is for, how it is used and its properties", () => {
	assert.equal(
		vault(data).get("Projekt X/Handbuch.md"),
		[
			"# Projekt X",
			"",
			"So arbeiten wir: erst Rollen, dann Aktivitäten.",
			"",
			"## Entitätstypen",
			"",
			"### Rolle",
			"",
			"Wer etwas verantwortet",
			"",
			"Eine Rolle ist keine Person.",
			"",
			"**Eigenschaften:**",
			"- **Status**: Auswahl (aktiv) — Ob es sie gibt",
			"",
			"### Aktivität",
			"",
			"**Eigenschaften:**",
			"- **Verantwortlich**: Referenz → Rolle",
			"- **Informiert**: Referenz → Rolle (mehrfach)",
			"- **Hinweis: intern**: Text",
			"",
			"## Indizes",
			"- [[Verwaltung]]",
			"- [[Finanzen]]",
			"",
		].join("\n"),
	);
});

test("an entity's note starts with its tags and its indexes, below its properties", () => {
	assert.equal(
		vault(data).get("Projekt X/Rolle/Buchhaltung.md"),
		[
			"---",
			'Typ: "Rolle"',
			'Status: "aktiv"',
			"---",
			"**Tags:** #Finanzen #Projekt-X",
			"**Index:** [[Verwaltung]] [[Finanzen]]",
			"",
			"Bucht alles.",
			"",
			"Mehr dazu.",
			"",
		].join("\n"),
	);
});

test("without tags and groups, an entity's text starts with its content", () => {
	assert.equal(vault(data).get("Projekt X/Rolle/Vertrieb.md"), ["---", 'Typ: "Rolle"', "---", "Verkauft.", ""].join("\n"));
});

test("references are links in the frontmatter, a list where several are allowed, and in the description", () => {
	assert.equal(
		vault(data).get("Projekt X/Aktivität/Rechnung prüfen.md"),
		[
			"---",
			'Typ: "Aktivität"',
			'Verantwortlich: "[[Buchhaltung]]"',
			'Informiert: ["[[Vertrieb]]", "[[Buchhaltung]]"]',
			'"Hinweis: intern": "sagt \\"nein\\"\\nzweite Zeile"',
			"---",
			"**Index:** [[Verwaltung]]",
			"",
			"Durch [[Buchhaltung]].",
			"",
		].join("\n"),
	);
});

test("an index links the entities lying in a group of its name on any board, by type", () => {
	const notes = vault(data);
	assert.equal(notes.get("Projekt X/Indizes/Verwaltung.md"), ["# Verwaltung", "", "## Rolle", "- [[Buchhaltung]]", "", "## Aktivität", "- [[Rechnung prüfen]]", ""].join("\n"));
	assert.equal(notes.get("Projekt X/Indizes/Finanzen.md"), ["# Finanzen", "", "## Rolle", "- [[Buchhaltung]]", ""].join("\n"));
});

test("every link names exactly one note of the vault, and none leads out of it", () => {
	const notes = vault(data);
	const names = [...notes.keys()].map((path) => path.slice(path.lastIndexOf("/") + 1, -".md".length).toLocaleLowerCase());
	assert.equal(new Set(names).size, names.length);
	for (const contents of notes.values()) {
		for (const [, link] of contents.matchAll(/\[\[([^\]]+)\]\]/g)) assert.ok(names.includes(link!.toLocaleLowerCase()), link!);
		assert.doesNotMatch(contents, /https?:|#boards|#data/);
	}
});

test("names clash neither with the handbook nor with each other, and lose what Obsidian doesn't allow", () => {
	const clashing = {
		...data,
		entities: [entity("r1", "role", "Handbuch"), entity("r2", "role", "A/B: [x] #1"), entity("r3", "role", "Verwaltung")],
		boards: [board("b", "B", [card("c", "r3", 0, 0)], [area("g", "Verwaltung", 0, 0, 480, 480), area("g2", "", 2000, 0, 100, 100)])],
	};
	assert.deepEqual(
		[...vault(clashing).keys()],
		[
			"Projekt X/Handbuch.md",
			"Projekt X/Rolle/Handbuch (Rolle).md",
			"Projekt X/Rolle/A-B- -x- -1.md",
			"Projekt X/Rolle/Verwaltung.md",
			"Projekt X/Indizes/Verwaltung (Index).md",
			"Projekt X/Indizes/Gruppe 1.md",
		],
	);
	assert.match(vault(clashing).get("Projekt X/Rolle/Verwaltung.md")!, /^\*\*Index:\*\* \[\[Verwaltung \(Index\)\]\]$/m);
});

test("a property named like the type key keeps its value; the type is left out then", () => {
	const typed = {
		...data,
		types: [{ ...data.types[0]!, properties: [prop("kind", "Typ")] }],
		entities: [entity("r1", "role", "Buchhaltung", { kind: "intern" })],
		boards: [],
	};
	assert.equal(vault(typed).get("Projekt X/Rolle/Buchhaltung.md"), ["---", 'Typ: "intern"', "---", ""].join("\n"));
});
