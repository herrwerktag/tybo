import type { AppData, Rect } from "../../../shared/core/index.js";
import { el, svgEl } from "../../../shared/ui/index.js";
import { effectiveCardDisplay, referencedIds, type LineArrow } from "../../data/core.js";
import { connector, nearest, type Board } from "../core.js";

/** The connector lines' color (as in the stylesheet), for a gradient's end at a card whose type has no color. */
const LINE_COLOR = "#8a8a8a";
/** Canvases made so far (see gradientPrefix). */
let canvasCount = 0;

/** One drawn reference: from a card to the nearest of the target entity's cards. */
export interface Link {
	fromCardId: string;
	targetCardIds: string[];
	label: string;
	/** The source's and the target's type colors. */
	fromColor: string;
	color: string;
	arrow: LineArrow;
}

/** The lines the board shows: one per reference shown as a line (see `effectiveCardDisplay`) from a card to an
 * entity with another card on the board. */
export function boardLinks(data: Pick<AppData, "entities" | "types">, board: Board): Link[] {
	const entities = new Map(data.entities.map((e) => [e.id, e]));
	const types = new Map(data.types.map((t) => [t.id, t]));
	return board.cards.flatMap((card) => {
		const entity = entities.get(card.entityId);
		const type = entity && types.get(entity.typeId);
		if (!entity || !type) return [];
		return type.properties.flatMap((prop) => {
			if (effectiveCardDisplay(prop) !== "line") return [];
			return referencedIds(prop, entity.values[prop.id]).flatMap((id) => {
				const targetCardIds = board.cards.filter((c) => c.entityId === id && c.id !== card.id).map((c) => c.id);
				if (targetCardIds.length === 0) return [];
				return [
					{
						fromCardId: card.id,
						targetCardIds,
						label: prop.reference?.lineLabel || prop.name,
						fromColor: type.color,
						color: types.get(entities.get(id)?.typeId ?? "")?.color ?? "",
						arrow: prop.reference?.arrow ?? "to",
					},
				];
			});
		});
	});
}

/** The cards linked by `edges` (see connectorLines' draw) to this one, either way and through others, with it. */
export function chainOf(cardId: string, edges: readonly (readonly [string, string])[]): Set<string> {
	const chain = new Set([cardId]);
	for (const id of chain) {
		for (const [from, to] of edges) {
			if (from === id) chain.add(to);
			if (to === id) chain.add(from);
		}
	}
	return chain;
}

/** The lines between the cards on a canvas: an SVG under the cards, and their labels (property names) at the lines'
 * midpoints, above the lines and below the cards. */
export function connectorLines() {
	const element = svgEl("svg", { class: "connectors", "aria-hidden": "true" });
	const labels = el("div", { className: "connector-labels", ariaHidden: "true" });
	/** Makes the lines' gradient ids unique in the document, should it show more than one canvas. */
	const gradientPrefix = `connector-gradient-${++canvasCount}`;

	/** Draws the lines of `links` between the cards where they are now (`cardRects`); answers them as the cards they link. */
		function draw(links: readonly Link[], cardRects: ReadonlyMap<string, Rect>): [string, string][] {
		const lines: SVGElement[] = [];
		const gradients: SVGElement[] = [];
		const tags: HTMLElement[] = [];
		const edges: [string, string][] = [];
		for (const { fromCardId, targetCardIds, label, fromColor, color, arrow } of links) {
			const from = cardRects.get(fromCardId);
			const to = from && nearest(from, targetCardIds.flatMap((id) => cardRects.get(id) ?? []));
			if (!from || !to) continue;
			const toCardId = targetCardIds.find((id) => cardRects.get(id) === to)!;
			edges.push([fromCardId, toCardId]);
			// "from" draws the same curve the other way round, so the arrowhead lands on this card.
			const shape = arrow === "from" ? connector(to, from) : connector(from, to, arrow === "to");
			const { path, mid, start, end } = shape;
			// The selected card's own lines are drawn in a gradient along the curve, from the start card's color to
			// the end card's (see .connector.direct).
			const gradientId = `${gradientPrefix}-${gradients.length}`;
			const [startColor, endColor] = arrow === "from" ? [color, fromColor] : [fromColor, color];
			gradients.push(
				svgEl(
					"linearGradient",
					{ id: gradientId, gradientUnits: "userSpaceOnUse", x1: start.x, y1: start.y, x2: end.x, y2: end.y },
					svgEl("stop", { offset: 0, "stop-color": startColor || LINE_COLOR }),
					svgEl("stop", { offset: 1, "stop-color": endColor || LINE_COLOR }),
				),
			);
			lines.push(
				svgEl(
					"g",
					{
						class: "connector",
						"data-from": fromCardId,
						"data-to": toCardId,
						style: `--line-gradient: url(#${gradientId})`,
					},
					svgEl("path", { class: "connector-line", d: path }),
					...(shape.arrow
						? [svgEl("polygon", { class: "connector-arrow", points: shape.arrow, fill: color || "currentColor" })]
						: []),
				),
			);
			const tag = el("span", { className: "connector-label" }, label);
			Object.assign(tag.style, { left: `${mid.x}px`, top: `${mid.y}px` });
			Object.assign(tag.dataset, { from: fromCardId, to: toCardId });
			tags.push(tag);
		}
		element.replaceChildren(svgEl("defs", {}, ...gradients), ...lines);
		labels.replaceChildren(...tags);
		return edges;
	}

	return { element, labels, draw };
}
