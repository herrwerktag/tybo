import "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Analysis, AppData, PathStep, PropertyDef } from "@tybo/core";
import { analysisMarkdown } from "./analysis-export.js";
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
	reference: { typeIds, multiple: true, arrow: "to" as const, lineLabel: "", inverseLabel: "" },
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

test("an analysis as Markdown: its groups as headings, a section per row with its content, columns and description, then the entities the columns name", () => {
	setLanguage("de");
	try {
		const row = `### Aktivität „Rechnung prüfen“

Gegen die Bestellung prüfen.
\\# Notiz

- Benötigt: Artefakt „Rechnung“, Artefakt „Rechnung (2)“
- Status: offen

offen, mit Artefakt „Rechnung“, Artefakt „Rechnung (2)“
\\# Schritte`;
		assert.equal(
			analysisMarkdown(data, analysis({ groups: [step("responsible")], columns: [step("needs"), step("status")] }), "2026-10-21"),
			`# Prüfung (Stand 2026-10-21)

## Buchhaltung

${row}

## Einkauf

${row}

## Ohne Verantwortlicher

### Aktivität „Zahlung anweisen“

- Benötigt: —
- Status: —

---

## In den Spalten genannt

### Artefakt „Rechnung“

Als PDF.

Die Rechnung.

### Artefakt „Rechnung (2)“
`,
		);
	} finally {
		setLanguage("en");
	}
});

test("without grouping the rows are sections of their own; without columns naming entities there is no list of them", () => {
	setLanguage("en");
	assert.equal(
		analysisMarkdown(data, analysis({ columns: [step("status")] }), "2026-10-21"),
		`# Prüfung (as of 2026-10-21)

## Aktivität "Rechnung prüfen"

Gegen die Bestellung prüfen.
\\# Notiz

- Status: offen

offen, mit Artefakt "Rechnung", Artefakt "Rechnung (2)"
\\# Schritte

## Aktivität "Zahlung anweisen"

- Status: —
`,
	);
});

test("deeply nested groups don't go below the sixth heading level; an analysis without a type is only its title", () => {
	const deep = analysisMarkdown(data, analysis({ groups: Array.from({ length: 5 }, () => step("responsible")) }), "2026-10-21");
	assert.match(deep, /^###### Buchhaltung$/m);
	assert.match(deep, /^###### Aktivität "Rechnung prüfen"$/m);
	assert.doesNotMatch(deep, /#######/);
	assert.equal(analysisMarkdown(data, analysis({ typeId: null }), "2026-10-21"), "# Prüfung (as of 2026-10-21)\n");
});
