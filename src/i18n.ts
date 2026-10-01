import type { CardDisplay, LineArrow, PropertyKind, ValidationError } from "./model.js";
import { readPreference, writePreference } from "./preferences.js";

export type Language = "en" | "de";

/** Each language is listed by its own name, so it's recognizable whatever the current language. */
export const LANGUAGES: readonly { code: Language; name: string }[] = [
	{ code: "en", name: "English" },
	{ code: "de", name: "Deutsch" },
];

const en = {
	// Navigation and settings
	tabData: "Data",
	tabCanvas: "Canvas",
	tabViewer: "Viewer",
	settings: "Settings",
	language: "Language",
	workspaces: "Workspaces",
	workspaceMenuLabel: (name: string) => `Workspace: ${name}`,
	defaultWorkspaceName: (n: number) => `Workspace ${n}`,
	newWorkspace: "New workspace",
	copyTypesFrom: (name: string) => `Copy entity types from ${name}`,
	renameWorkspace: "Rename workspace",
	deleteWorkspace: "Delete workspace",
	lastWorkspace: "The last workspace can't be deleted",
	confirmDeleteWorkspace: (name: string, types: number, entities: number, boards: number) =>
		`Delete workspace "${name}" with ${types} entity types, ${entities} entities and ${boards} boards? This can't be undone.`,

	// Common actions
	save: "Save",
	cancel: "Cancel",
	edit: "Edit",
	delete: "Delete",
	create: "Create",
	editNamed: (name: string) => `Edit ${name}`,

	// Entity types
	entityTypes: "Entity types",
	noTypesYet: "No types yet.",
	newType: "New type",
	typeName: "Type name",
	typeNamePlaceholder: "e.g. Book",
	color: "Color",
	colorNames: {
		Red: "Red",
		Orange: "Orange",
		Yellow: "Yellow",
		Green: "Green",
		Teal: "Teal",
		Blue: "Blue",
		Violet: "Violet",
		Pink: "Pink",
		Gray: "Gray",
	} as Record<string, string>,
	properties: "Properties",
	builtinId: " · ULID, automatic",
	builtinName: " · text, required",
	builtinContent: " · multiline",
	contentTemplate: "Default text (template)",
	addProperty: "Add property",
	createType: "Create type",
	noProperties: "no properties",
	kinds: { text: "text", options: "options", reference: "reference" } satisfies Record<PropertyKind, string>,
	multipleSuffix: "(multiple)",
	confirmChangedValues: (count: number) => `This changes or clears ${count} existing values. Continue?`,
	cannotDeleteType: (name: string, usedBy: string) =>
		`Can't delete ${name}: used by ${usedBy}. Remove or change those properties first.`,
	confirmDeleteType: (name: string, count: number) => `Delete type "${name}" and its ${count} entities?`,

	// Property cards in the type form
	dragToReorder: "Drag to reorder, or use the arrow keys",
	moveProperty: (label: string) => `Move property ${label}; use the arrow keys`,
	propertyName: "Property name",
	removeProperty: "Remove property",
	removePropertyNamed: (label: string) => `Remove property ${label}`,
	settingType: "Type",
	settingOnCard: "On card",
	onCardHint: "How this property appears on canvas cards",
	cardDisplays: { list: "List", line: "Line", hidden: "Hidden" } satisfies Record<CardDisplay, string>,
	optionsOnePerLine: "Options (one per line)",
	references: "References",
	noTypesOption: "(no types yet)",
	allowMultiple: "Allow multiple",
	arrow: "Arrow",
	arrows: { to: "To target", from: "From target", none: "None" } satisfies Record<LineArrow, string>,
	lineLabel: "Line label",
	shownOnTargetAs: "Shown on target as",
	setOn: (typeName: string, propertyName: string) => `Set on ${typeName} → ${propertyName}`,
	shownOnTargetAsPlaceholder: "e.g. responsible for (optional)",
	shownOnTargetAsHint: "Lists the entities that reference it on the target's cards, form and table. Leave empty to not show it.",
	lineLabelPlaceholder: "property name",
	validation: (error: ValidationError): string => {
		switch (error.code) {
			case "typeNameRequired":
				return "Type name is required.";
			case "propertyNameRequired":
				return "Property names are required.";
			case "reservedName":
				return `"${error.label}" is a built-in field and can't be used as a property name.`;
			case "duplicateName":
				return `Duplicate property name "${error.label}".`;
			case "optionsRequired":
				return `"${error.label}" needs at least one option.`;
			case "emptyOption":
				return `"${error.label}" has an empty option.`;
			case "duplicateOptions":
				return `"${error.label}" has duplicate options.`;
			case "referenceTypeRequired":
				return `"${error.label}" needs an entity type to reference.`;
		}
	},

	// Entities
	entities: "Entities",
	entityType: "Entity type",
	createTypeFirst: "Create an entity type first.",
	noEntitiesOfType: (type: string) => `No ${type} entities yet.`,
	newEntity: (type: string) => `New ${type}`,
	id: "ID",
	name: "Name",
	content: "Content",
	confirmDeleteEntity: (name: string, references: number) =>
		`Delete "${name}"?` +
		(references > 0 ? ` It's referenced ${references} times; those references will be removed.` : ""),

	// Canvas
	showEntities: "Show entities",
	hideEntities: "Hide entities",
	dragOntoCanvas: "Drag onto the canvas.",
	noEntitiesYet: "No entities yet. Create some in the Data view.",
	onCanvas: (count: number) => (count > 1 ? `On canvas ×${count}` : "On canvas"),
	searchEntities: "Search titles…",
	filterByType: "Filter by type",
	allTypes: "All types",
	noMatches: "No matching entities.",
	board: "Board",
	newBoard: "New board",
	newBoardButton: "New",
	newBoardPrompt: "Name of the new board",
	defaultBoardName: (n: number) => `Board ${n}`,
	renameBoard: "Rename board",
	renameButton: "Rename",
	deleteBoard: "Delete board",
	lastBoard: "The last board can't be deleted",
	confirmDeleteBoard: (name: string, cards: number) =>
		`Delete board "${name}" and its ${cards} cards? The entities stay.`,
	removeFromCanvas: "Remove from canvas",
	removeNamedFromCanvas: (name: string) => `Remove ${name} from canvas`,
	noContent: "No content",
	resize: "Resize",
	zoomOut: "Zoom out",
	zoomIn: "Zoom in",
	resetView: "Reset view",
};

