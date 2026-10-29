import "../../shared/ui/test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Analysis, AppData, PathStep, PropertyDef } from "../core/index.js";
import { analysisMarkdownFiles } from "./analysis-export.js";
import { setLanguage } from "./i18n.js";

const prop = (id: string, name: string, more: Partial<PropertyDef> = {}): PropertyDef => ({
	id,
	name,
	kind: "text",
	options: [],
	reference: null,
	cardDisplay: "list",
	...more,
});
const reference = (typeIds: string[]) => ({
	kind: "reference" as const,
	reference: { typeIds, multiple: true, required: false, arrow: "to" as const, lineLabel: "", inverseLabel: "" },
});
const entity = (
	id: string,
	typeId: string,
	name: string,
	values: AppData["entities"][number]["values"] = {},
	description = "",
	content = "",
) => ({
	id,
	typeId,
	name,
	content,
	description,
	tags: [],
	values,
});
const step = (propertyId: string): PathStep[] => [{ propertyId, direction: "forward" }];
const analysis = (more: Partial<Analysis> = {}): Analysis => ({ id: "an", name: "Prüfung", typeId: "activity", groups: [], columns: [], ...more });

/** Activities with responsible roles (several), needed artifacts (several, two sharing a name) and a status. */
const data: Pick<AppData, "types" | "entities"> = {
	types: [
		{
			id: "activity",
			name: "Aktivität",
			color: "#c4dafa",
			contentTemplate: "",
			properties: [
				prop("responsible", "Verantwortlicher", reference(["role"])),
				prop("needs", "Benötigt", reference(["artifact"])),
				prop("status", "Status", { kind: "options", options: ["offen", "fertig"] }),
			],
		},
		{ id: "role", name: "Rolle", color: "#c8ebbf", contentTemplate: "", properties: [] },
		{ id: "artifact", name: "Artefakt", color: "#f6e8a6", contentTemplate: "", properties: [] },
	],
	entities: [
		entity(
			"a1",
			"activity",
			"Rechnung prüfen",
			{ responsible: ["r1", "r2"], needs: ["x1", "x2"], status: "offen" },
			"{{Status}}, mit {{Benötigt}}\n# Schritte",
			"Gegen die Bestellung prüfen.\n# Notiz",
		),
		entity("a2", "activity", "Zahlung anweisen"),
		entity("r1", "role", "Buchhaltung", {}, "Bucht."),
		entity("r2", "role", "Einkauf"),
		entity("x1", "artifact", "Rechnung", {}, "Die Rechnung.", "Als PDF."),
		entity("x2", "artifact", "Rechnung"),
	],
};

/** The contents of the analysis's Markdown files, by file name. */
const markdownFiles = (an: Analysis, from = data) =>
	Object.fromEntries(analysisMarkdownFiles(from, an, "2026-10-21").map((file) => [file.name, file.contents]));

test("an analysis as Markdown: its groups as headings, a section per row with its content, a table of its columns and its description, then the entities the columns name", () => {
	setLanguage("de");
	try {
		const row = (depth: string) => `${depth} Aktivität „Rechnung prüfen“

Gegen die Bestellung prüfen.
${depth}# Notiz

| Benötigt | Status |
| --- | --- |
| Artefakt „Rechnung“, Artefakt „Rechnung (2)“ | offen |

offen, mit Artefakt „Rechnung“, Artefakt „Rechnung (2)“
${depth}# Schritte`;
		const mentioned = `---

## In den Spalten genannt

### Artefakt „Rechnung“

Als PDF.

Die Rechnung.

### Artefakt „Rechnung (2)“
`;
		const unassigned = (depth: string) => `${depth} Aktivität „Zahlung anweisen“

| Benötigt | Status |
| --- | --- |
| — | — |
`;
		const files = markdownFiles(analysis({ groups: [step("responsible")], columns: [step("needs"), step("status")] }));
		assert.deepEqual(Object.keys(files), ["Prüfung 2026-10-21.md", "Buchhaltung.md", "Einkauf.md", "Ohne Verantwortlicher.md"]);
		assert.equal(
			files["Prüfung 2026-10-21.md"],
			`# Prüfung (Stand 2026-10-21)

## Buchhaltung

${row("###")}

## Einkauf

${row("###")}

## Ohne Verantwortlicher

${unassigned("###")}
${mentioned}`,
		);
		assert.equal(files["Buchhaltung.md"], `# Buchhaltung\n\nBucht.\n\n${row("##")}\n\n${mentioned}`, "the group's entity's description comes first");
		assert.equal(files["Einkauf.md"], `# Einkauf\n\n${row("##")}\n\n${mentioned}`);
		assert.equal(files["Ohne Verantwortlicher.md"], `# Ohne Verantwortlicher\n\n${unassigned("##")}`, "naming no entity, it has no list of them");
	} finally {
		setLanguage("en");
	}
});

