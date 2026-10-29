import { messages } from "../../shared/ui/index.js";

/** The exports' messages: the board as an HTML file or for draw.io, the workspace as text. */
const en = {
	// Text export
	exportTextButton: "Export as text",
	exportText: "Download this workspace as a text file",
	textExportTitle: (name: string, date: string) => `${name}: data model and data (as of ${date})`,
	textExportIntro:
		"This document is an extract of a data model and its data: first the entity types with their properties, then one section per entity with its data. A reference names the other entity by its type and name, e.g. Role \"Accounting\"; that entity's section has the same heading. References are listed on both sides. A property that isn't listed has no value.",
	textExportTypes: "Entity types",
	textExportReferencedVia: (property: string) => `Referenced by (via "${property}")`,

	// Board exports
	exportView: "Download this board as an HTML file that shows it like here, without the server",
	exportViewButton: "As HTML file",
	exportDrawioButton: "For draw.io",
	exportDrawio: "Download this board's cards and lines as a draw.io file; with groups, as a ZIP with one more file per group",
	groupFallbackName: "Group",
};

export const text = messages<typeof en>({
	en,
	de: {
		exportTextButton: "Als Text exportieren",
		exportText: "Diesen Arbeitsbereich als Text-Datei herunterladen",
		textExportTitle: (name, date) => `${name}: Datenmodell und Daten (Stand ${date})`,
		textExportIntro:
			"Dieses Dokument ist ein Abzug aus einem Datenmodell und seinen Daten: zuerst die Entitätstypen mit ihren Eigenschaften, dann ein Abschnitt pro Entität mit ihren Daten. Eine Referenz nennt die andere Entität mit Typ und Name, z. B. Rolle „Buchhaltung“; ihr Abschnitt hat dieselbe Überschrift. Referenzen stehen auf beiden Seiten. Fehlt eine Eigenschaft, hat sie keinen Wert.",
		textExportTypes: "Entitätstypen",
		textExportReferencedVia: (property) => `Referenziert von (über „${property}“)`,

		exportView: "Dieses Board als HTML-Datei herunterladen, die es wie hier zeigt, ohne Server",
		exportViewButton: "Als HTML-Datei",
		exportDrawioButton: "Für draw.io",
		exportDrawio: "Karten und Linien dieses Boards als draw.io-Datei herunterladen; mit Gruppen als ZIP mit je einer weiteren Datei pro Gruppe",
		groupFallbackName: "Gruppe",
	},
});
