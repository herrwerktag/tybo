import "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppData, PropertyDef } from "@tybo/core";
import { setLanguage, text } from "./i18n.js";
import { workspaceText } from "./text-export.js";

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

/** Activities with a responsible role (inverse label), needed artifacts (several, hidden on cards, no inverse label)
 * and a status; two artifacts share a name. */
const data: Pick<AppData, "types" | "entities"> = {
	types: [
		{
			id: "activity",
			name: "Aktivität",
			color: "#c4dafa",
			contentTemplate: "",
			properties: [
				prop("responsible", "Verantwortlicher", reference(["role"], { inverseLabel: "verantwortlich für" })),
				prop("needs", "Benötigt", { ...reference(["artifact"], { multiple: true }), cardDisplay: "hidden" }),
				prop("status", "Status", { kind: "options", options: ["offen", "fertig"] }),
				prop("process", "Prozess"),
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
			{ responsible: "r1", needs: ["x1", "x2"], status: "offen", process: "Rechnungseingang" },
			{ tags: ["Finanzen"], content: "Gegen die Bestellung prüfen.", description: "# Schritte\nBetrag prüfen\n  # Datum prüfen" },
		),
		entity("a2", "activity", "Zahlung anweisen", { responsible: "r1", needs: null, status: null }),
		entity("r1", "role", "Buchhaltung"),
		entity("x1", "artifact", "Rechnung"),
		entity("x2", "artifact", "Rechnung"),
		entity("orphan", "gone", "Ohne Typ"),
	],
};

test("a workspace as text: the types, then one section per entity with references by type and name, both ways", () => {
	setLanguage("de");
	try {
		assert.equal(
			workspaceText("Projekt X", data, "2026-10-16"),
			`# Projekt X: Datenmodell und Daten (Stand 2026-10-16)

${text.textExportIntro}

## Entitätstypen

### Aktivität
- Verantwortlicher: Referenz → Rolle
- Benötigt: Referenz → Artefakt (mehrfach)
- Status: Auswahl (offen, fertig)
- Prozess: Text

### Rolle
- keine Eigenschaften

### Artefakt
- keine Eigenschaften

## Aktivität „Rechnung prüfen“
Tags: Finanzen
Verantwortlicher: Rolle „Buchhaltung“
Benötigt: Artefakt „Rechnung“, Artefakt „Rechnung (2)“
Status: offen
Prozess: Rechnungseingang
Inhalt: Gegen die Bestellung prüfen.
Beschreibung:
  \\# Schritte
  Betrag prüfen
    \\# Datum prüfen

## Aktivität „Zahlung anweisen“
Verantwortlicher: Rolle „Buchhaltung“

## Rolle „Buchhaltung“
verantwortlich für: Aktivität „Rechnung prüfen“, Aktivität „Zahlung anweisen“

## Artefakt „Rechnung“
Referenziert von (über „Benötigt“): Aktivität „Rechnung prüfen“

## Artefakt „Rechnung (2)“
Referenziert von (über „Benötigt“): Aktivität „Rechnung prüfen“
`,
		);
	} finally {
		setLanguage("en");
	}
});

test("references to entities that don't exist anymore are left out", () => {
	setLanguage("en");
	const dangling = { ...data, entities: [entity("a1", "activity", "Prüfen", { responsible: "deleted", needs: ["deleted"] })] };
	const result = workspaceText("W", dangling, "2026-10-16");
	assert.match(result, /## Aktivität "Prüfen"\n*$/);
	assert.doesNotMatch(result, /deleted/);
});

test("{{Property}} in a description is written as the value, references by type and name, empty ones as —", () => {
	setLanguage("de");
	try {
		const description = "{{Verantwortlicher}} prüft {{benötigt}} im {{ Prozess }}; {{Status}}, {{Tippfehler}}";
		const entities = data.entities.map((e) => (e.id === "a1" ? { ...e, description, values: { ...e.values, status: null } } : e));
		assert.match(
			workspaceText("Projekt X", { ...data, entities }, "2026-10-16"),
			/\nBeschreibung: Rolle „Buchhaltung“ prüft Artefakt „Rechnung“, Artefakt „Rechnung \(2\)“ im Rechnungseingang; —, \{\{Tippfehler\}\}\n/,
		);
	} finally {
		setLanguage("en");
	}
});