test("without grouping there is only the one file, the rows being sections of their own; without columns naming entities there is no list of them", () => {
	setLanguage("en");
	assert.deepEqual(markdownFiles(analysis({ columns: [step("status")] })), {
		"Prüfung 2026-10-21.md": `# Prüfung (as of 2026-10-21)

## Aktivität "Rechnung prüfen"

Gegen die Bestellung prüfen.
### Notiz

| Status |
| --- |
| offen |

offen, mit Artefakt "Rechnung", Artefakt "Rechnung (2)"
### Schritte

## Aktivität "Zahlung anweisen"

| Status |
| --- |
| — |
`,
	});
});

test("files of groups with the same name are numbered; nested groups have their own headings in a group's file", () => {
	const files = markdownFiles(analysis({ groups: [step("needs"), step("responsible")] }));
	assert.deepEqual(Object.keys(files), ["Prüfung 2026-10-21.md", "Rechnung.md", "Rechnung 2.md", "Without Benötigt.md"]);
	assert.match(files["Rechnung 2.md"]!, /^# Rechnung\n\n## Buchhaltung\n\n### Aktivität "Rechnung prüfen"\n/);
});

test("a group's file starts with its entity's content and description, their headings below its title; the entity isn't listed again as named", () => {
	const files = markdownFiles(analysis({ groups: [step("needs")], columns: [step("needs")] }));
	assert.match(files["Rechnung.md"]!, /^# Rechnung\n\nAls PDF\.\n\nDie Rechnung\.\n\n## Aktivität "Rechnung prüfen"\n/);
	assert.match(files["Rechnung.md"]!, /### Artefakt "Rechnung \(2\)"\n$/);
	assert.doesNotMatch(files["Rechnung.md"]!, /### Artefakt "Rechnung"\n/);
	assert.match(files["Prüfung 2026-10-21.md"]!, /^## Rechnung\n\n### Aktivität/m, "the full analysis has no group texts");

	const headed: typeof data = {
		types: data.types,
		entities: data.entities.map((e) => (e.id === "x1" ? { ...e, content: "", description: "# Zweck\nBeleg." } : e)),
	};
	assert.match(markdownFiles(analysis({ groups: [step("needs")] }), headed)["Rechnung.md"]!, /^# Rechnung\n\n## Zweck\nBeleg\.\n\n## Aktivität/);
});

test("a | in a table cell is escaped; headings in code blocks stay as they are and nested headings don't go below the sixth level", () => {
	const piped: typeof data = {
		types: data.types,
		entities: data.entities.map((e) =>
			e.id === "a2" ? { ...e, values: { status: "in | Arbeit" }, description: "```\n# kein Titel\n```\n##### Tief" } : e,
		),
	};
	const contents = markdownFiles(analysis({ columns: [step("status")] }), piped)["Prüfung 2026-10-21.md"]!;
	assert.match(contents, /^\| in \\\| Arbeit \|$/m);
	assert.match(contents, /^```\n# kein Titel\n```\n###### Tief$/m);
});

test("deeply nested groups don't go below the sixth heading level; an analysis without a type is only its title", () => {
	const deep = markdownFiles(analysis({ groups: Array.from({ length: 5 }, () => step("responsible")) }))["Prüfung 2026-10-21.md"]!;
	assert.match(deep, /^###### Buchhaltung$/m);
	assert.match(deep, /^###### Aktivität "Rechnung prüfen"$/m);
	assert.doesNotMatch(deep, /#######/);
	assert.deepEqual(markdownFiles(analysis({ typeId: null })), { "Prüfung 2026-10-21.md": "# Prüfung (as of 2026-10-21)\n" });
});
