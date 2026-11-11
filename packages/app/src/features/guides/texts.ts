import { messages } from "../../shared/ui/index.js";

/** The guide page's messages. */
const en = {
	tabGuide: "Guide",
	guide: "Guide",
	noGuideYet:
		"This workspace has no guide yet. Describe here how it is worked with: its method, what the entity types are for and how they play together, an example. People and agents read the same text.",
	writeGuide: "Write the guide",
	editGuide: "Edit",
	guideText: "Guide (Markdown)",
	guideHint: "What a single type or property is for goes with the type: Data → Entity types.",
	historyGuides: (count: number): string => (count === 1 ? "guide" : "guides"),
	historyGuideName: "Workspace guide",
	historyGuideText: "Text",
};

export const text = messages<typeof en>({
	en,
	de: {
		tabGuide: "Anleitung",
		guide: "Anleitung",
		noGuideYet:
			"Dieser Arbeitsbereich hat noch keine Anleitung. Beschreibe hier, wie mit ihm gearbeitet wird: die Methode, wofür die Entitätstypen da sind und wie sie zusammenspielen, ein Beispiel. Menschen und Agenten lesen denselben Text.",
		writeGuide: "Anleitung schreiben",
		editGuide: "Bearbeiten",
		guideText: "Anleitung (Markdown)",
		guideHint: "Wofür ein einzelner Typ oder eine Eigenschaft da ist, steht beim Typ: Daten → Entitätstypen.",
		historyGuides: (count) => (count === 1 ? "Anleitung" : "Anleitungen"),
		historyGuideName: "Anleitung des Arbeitsbereichs",
		historyGuideText: "Text",
	},
});
