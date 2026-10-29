import { messages } from "../../shared/ui/index.js";
import type { TextSize } from "./core.js";
import type { Tool } from "./ui/layer.js";

/** The drawings' messages: their tools and style. */
const en = {
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

export const text = messages<typeof en>({
	en,
	de: {
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
	},
});
