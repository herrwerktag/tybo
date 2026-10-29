import type { Tool } from "./drawings.js";
import type { TextSize } from "../core/index.js";
import { messages } from "../../shared/ui/index.js";

export { LANGUAGES, language, setLanguage, type Language } from "../../shared/ui/index.js";

const en = {
	// Navigation and settings
	tabBoards: "Boards",
	exportButton: "Export",
	exportTextButton: "Export as text",
	exportText: "Download this workspace as a text file",
	textExportTitle: (name: string, date: string) => `${name}: data model and data (as of ${date})`,
	textExportIntro:
		"This document is an extract of a data model and its data: first the entity types with their properties, then one section per entity with its data. A reference names the other entity by its type and name, e.g. Role \"Accounting\"; that entity's section has the same heading. References are listed on both sides. A property that isn't listed has no value.",
	textExportTypes: "Entity types",
	textExportEntity: (type: string, name: string) => `${type} "${name}"`,
	textExportReferencedVia: (property: string) => `Referenced by (via "${property}")`,

	// Problems with the saved data

	// Unexpected errors

	// Common actions
	close: "Close",

	// Entity types

	// Property cards in the type form
	moveBoard: (name: string) => `Move board ${name}; use the arrow keys`,

	// Entities
	details: "Details",

	// Canvas
	showEntities: "Show entities and drawings",
	hideEntities: "Hide entities and drawings",
	moreControls: "More controls",
	dragOntoCanvas: "Drag onto the canvas.",
	noEntitiesYet: "No entities yet. Create some in the Data view.",
	onCanvas: (count: number) => (count > 1 ? `On canvas ×${count}` : "On canvas"),
	searchEntities: "Search titles…",
	filterByType: "Filter by type",
	allTypes: "All types",
	newEntityButton: "+ Entity",
	newEntityHint: "Create an entity of any type, with its card on this board",
	newEntityTitle: "New entity",
	connect: "Connect",
	connectHint: "Link this entity with another one, existing or new",
	connectNamed: (name: string) => `Connect "${name}"`,
	relation: "Relation",
	relationForward: (property: string, type: string) => `${property} → ${type}`,
	relationInverse: (label: string, type: string) => `${label} → ${type}`,
	relationInverseUnnamed: (type: string, property: string) => `← ${type} (${property})`,
	existingEntity: (type: string) => `Existing ${type}`,
	noRelations: "No reference leads from or to this entity that could take one more",
	noCandidates: "No entities left to link this way.",
	noMatches: "No matching entities.",
	newBoard: "New board",
	changeBoard: "Change board",
	noBoardsYet: "There's no board yet.",
	createFirstBoard: "Create first board",
	defaultBoardName: (n: number) => `Board ${n}`,
	renameBoard: "Rename board",
	deleteBoard: "Delete board",
	confirmDeleteBoard: (name: string, cards: number) =>
		`Delete board "${name}" and its ${cards} cards? The entities stay.`,
	removeFromCanvas: "Remove from canvas",
	removeNamedFromCanvas: (name: string) => `Remove ${name} from canvas`,
	resize: "Resize",
	zoomOut: "Zoom out",
	zoomIn: "Zoom in",
	resetView: "Reset view",
	exportView: "Download this board as an HTML file that shows it like here, without the server",
	exportBoard: "Export this board",
	exportViewButton: "As HTML file",
	exportDrawioButton: "For draw.io",
	exportDrawio: "Download this board's cards and lines as a draw.io file; with groups, as a ZIP with one more file per group",
	groupFallbackName: "Group",

	// View frame
	boardFrame: "Board frame",
	frameHandle: "Drag to move the frame, click to look at it",
	editFrames: "Edit frame",
	doneEditingFrames: "Done with frame",
	editFramesHint: "Show the board's frame, the part the View tab shows, to move, resize and set it",
	frameFromView: "Use this view",
	frameFromViewHint: "Set the board's frame to what you see now",

	// Drawing tools
	drawingTools: "Drawing tools",
	showDrawingTools: "Show all drawing tools",
	hideDrawingTools: "Fold the drawing tools",
	drawingStyle: "Drawing style",
	tools: {
		select: "Select",
		textbox: "Textbox",
		area: "Group",
	} satisfies Record<Tool, string>,
	textSize: "Text size",
	textSizes: { s: "small", m: "medium", l: "large" } satisfies Record<TextSize, string>,
	deleteDrawing: "Delete drawing",


};

export type Messages = typeof en;

