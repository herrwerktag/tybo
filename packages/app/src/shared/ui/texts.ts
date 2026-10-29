import { messages } from "./i18n.js";

/** Messages of the shell and the controls in shared/ui, which several features use. */
const en = {
	changedElsewhere:
		"This workspace was changed somewhere else in the meantime (another tab, another device). Reload the page to see the newer data.",
	createFailed: "The workspace couldn't be created: the server didn't answer.",
	defaultWorkspaceName: (n: number) => `Workspace ${n}`,
	deleteWorkspace: "Delete workspace",
	errorScreenHint:
		"This page couldn't be shown. Changes saved so far are kept. Reload the page, or first export this workspace to keep a copy.",
	errorScreenTitle: "Something went wrong",
	exportWorkspace: "Download this workspace as a JSON file",
	importButton: "Import…",
	importFailed: "The workspace couldn't be imported: the file is from a newer version of the app, or the server didn't answer.",
	importInvalid: "This file isn't an exported workspace.",
	importWorkspace: "Add a workspace from an exported JSON file",
	language: "Language",
	lastWorkspace: "The last workspace can't be deleted",
	loadNewerVersion:
		"This workspace was saved by a newer version of the app. Changes here aren't saved, so nothing of it gets lost. Reload the page to get the newer version.",
	loadUnavailable:
		"This workspace's data couldn't be loaded — the server didn't answer, or the workspace was deleted elsewhere. Changes here aren't saved. Reload the page to try again.",
	moveWorkspace: (name: string) => `Move workspace ${name}; use the arrow keys`,
	newWorkspace: "New workspace",
	redo: "Redo",
	reload: "Reload",
	renameButton: "Rename",
	renameWorkspace: "Rename workspace",
	saveConflict:
		"This workspace was changed somewhere else in the meantime, at the same places as here. Your change was saved over it; further changes here aren't saved until you reload the page to get the newer data.",
	saveFailed: "Changes can't be saved: the server doesn't answer. They're kept only until this tab is closed; the next change that gets through saves them too.",
	serverUnreachableHint:
		"The data is kept on the server, and it doesn't answer right now — so nothing can be shown or saved. Check that the API is running, then reload the page.",
	serverUnreachableTitle: "The server can't be reached",
	settings: "Settings",
	theme: "Theme",
	themeDark: "Dark",
	themeLight: "Light",
	themeSystem: "System",
	undo: "Undo",
	unexpectedError: (message: string) =>
		`Something went wrong: ${message}. Changes saved so far are kept; reloading the page may help.`,
	workspaceMenuLabel: (name: string) => `Workspace: ${name}`,
	workspaces: "Workspaces",
	create: "Create",
	delete: "Delete",
	exportButton: "Export",
	name: "Name",
	resizePanel: "Drag to change the width; double-click to reset",
	filterByTag: "Filter by tag",
	allTags: "All tags",
	dragToReorder: "Drag to reorder, or use the arrow keys",
};

export const text = messages<typeof en>({
	en,
	de: {
		changedElsewhere:
			"Dieser Arbeitsbereich wurde zwischenzeitlich woanders geändert (anderer Tab, anderes Gerät). Lade die Seite neu, um den neueren Stand zu sehen.",
		createFailed: "Der Arbeitsbereich konnte nicht angelegt werden: Der Server hat nicht geantwortet.",
		defaultWorkspaceName: (n) => `Arbeitsbereich ${n}`,
		deleteWorkspace: "Arbeitsbereich löschen",
		errorScreenHint:
			"Diese Seite konnte nicht angezeigt werden. Bisher gespeicherte Änderungen bleiben erhalten. Lade die Seite neu oder exportiere vorher diesen Arbeitsbereich, um eine Kopie zu behalten.",
		errorScreenTitle: "Etwas ist schiefgelaufen",
		exportWorkspace: "Diesen Arbeitsbereich als JSON-Datei herunterladen",
		importButton: "Importieren…",
		importFailed: "Der Arbeitsbereich konnte nicht importiert werden: Die Datei stammt aus einer neueren Version der App, oder der Server hat nicht geantwortet.",
		importInvalid: "Diese Datei ist kein exportierter Arbeitsbereich.",
		importWorkspace: "Einen Arbeitsbereich aus einer exportierten JSON-Datei hinzufügen",
		language: "Sprache",
		lastWorkspace: "Der letzte Arbeitsbereich kann nicht gelöscht werden",
		loadNewerVersion:
			"Dieser Arbeitsbereich wurde mit einer neueren Version der App gespeichert. Änderungen hier werden nicht gespeichert, damit davon nichts verloren geht. Lade die Seite neu, um die neuere Version zu bekommen.",
		loadUnavailable:
			"Die Daten dieses Arbeitsbereichs konnten nicht geladen werden – der Server hat nicht geantwortet, oder der Arbeitsbereich wurde woanders gelöscht. Änderungen hier werden nicht gespeichert. Lade die Seite neu, um es noch einmal zu versuchen.",
		moveWorkspace: (name) => `Arbeitsbereich ${name} verschieben; Pfeiltasten verwenden`,
		newWorkspace: "Neuer Arbeitsbereich",
		redo: "Wiederholen",
		reload: "Neu laden",
		renameButton: "Umbenennen",
		renameWorkspace: "Arbeitsbereich umbenennen",
		saveConflict:
			"Dieser Arbeitsbereich wurde zwischenzeitlich woanders an denselben Stellen geändert. Deine Änderung wurde darüber gespeichert; weitere Änderungen hier werden erst nach einem Neuladen der Seite wieder gespeichert.",
		saveFailed: "Änderungen können nicht gespeichert werden: Der Server antwortet nicht. Sie bleiben nur erhalten, bis dieser Tab geschlossen wird; die nächste Änderung, die durchkommt, speichert sie mit.",
		serverUnreachableHint:
			"Die Daten liegen auf dem Server, und der antwortet gerade nicht – daher kann nichts angezeigt oder gespeichert werden. Prüfe, ob die API läuft, und lade die Seite dann neu.",
		serverUnreachableTitle: "Der Server ist nicht erreichbar",
		settings: "Einstellungen",
		theme: "Darstellung",
		themeDark: "Dunkel",
		themeLight: "Hell",
		themeSystem: "Wie das System",
		undo: "Rückgängig",
		unexpectedError: (message) =>
			`Etwas ist schiefgelaufen: ${message}. Bisher gespeicherte Änderungen bleiben erhalten; ein Neuladen der Seite kann helfen.`,
		workspaceMenuLabel: (name) => `Arbeitsbereich: ${name}`,
		workspaces: "Arbeitsbereiche",
		create: "Erstellen",
		delete: "Löschen",
		exportButton: "Exportieren",
		name: "Name",
		resizePanel: "Ziehen ändert die Breite, Doppelklick setzt sie zurück",
		filterByTag: "Nach Tag filtern",
		allTags: "Alle Tags",
		dragToReorder: "Ziehen zum Umsortieren, oder die Pfeiltasten verwenden",
	},
});