export type Messages = typeof en;

/** Typed against the English messages, so a missing or extra key is a type error. */
const de: Messages = {
	tabData: "Daten",
	tabCanvas: "Canvas",
	tabViewer: "Betrachter",
	settings: "Einstellungen",
	language: "Sprache",
	workspaces: "Arbeitsbereiche",
	workspaceMenuLabel: (name) => `Arbeitsbereich: ${name}`,
	defaultWorkspaceName: (n) => `Arbeitsbereich ${n}`,
	newWorkspace: "Neuer Arbeitsbereich",
	copyTypesFrom: (name) => `Entitätstypen aus ${name} übernehmen`,
	renameWorkspace: "Arbeitsbereich umbenennen",
	deleteWorkspace: "Arbeitsbereich löschen",
	lastWorkspace: "Der letzte Arbeitsbereich kann nicht gelöscht werden",
	confirmDeleteWorkspace: (name, types, entities, boards) =>
		`Arbeitsbereich „${name}“ mit ${types} Entitätstypen, ${entities} Entitäten und ${boards} Boards löschen? Das kann nicht rückgängig gemacht werden.`,

	save: "Speichern",
	cancel: "Abbrechen",
	edit: "Bearbeiten",
	delete: "Löschen",
	create: "Erstellen",
	editNamed: (name) => `${name} bearbeiten`,

	entityTypes: "Entitätstypen",
	noTypesYet: "Noch keine Typen.",
	newType: "Neuer Typ",
	typeName: "Typname",
	typeNamePlaceholder: "z. B. Buch",
	color: "Farbe",
	colorNames: {
		Red: "Rot",
		Orange: "Orange",
		Yellow: "Gelb",
		Green: "Grün",
		Teal: "Türkis",
		Blue: "Blau",
		Violet: "Violett",
		Pink: "Rosa",
		Gray: "Grau",
	},
	properties: "Eigenschaften",
	builtinId: " · ULID, automatisch",
	builtinName: " · Text, Pflichtfeld",
	builtinContent: " · mehrzeilig",
	contentTemplate: "Standardtext (Vorlage)",
	addProperty: "Eigenschaft hinzufügen",
	createType: "Typ erstellen",
	noProperties: "keine Eigenschaften",
	kinds: { text: "Text", options: "Auswahl", reference: "Referenz" },
	multipleSuffix: "(mehrfach)",
	confirmChangedValues: (count) => `Dadurch werden ${count} vorhandene Werte geändert oder geleert. Fortfahren?`,
	cannotDeleteType: (name, usedBy) =>
		`${name} kann nicht gelöscht werden: wird verwendet von ${usedBy}. Entferne oder ändere zuerst diese Eigenschaften.`,
	confirmDeleteType: (name, count) => `Typ „${name}“ und seine ${count} Entitäten löschen?`,

	dragToReorder: "Ziehen zum Umsortieren, oder die Pfeiltasten verwenden",
	moveProperty: (label) => `Eigenschaft ${label} verschieben; Pfeiltasten verwenden`,
	propertyName: "Name der Eigenschaft",
	removeProperty: "Eigenschaft entfernen",
	removePropertyNamed: (label) => `Eigenschaft ${label} entfernen`,
	settingType: "Art",
	settingOnCard: "Auf der Karte",
	onCardHint: "Wie diese Eigenschaft auf Canvas-Karten erscheint",
	cardDisplays: { list: "Liste", line: "Linie", hidden: "Ausgeblendet" },
	optionsOnePerLine: "Optionen (eine pro Zeile)",
	references: "Verweist auf",
	noTypesOption: "(noch keine Typen)",
	allowMultiple: "Mehrfachauswahl",
	arrow: "Pfeil",
	arrows: { to: "Zum Ziel", from: "Vom Ziel", none: "Keiner" },
	lineLabel: "Linienbeschriftung",
	shownOnTargetAs: "Beim Ziel angezeigt als",
	setOn: (typeName, propertyName) => `Festgelegt bei ${typeName} → ${propertyName}`,
	shownOnTargetAsPlaceholder: "z. B. verantwortlich für (optional)",
	shownOnTargetAsHint:
		"Zeigt beim Ziel – auf Karten, im Formular und in der Tabelle – die Entitäten, die darauf verweisen. Leer lassen, um es nicht anzuzeigen.",
	lineLabelPlaceholder: "Name der Eigenschaft",
	validation: (error) => {
		switch (error.code) {
			case "typeNameRequired":
				return "Der Typname ist erforderlich.";
			case "propertyNameRequired":
				return "Eigenschaften brauchen einen Namen.";
			case "reservedName":
				return `„${error.label}“ ist ein eingebautes Feld und kann nicht als Name einer Eigenschaft verwendet werden.`;
			case "duplicateName":
				return `Der Name „${error.label}“ ist doppelt vergeben.`;
			case "optionsRequired":
				return `„${error.label}“ braucht mindestens eine Option.`;
			case "emptyOption":
				return `„${error.label}“ hat eine leere Option.`;
			case "duplicateOptions":
				return `„${error.label}“ hat doppelte Optionen.`;
			case "referenceTypeRequired":
				return `„${error.label}“ braucht einen Entitätstyp als Ziel.`;
		}
	},

	entities: "Entitäten",
	entityType: "Entitätstyp",
	createTypeFirst: "Lege zuerst einen Entitätstyp an.",
	noEntitiesOfType: (type) => `Noch keine Entitäten vom Typ ${type}.`,
	newEntity: (type) => `Neu: ${type}`,
	id: "ID",
	name: "Name",
	content: "Inhalt",
	confirmDeleteEntity: (name, references) =>
		`„${name}“ löschen?` +
		(references > 0 ? ` Es wird ${references}-mal referenziert; diese Verweise werden entfernt.` : ""),

	showEntities: "Entitäten einblenden",
	hideEntities: "Entitäten ausblenden",
	dragOntoCanvas: "Auf den Canvas ziehen.",
	noEntitiesYet: "Noch keine Entitäten. Lege welche in der Datenansicht an.",
	onCanvas: (count) => (count > 1 ? `${count}× auf dem Canvas` : "Auf dem Canvas"),
	searchEntities: "Titel suchen…",
	filterByType: "Nach Typ filtern",
	allTypes: "Alle Typen",
	noMatches: "Keine passenden Entitäten.",
	board: "Board",
	newBoard: "Neues Board",
	newBoardButton: "Neu",
	newBoardPrompt: "Name des neuen Boards",
	defaultBoardName: (n) => `Board ${n}`,
	renameBoard: "Board umbenennen",
	renameButton: "Umbenennen",
	deleteBoard: "Board löschen",
	lastBoard: "Das letzte Board kann nicht gelöscht werden",
	confirmDeleteBoard: (name, cards) => `Board „${name}“ und seine ${cards} Karten löschen? Die Entitäten bleiben erhalten.`,
	removeFromCanvas: "Vom Canvas entfernen",
	removeNamedFromCanvas: (name) => `${name} vom Canvas entfernen`,
	noContent: "Kein Inhalt",
	resize: "Größe ändern",
	zoomOut: "Verkleinern",
	zoomIn: "Vergrößern",
	resetView: "Ansicht zurücksetzen",
};

const MESSAGES: Record<Language, Messages> = { en, de };
const LANGUAGE_KEY = "ui-language";

function initialLanguage(): Language {
	const saved = readPreference(LANGUAGE_KEY);
	if (saved === "en" || saved === "de") return saved;
	// First visit: follow the browser.
	return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

/** The current UI language and its messages; ES module bindings, so importers always see the current values. */
export let language: Language = initialLanguage();
export let text: Messages = MESSAGES[language];
document.documentElement.lang = language;

export function setLanguage(next: Language): void {
	language = next;
	text = MESSAGES[next];
	document.documentElement.lang = next;
	writePreference(LANGUAGE_KEY, next);
}