/** Typed against the English messages, so a missing or extra key is a type error. */
const de: Messages = {
	tabBoards: "Boards",
	exportButton: "Exportieren",
	exportTextButton: "Als Text exportieren",
	exportText: "Diesen Arbeitsbereich als Text-Datei herunterladen",
	textExportTitle: (name, date) => `${name}: Datenmodell und Daten (Stand ${date})`,
	textExportIntro:
		"Dieses Dokument ist ein Abzug aus einem Datenmodell und seinen Daten: zuerst die Entitätstypen mit ihren Eigenschaften, dann ein Abschnitt pro Entität mit ihren Daten. Eine Referenz nennt die andere Entität mit Typ und Name, z. B. Rolle „Buchhaltung“; ihr Abschnitt hat dieselbe Überschrift. Referenzen stehen auf beiden Seiten. Fehlt eine Eigenschaft, hat sie keinen Wert.",
	textExportTypes: "Entitätstypen",
	textExportEntity: (type, name) => `${type} „${name}“`,
	textExportReferencedVia: (property) => `Referenziert von (über „${property}“)`,



	close: "Schließen",


	moveBoard: (name) => `Board ${name} verschieben; Pfeiltasten verwenden`,

	details: "Details",

	showEntities: "Entitäten und Zeichnungen einblenden",
	hideEntities: "Entitäten und Zeichnungen ausblenden",
	moreControls: "Weitere Bedienelemente",
	dragOntoCanvas: "Auf den Canvas ziehen.",
	noEntitiesYet: "Noch keine Entitäten. Lege welche in der Datenansicht an.",
	onCanvas: (count) => (count > 1 ? `${count}× auf dem Canvas` : "Auf dem Canvas"),
	searchEntities: "Titel suchen…",
	filterByType: "Nach Typ filtern",
	allTypes: "Alle Typen",
	newEntityButton: "+ Entität",
	newEntityHint: "Eine Entität beliebigen Typs anlegen, mit ihrer Karte auf diesem Board",
	newEntityTitle: "Neue Entität",
	connect: "Verbinden",
	connectHint: "Diese Entität mit einer anderen verknüpfen, vorhandenen oder neuen",
	connectNamed: (name) => `„${name}“ verbinden`,
	relation: "Beziehung",
	relationForward: (property, type) => `${property} → ${type}`,
	relationInverse: (label, type) => `${label} → ${type}`,
	relationInverseUnnamed: (type, property) => `← ${type} (${property})`,
	existingEntity: (type) => `Vorhanden: ${type}`,
	noRelations: "Kein Verweis führt von oder zu dieser Entität, der noch eine aufnehmen kann",
	noCandidates: "Keine Entitäten mehr, die sich so verknüpfen lassen.",
	noMatches: "Keine passenden Entitäten.",
	newBoard: "Neues Board",
	changeBoard: "Board wechseln",
	noBoardsYet: "Es gibt noch kein Board.",
	createFirstBoard: "Erstes Board anlegen",
	defaultBoardName: (n) => `Board ${n}`,
	renameBoard: "Board umbenennen",
	deleteBoard: "Board löschen",
	confirmDeleteBoard: (name, cards) => `Board „${name}“ und seine ${cards} Karten löschen? Die Entitäten bleiben erhalten.`,
	removeFromCanvas: "Vom Canvas entfernen",
	removeNamedFromCanvas: (name) => `${name} vom Canvas entfernen`,
	resize: "Größe ändern",
	zoomOut: "Verkleinern",
	zoomIn: "Vergrößern",
	resetView: "Ansicht zurücksetzen",
	exportView: "Dieses Board als HTML-Datei herunterladen, die es wie hier zeigt, ohne Server",
	exportBoard: "Dieses Board exportieren",
	exportViewButton: "Als HTML-Datei",
	exportDrawioButton: "Für draw.io",
	exportDrawio: "Karten und Linien dieses Boards als draw.io-Datei herunterladen; mit Gruppen als ZIP mit je einer weiteren Datei pro Gruppe",
	groupFallbackName: "Gruppe",

	boardFrame: "Board-Ausschnitt",
	frameHandle: "Ziehen verschiebt den Ausschnitt, Klicken zeigt ihn",
	editFrames: "Ausschnitt bearbeiten",
	doneEditingFrames: "Ausschnitt fertig",
	editFramesHint: "Den Ausschnitt des Boards zeigen, den die Ansicht zeigt, um ihn zu verschieben, in der Größe zu ändern und zu setzen",
	frameFromView: "Ansicht übernehmen",
	frameFromViewHint: "Den Ausschnitt des Boards auf den sichtbaren Bereich setzen",

	drawingTools: "Zeichenwerkzeuge",
	showDrawingTools: "Alle Zeichenwerkzeuge zeigen",
	hideDrawingTools: "Zeichenwerkzeuge einklappen",
	drawingStyle: "Zeichenstil",
	tools: {
		select: "Auswählen",
		textbox: "Textbox",
		area: "Gruppe",
	},
	textSize: "Textgröße",
	textSizes: { s: "klein", m: "mittel", l: "groß" },
	deleteDrawing: "Zeichnung löschen",


};

/** The current language's messages; setLanguage (@tybo/app/ui) swaps them. */
export const text = messages<Messages>({ en, de });
