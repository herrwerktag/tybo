import { messages } from "../../shared/ui/index.js";
import type { CardDisplay, LineArrow, PropertyKind, ValidationError } from "./core.js";

/** The Data tab's messages, and how types and entities are named wherever they show. */
const en = {
	addOption: "Add option",
	addProperty: "Add property",
	addReference: "Add…",
	addReferenceType: "Add type…",
	allowMultiple: "Allow multiple",
	arrow: "Arrow",
	arrows: { to: "To target", from: "From target", none: "None" } satisfies Record<LineArrow, string>,
	builtinTitle: "Every entity has",
	builtinContent: "multiline, on cards",
	builtinDescription: "long text, in the details panel; {{Property}} shows the property's value there",
	builtinId: "set automatically",
	builtinName: "text, required",
	cannotDeleteType: (name: string, usedBy: string) =>
		`Can't delete ${name}: used by ${usedBy}. Remove or change those properties first.`,
	cardDisplays: { list: "List", line: "Line", hidden: "Hidden" } satisfies Record<CardDisplay, string>,
	closeDetails: "Close details",
	details: "Details",
	entityMention: (type: string, name: string) => `${type} "${name}"`,
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
		Dark: "Dark gray",
	} as Record<string, string>,
	confirmChangedValues: (count: number) => `This changes or clears ${count} existing values. Continue?`,
	confirmDeleteEntity: (name: string, references: number) =>
		`Delete "${name}"?` +
		(references > 0 ? ` It's referenced ${references} times; those references will be removed.` : ""),
	confirmDeleteType: (name: string, count: number) => `Delete type "${name}" and its ${count} entities?`,
	convertEntity: "Convert…",
	convertEntityHint: "Change this entity's type and choose which values to carry over",
	conversionNoOtherType: "There is no other type to convert this entity to",
	conversionTitle: (name: string) => `Convert "${name}"`,
	conversionTargetType: "Target type",
	conversionTargetTypePlaceholder: "Choose a type…",
	conversionDoNotTransfer: "Don't carry over",
	conversionTargetFor: (name: string) => `Target property for ${name}`,
	conversionOptionFor: (name: string) => `Target option for ${name}`,
	conversionTargetOptionPlaceholder: "Choose an option…",
	conversionNoTarget: "No compatible target property; this value won't be carried over.",
	conversionNoValues: "This entity has no property values to assign.",
	conversionLostValues: "Values not carried over",
	conversionLostReferences: "Incoming references removed",
	confirmConversion: (values: number, references: number) =>
		`Convert with the listed losses (${values} property values, ${references} incoming references)?`,
	conversionChanged: "The entity or its types changed. Review the new mapping before converting.",
	convert: "Convert",
	close: "Close",
	confirmDeleteWorkspace: (name: string, types: number, entities: number, boards: number) =>
		`Delete workspace "${name}" with ${types} entity types, ${entities} entities and ${boards} boards? This can't be undone.`,
	content: "Content",
	contentTemplate: "Default text (template)",
	copyTypesFrom: (name: string) => `Copy entity types from ${name}`,
	createNewEntity: "Create new entity",
	createNewType: "Create new type",
	createType: "Create type",
	createTypeFirst: "Create an entity type first.",
	description: "Description",
	edit: "Edit",
	editNamed: (name: string) => `Edit ${name}`,
	entities: "Entities",
	entityType: "Entity type",
	entityTypes: "Entity types",
	id: "ID",
	kinds: { text: "text", options: "options", reference: "reference" } satisfies Record<PropertyKind, string>,
	lineLabel: "Line label",
	lineLabelPlaceholder: "property name",
	missingRequired: (names: string) => `Missing: ${names}`,
	missingValue: "missing",
	moveEntity: (name: string) => `Move ${name}; use the arrow keys`,
	moveOption: (label: string) => `Move option ${label}; use the arrow keys`,
	moveProperty: (label: string) => `Move property ${label}; use the arrow keys`,
	moveType: (name: string) => `Move type ${name}; use the arrow keys`,
	multipleSuffix: "(multiple)",
	newEntity: (type: string) => `New ${type}`,
	newType: "New type",
	noDescription: "No description",
	noEntitiesOfType: (type: string) => `No ${type} entities yet.`,
	noEntitiesWithTag: (type: string, tag: string) => `No ${type} entities tagged "${tag}".`,
	noProperties: "no properties",
	noTypesOption: "(no types yet)",
	noTypesYet: "No types yet. A type says which properties its entities have.",
	onCardHint: "How this property appears on canvas cards",
	options: "Options",
	optionName: "Option name",
	properties: "Properties",
	propertyName: "Property name",
	references: "References",
	removeOption: (label: string) => `Remove option ${label}`,
	removeProperty: "Remove property",
	removePropertyNamed: (label: string) => `Remove property ${label}`,
	editField: (label: string) => `Change ${label}`,
	saveField: "Save",
	cancelField: "Cancel",
	showDetails: (name: string) => `Details of ${name}`,
	nameField: "Name",
	nameRequired: "An entity needs a name.",
	copyId: "Copy ID",
	idCopied: "Copied",
	showPropertySettings: (label: string) => `Settings of ${label}`,
	optionCount: (count: number) => (count === 1 ? "1 value" : `${count} values`),
	typeTraits: "Traits",
	removeReference: (name: string) => `Remove ${name}`,
	removeReferenceType: (type: string) => `Remove ${type}`,
	requiredReference: "Required",
	requiredReferenceHint: "Entities without one are still saved, but marked as incomplete",
	requiredSuffix: "(required)",
	setOn: (typeName: string, propertyName: string) => `Set on ${typeName} → ${propertyName}`,
	settingOnCard: "On card",
	settingType: "Type",
	shownOnTargetAs: "Shown on target as",
	shownOnTargetAsHint: "Lists the entities that reference it on the target's cards, form and table. Leave empty to not show it.",
	shownOnTargetAsPlaceholder: "e.g. responsible for (optional)",
	tabEntities: "Data",
	tags: "Tags",
	historyTypes: (count: number): string => (count === 1 ? "type" : "types"),
	historyEntities: (count: number): string => (count === 1 ? "entity" : "entities"),
	historyGone: "(deleted)",
	tagsHint: "Separated by commas",
	typeName: "Type name",
	typeNamePlaceholder: "e.g. Book",
	validation: (error: ValidationError): string => {
		switch (error.code) {
			case "typeNameRequired":
				return "Type name is required.";
			case "typeNameTaken":
				return `There is a type "${error.label}" already.`;
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
	wrapReferences: "Wrap references on cards",
};

export const text = messages<typeof en>({
	en,
	de: {
		addOption: "Option hinzufügen",
		addProperty: "Eigenschaft hinzufügen",
		addReference: "Hinzufügen …",
		addReferenceType: "Typ hinzufügen …",
		allowMultiple: "Mehrfachauswahl",
		arrow: "Pfeil",
		arrows: { to: "Zum Ziel", from: "Vom Ziel", none: "Keiner" },
		builtinTitle: "Jede Entität hat",
		builtinContent: "mehrzeilig, auf Karten",
		builtinDescription: "langer Text, im Detailbereich; {{Eigenschaft}} zeigt dort den Wert der Eigenschaft",
		builtinId: "automatisch vergeben",
		builtinName: "Text, Pflichtfeld",
		cannotDeleteType: (name, usedBy) =>
			`${name} kann nicht gelöscht werden: wird verwendet von ${usedBy}. Entferne oder ändere zuerst diese Eigenschaften.`,
		cardDisplays: { list: "Liste", line: "Linie", hidden: "Ausgeblendet" },
		closeDetails: "Details schließen",
		details: "Details",
		entityMention: (type, name) => `${type} „${name}“`,
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
			Dark: "Dunkelgrau",
		},
		confirmChangedValues: (count) => `Dadurch werden ${count} vorhandene Werte geändert oder geleert. Fortfahren?`,
		confirmDeleteEntity: (name, references) =>
			`„${name}“ löschen?` +
			(references > 0 ? ` Es wird ${references}-mal referenziert; diese Verweise werden entfernt.` : ""),
		confirmDeleteType: (name, count) => `Typ „${name}“ und seine ${count} Entitäten löschen?`,
		convertEntity: "Konvertieren …",
		convertEntityHint: "Typ dieser Entität ändern und auswählen, welche Werte übernommen werden",
		conversionNoOtherType: "Es gibt keinen anderen Typ, in den sich diese Entität konvertieren lässt",
		conversionTitle: (name) => `„${name}“ konvertieren`,
		conversionTargetType: "Zieltyp",
		conversionTargetTypePlaceholder: "Typ wählen …",
		conversionDoNotTransfer: "Nicht übernehmen",
		conversionTargetFor: (name) => `Zieleigenschaft für ${name}`,
		conversionOptionFor: (name) => `Zieloption für ${name}`,
		conversionTargetOptionPlaceholder: "Option wählen …",
		conversionNoTarget: "Keine kompatible Zieleigenschaft; dieser Wert wird nicht übernommen.",
		conversionNoValues: "Diese Entität hat keine Eigenschaftswerte zuzuordnen.",
		conversionLostValues: "Nicht übernommene Werte",
		conversionLostReferences: "Entfernte eingehende Verweise",
		confirmConversion: (values, references) =>
			`Mit den aufgeführten Verlusten konvertieren (${values} Eigenschaftswerte, ${references} eingehende Verweise)?`,
		conversionChanged: "Die Entität oder ihre Typen haben sich geändert. Prüfe die neue Zuordnung vor dem Konvertieren.",
		convert: "Konvertieren",
		close: "Schließen",
		confirmDeleteWorkspace: (name, types, entities, boards) =>
			`Arbeitsbereich „${name}“ mit ${types} Entitätstypen, ${entities} Entitäten und ${boards} Boards löschen? Das kann nicht rückgängig gemacht werden.`,
		content: "Inhalt",
		contentTemplate: "Standardtext (Vorlage)",
		copyTypesFrom: (name) => `Entitätstypen aus ${name} übernehmen`,
		createNewEntity: "Neue Entität anlegen",
		createNewType: "Neuen Typ anlegen",
		createType: "Typ erstellen",
		createTypeFirst: "Lege zuerst einen Entitätstyp an.",
		description: "Beschreibung",
		edit: "Bearbeiten",
		editNamed: (name) => `${name} bearbeiten`,
		entities: "Entitäten",
		entityType: "Entitätstyp",
		entityTypes: "Entitätstypen",
		id: "ID",
		kinds: { text: "Text", options: "Auswahl", reference: "Referenz" },
		lineLabel: "Linienbeschriftung",
		lineLabelPlaceholder: "Name der Eigenschaft",
		missingRequired: (names) => `Fehlt: ${names}`,
		missingValue: "fehlt",
		moveEntity: (name) => `${name} verschieben; Pfeiltasten verwenden`,
		moveOption: (label) => `Option ${label} verschieben; Pfeiltasten verwenden`,
		moveProperty: (label) => `Eigenschaft ${label} verschieben; Pfeiltasten verwenden`,
		moveType: (name) => `Typ ${name} verschieben; Pfeiltasten verwenden`,
		multipleSuffix: "(mehrfach)",
		newEntity: (type) => `Neu: ${type}`,
		newType: "Neuer Typ",
		noDescription: "Keine Beschreibung",
		noEntitiesOfType: (type) => `Noch keine Entitäten vom Typ ${type}.`,
		noEntitiesWithTag: (type, tag) => `Keine Entitäten vom Typ ${type} mit dem Tag „${tag}“.`,
		noProperties: "keine Eigenschaften",
		noTypesOption: "(noch keine Typen)",
		noTypesYet: "Noch keine Typen. Ein Typ legt fest, welche Eigenschaften seine Entitäten haben.",
		onCardHint: "Wie diese Eigenschaft auf Canvas-Karten erscheint",
		options: "Optionen",
		optionName: "Name der Option",
		properties: "Eigenschaften",
		propertyName: "Name der Eigenschaft",
		references: "Verweist auf",
		removeOption: (label) => `Option ${label} entfernen`,
		removeProperty: "Eigenschaft entfernen",
		removePropertyNamed: (label) => `Eigenschaft ${label} entfernen`,
		editField: (label) => `${label} ändern`,
		saveField: "Speichern",
		cancelField: "Abbrechen",
		showDetails: (name) => `Details zu ${name}`,
		nameField: "Name",
		nameRequired: "Eine Entität braucht einen Namen.",
		copyId: "ID kopieren",
		idCopied: "Kopiert",
		showPropertySettings: (label) => `Einstellungen von ${label}`,
		optionCount: (count) => (count === 1 ? "1 Wert" : `${count} Werte`),
		typeTraits: "Traits",
		removeReference: (name) => `${name} entfernen`,
		removeReferenceType: (type) => `${type} entfernen`,
		requiredReference: "Pflichtfeld",
		requiredReferenceHint: "Entitäten ohne Verweis werden trotzdem gespeichert, aber als unvollständig markiert",
		requiredSuffix: "(Pflicht)",
		setOn: (typeName, propertyName) => `Festgelegt bei ${typeName} → ${propertyName}`,
		settingOnCard: "Auf der Karte",
		settingType: "Art",
		shownOnTargetAs: "Beim Ziel angezeigt als",
		shownOnTargetAsHint:
			"Zeigt beim Ziel – auf Karten, im Formular und in der Tabelle – die Entitäten, die darauf verweisen. Leer lassen, um es nicht anzuzeigen.",
		shownOnTargetAsPlaceholder: "z. B. verantwortlich für (optional)",
		tabEntities: "Daten",
		tags: "Tags",
		historyTypes: (count) => (count === 1 ? "Typ" : "Typen"),
		historyEntities: (count) => (count === 1 ? "Entität" : "Entitäten"),
		historyGone: "(gelöscht)",
		tagsHint: "Durch Kommas getrennt",
		typeName: "Typname",
		typeNamePlaceholder: "z. B. Buch",
		validation: (error) => {
			switch (error.code) {
				case "typeNameRequired":
					return "Der Typname ist erforderlich.";
				case "typeNameTaken":
					return `Einen Typ „${error.label}“ gibt es schon.`;
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
		wrapReferences: "Referenzen auf Karten umbrechen",
	},
});
