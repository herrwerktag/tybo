import type { Store } from "../../../features.core.js";
import { isRecord, type UnitDescriber } from "../../../shared/ui/index.js";
import { boardContext } from "../../boards/ui.js";
import { text as boardText } from "../../boards/texts.js";
import { text as dataText } from "../../data/texts.js";
import { text } from "../texts.js";

/** How the history tells of a drawing: by its kind, on its board, with its text, color, place and size. */
export const DRAWING_HISTORY: UnitDescriber<Store> = {
	kind: "drawing",
	noun: text.historyDrawings,
	read(value, store, boardId) {
		if (!isRecord(value) || typeof value.kind !== "string") return null;
		const kind = value.kind === "image" ? text.historyImage : (text.tools[value.kind as "textbox" | "area"] ?? value.kind);
		const context = boardContext(store, boardId);
		return {
			name: kind,
			...(context ? { context } : {}),
			fields: [
				...(typeof value.text === "string" ? [{ label: text.historyText, text: value.text, long: true }] : []),
				...(typeof value.color === "string" ? [{ label: dataText.color, text: dataText.colorNames[value.color] ?? value.color }] : []),
				{ label: boardText.historyPosition, text: `${Math.round(Number(value.x))}, ${Math.round(Number(value.y))}` },
				{ label: boardText.historySize, text: `${Math.round(Number(value.width))} × ${Math.round(Number(value.height))}` },
			],
		};
	},
	changeVerb: (before, after) =>
		isRecord(before) && isRecord(after) && (before.x !== after.x || before.y !== after.y) && before.text === after.text ? boardText.historyMoved : undefined,
};
