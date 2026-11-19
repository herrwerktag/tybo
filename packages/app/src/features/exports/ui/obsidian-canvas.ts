import type { AppData } from "../../../shared/core/index.js";
import { effectiveCardDisplay, referencedIds } from "../../data/core.js";
import { facingSides, nearest, type Board, type CanvasCard } from "../../boards/core.js";
import { isArea, isBox } from "../../drawings/core.js";

/**
 * A board as an Obsidian canvas (JSON Canvas, https://jsoncanvas.org): its cards as text nodes embedding the
 * entities' notes (`![[name]]`) at the cards' places and sizes, in their type's color — file nodes would name a note
 * by its path from the vault's top, and the export would only work there; its groups as group nodes, larger ones first so the
 * smaller lie on top; its text boxes as text nodes; the lines of `line` references as edges with their label and
 * arrow, to the nearest card of the referenced entity like on the board. Images are left out. `noteName` is a note's
 * name in the vault; cards of entities without one are left out.
 */
export function boardCanvas(data: Pick<AppData, "types" | "entities">, board: Board, noteName: (entityId: string) => string | undefined): string {
	const types = new Map(data.types.map((t) => [t.id, t]));
	const entities = new Map(data.entities.map((e) => [e.id, e]));
	const cards = board.cards.filter((c) => noteName(c.entityId) !== undefined);
	const boxes = board.drawings.filter(isBox);
	const rect = ({ x, y, width, height }: { x: number; y: number; width: number; height: number }) => ({ x, y, width, height });

	const nodes: object[] = [
		...boxes
			.filter(isArea)
			.sort((a, b) => b.width * b.height - a.width * a.height)
			.map((area) => ({ id: `area-${area.id}`, type: "group", ...rect(area), ...(area.text.trim() ? { label: area.text.trim() } : {}), color: area.color })),
		...boxes.filter((d) => d.kind === "textbox").map((box) => ({ id: `text-${box.id}`, type: "text", ...rect(box), text: box.text, color: box.color })),
		...cards.map((card) => {
			const color = types.get(entities.get(card.entityId)!.typeId)?.color;
			return { id: `card-${card.id}`, type: "text", text: `![[${noteName(card.entityId)!}]]`, ...rect(card), ...(color ? { color } : {}) };
		}),
	];

	const cardsOf = new Map<string, CanvasCard[]>();
	for (const card of cards) cardsOf.set(card.entityId, [...(cardsOf.get(card.entityId) ?? []), card]);
	const edges: object[] = [];
	for (const card of cards) {
		const entity = entities.get(card.entityId)!;
		for (const prop of types.get(entity.typeId)?.properties ?? []) {
			if (effectiveCardDisplay(prop) !== "line") continue;
			for (const id of referencedIds(prop, entity.values[prop.id])) {
				const to = nearest(card, (cardsOf.get(id) ?? []).filter((c) => c.id !== card.id));
				if (!to) continue;
				const arrow = prop.reference?.arrow ?? "to";
				edges.push({
					id: `line-${edges.length + 1}`,
					fromNode: `card-${card.id}`,
					toNode: `card-${to.id}`,
					...facingSides(card, to),
					fromEnd: arrow === "from" ? "arrow" : "none",
					toEnd: arrow === "to" ? "arrow" : "none",
					label: prop.reference?.lineLabel || prop.name,
				});
			}
		}
	}
	return `${JSON.stringify({ nodes, edges }, null, "\t")}\n`;
}
