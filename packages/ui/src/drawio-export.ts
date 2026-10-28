import { uniqueFileNames } from "./dom.js";
import { areaContents } from "./drawings.js";
import { text } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import {
	cardRows,
	effectiveCardDisplay,
	inverseCardRows,
	isArea,
	nearest,
	placeholderProperty,
	referencedIds,
	type AppData,
	type Board,
	type BoxDrawing,
	type CanvasCard,
	type CardRow,
	type Entity,
	type EntityType,
	type LineArrow,
	type Point,
	type Rect,
} from "@tybo/core";

/**
 * A board as a draw.io file: its cards as boxes, where they are on the board, showing what the cards show (type bar,
 * name, properties, content), and the lines of `line` references as edges attached to them, so they stay attached
 * when moved in draw.io. A card's description is its tooltip, as HTML. Groups (areas) are named containers holding the cards
 * lying in them, so they move together in draw.io too. The whole board is in; other drawings are left out.
 */
export function boardDrawio(data: Pick<AppData, "types" | "entities" | "boards">, boardId: string): string {
	const board = findBoard(data, boardId);
	return drawioFile(data, board, board.name, board.cards, board.drawings.filter(isArea), { x: 0, y: 0 });
}

/**
 * The files to export a board as for draw.io: the board's file, and for each group (area) on it one more, of the
 * group with what lies in it, its top left corner at (0, 0). File names end in .drawio and are unique.
 */
export function boardDrawioFiles(data: Pick<AppData, "types" | "entities" | "boards">, boardId: string): { name: string; contents: string }[] {
	const board = findBoard(data, boardId);
	const areas = board.drawings.filter(isArea);
	const cards = exportCards(data, board.cards).map(({ card }) => card);
	let unnamed = 0;
	const files = [
		{ name: board.name, contents: boardDrawio(data, boardId) },
		...areas.map((area) => {
			const name = area.text.replace(/\s+/g, " ").trim() || `${text.groupFallbackName} ${++unnamed}`;
			const { cardIds, drawingIds } = areaContents(area, cards, areas);
			const inside = [area, ...areas.filter((a) => drawingIds.has(a.id))];
			return { name, contents: drawioFile(data, board, name, board.cards.filter((c) => cardIds.has(c.id)), inside, area) };
		}),
	];
	return uniqueFileNames(files, "drawio");
}

function findBoard(data: Pick<AppData, "boards">, boardId: string): Board {
	const board = data.boards.find((b) => b.id === boardId);
	if (!board) throw new Error(`No board ${boardId}`);
	return board;
}

/**
 * The cards (of entities that still exist) as they're exported: with their entity, type and the rows they show, at
 * the size the editor measured. Lines only go to cards among `cards`; references to other cards are listed instead.
 */
function exportCards(data: Pick<AppData, "types" | "entities">, cards: readonly CanvasCard[]) {
	const types = new Map(data.types.map((t) => [t.id, t]));
	const entities = new Map(data.entities.map((e) => [e.id, e]));
	const entityNames = new Map(data.entities.map((e) => [e.id, e.name]));
	const shown = cards.filter((c) => entities.has(c.entityId));
	const cardsByEntity = new Map<string, CanvasCard[]>();
	for (const card of shown) cardsByEntity.set(card.entityId, [...(cardsByEntity.get(card.entityId) ?? []), card]);
	return shown.map((card) => {
		const entity = entities.get(card.entityId)!;
		const type = types.get(entity.typeId);
		// Like on the canvas: other cards of the referenced entity, the line going to the nearest one.
		const targetCards = (entityId: string) => (cardsByEntity.get(entityId) ?? []).filter((c) => c.id !== card.id);
		const isLinked = (entityId: string) => targetCards(entityId).length > 0;
		const rows = [...(type ? cardRows(type, entity, entityNames, isLinked) : []), ...inverseCardRows(data, entity, entityNames, isLinked)];
		return { card, entity, type, rows, targetCards };
	});
}

/** A draw.io file of some of a board's cards and groups, moved so `origin` is at (0, 0). */
function drawioFile(
	data: Pick<AppData, "types" | "entities">,
	board: Board,
	name: string,
	cards: readonly CanvasCard[],
	areas: readonly Area[],
	origin: Point,
): string {
	const types = new Map(data.types.map((t) => [t.id, t]));
	const entities = new Map(data.entities.map((e) => [e.id, e]));
	const entityNames = new Map(data.entities.map((e) => [e.id, e.name]));
	// A card or group goes into the smallest group (larger than itself) its middle lies in; in draw.io, its position
	// is then relative to that group.
	const parentOf = (rect: Rect): Area | undefined =>
		areas
			.filter((a) => a.width * a.height > rect.width * rect.height && contains(a, middle(rect)))
			.sort((a, b) => a.width * a.height - b.width * b.height)[0];
	const geometry = (rect: Rect) => {
		const parent = parentOf(rect);
		const at = parent ?? origin;
		return {
			parent: parent ? areaCellId(parent.id) : "1",
			xml: `<mxGeometry x="${rect.x - at.x}" y="${rect.y - at.y}" width="${rect.width}" height="${rect.height}" as="geometry"/>`,
		};
	};

	// Outer groups first: draw.io wants a container before what's in it.
	const containers = [...areas]
		.sort((a, b) => b.width * b.height - a.width * a.height)
		.map((area) => {
			const { parent, xml } = geometry(area);
			return (
				`<mxCell id="${attr(areaCellId(area.id))}" value="${attr(esc(area.text.trim()))}" style="${areaStyle(area.color)}" ` +
				`vertex="1" parent="${attr(parent)}">${xml}</mxCell>`
			);
		});
	const vertices: string[] = [];
	const edges: string[] = [];
	for (const { card, entity, type, rows, targetCards } of exportCards(data, cards)) {
		const label = cardLabel(entity, type, rows, (id) => types.get(entities.get(id)?.typeId ?? "")?.color ?? "#ebebeb");
		const { parent, xml } = geometry(card);
		vertices.push(
			`<UserObject id="${attr(cellId(card.id))}" label="${attr(label)}" tooltip="${attr(description(entity, type, entityNames))}">` +
				`<mxCell style="${CARD_STYLE}" vertex="1" parent="${attr(parent)}">${xml}</mxCell></UserObject>`,
		);
		for (const prop of type?.properties ?? []) {
			if (effectiveCardDisplay(prop) !== "line") continue;
			for (const id of referencedIds(prop, entity.values[prop.id])) {
				const to = nearest(card, targetCards(id));
				if (!to) continue;
				const label = prop.reference?.lineLabel || prop.name;
				edges.push(
					`<mxCell id="line-${edges.length + 1}" value="${attr(esc(label))}" style="${lineStyle(prop.reference?.arrow ?? "to")}" ` +
						`edge="1" parent="1" source="${attr(cellId(card.id))}" target="${attr(cellId(to.id))}">` +
						`<mxGeometry relative="1" as="geometry"/></mxCell>`,
				);
			}
		}
	}
	return (
		`<mxfile host="tybo"><diagram id="${attr(board.id)}" name="${attr(name)}">` +
		`<mxGraphModel grid="1" gridSize="24" guides="1" connect="1" arrows="1" page="0"><root>` +
		`<mxCell id="0"/><mxCell id="1" parent="0"/>${containers.join("")}${vertices.join("")}${edges.join("")}` +
		`</root></mxGraphModel></diagram></mxfile>\n`
	);
}

type Area = BoxDrawing & { kind: "area" };

const middle = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const contains = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** Like on the canvas: a see-through box in the group's color with a dashed border, its name as a bold title. */
function areaStyle(color: string): string {
	return (
		"rounded=1;absoluteArcSize=1;arcSize=12;html=1;whiteSpace=wrap;container=1;collapsible=0;dashed=1;" +
		`verticalAlign=top;align=left;spacingLeft=8;spacingTop=2;fontStyle=1;fillColor=${color};fillOpacity=35;` +
		"strokeColor=#6b6b6b;fontColor=#4a4a4a;"
	);
}

const CARD_STYLE =
	"rounded=1;absoluteArcSize=1;arcSize=12;html=1;whiteSpace=wrap;overflow=fill;align=left;verticalAlign=top;spacing=0;" +
	"fillColor=#ffffff;strokeColor=#b5b5b5;fontColor=#1f1f1f;";

function lineStyle(arrow: LineArrow): string {
	const head = (on: boolean) => (on ? "block;" : "none;");
	return `html=1;endArrow=${head(arrow === "to")}startArrow=${head(arrow === "from")}endFill=1;startFill=1;strokeColor=#4a4a4a;fontSize=11;labelBackgroundColor=#ffffff;`;
}

/** The card's look as an HTML label, with sizes from the stylesheet (see .canvas-card in app.css). */
function cardLabel(entity: Entity, type: EntityType | undefined, rows: readonly CardRow[], typeColor: (entityId: string) => string): string {
	const bar =
		`<div style="height:23px;line-height:23px;padding:0 12px;border-radius:5px 5px 0 0;background:${type?.color ?? "#f2f2f2"};` +
		`font-size:10px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:rgba(0,0,0,0.65);">${esc(type?.name ?? "")}</div>`;
	const name = `<div style="padding:12px 12px 11px;line-height:24px;font-weight:bold;">${esc(entity.name)}</div>`;
	// Options as grey tags, references as tags in their entity's type color, like on the card.
	const chip = (value: string, color: string) =>
		`<span style="display:inline-block;padding:0 5px;margin:2px 4px 2px 0;border-radius:4px;line-height:20px;font-size:13px;background:${color};">${esc(value)}</span>`;
	const values = (row: CardRow) =>
		row.kind === "text" ? esc(row.values.join(", ")) : row.values.map((v, i) => chip(v, row.kind === "options" ? "#ebebeb" : typeColor(row.entityIds[i]!))).join("");
	const table =
		rows.length === 0
			? ""
			: `<table style="width:100%;border-top:1px solid #e0e0e0;padding:12px 8px;font-size:14px;line-height:24px;">${rows
					.map((row) => `<tr><td style="color:#6b6b6b;white-space:nowrap;vertical-align:top;padding-right:16px;">${esc(row.label)}</td><td>${values(row)}</td></tr>`)
					.join("")}</table>`;
	const content = entity.content.trim()
		? `<div style="border-top:1px solid #e0e0e0;padding:10px 12px;font-size:14px;line-height:1.5;">${esc(entity.content.trim()).replace(/\r?\n/g, "<br>")}</div>`
		: "";
	return `<div style="font-family:system-ui,sans-serif;">${bar}${name}${table}${content}</div>`;
}

/** The description as HTML (draw.io renders it in the tooltip), its {{Property}} placeholders filled in like in the
 * details panel ("—" when empty). */
function description(entity: Entity, type: EntityType | undefined, entityNames: ReadonlyMap<string, string>): string {
	if (!entity.description.trim()) return "";
	return renderMarkdown(entity.description, (name) => {
		const prop = placeholderProperty(type, name);
		if (!prop) return null;
		const value = entity.values[prop.id];
		const shown =
			prop.kind === "reference"
				? referencedIds(prop, value).flatMap((id) => entityNames.get(id) ?? []).join(", ")
				: typeof value === "string"
					? value.trim()
					: "";
		return [document.createTextNode(shown || "—")];
	}).innerHTML;
}

const cellId = (cardId: string) => `card-${cardId}`;
const areaCellId = (areaId: string) => `area-${areaId}`;

/** Text as HTML, for labels. */
function esc(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text as an XML attribute value; line breaks kept. */
function attr(value: string): string {
	return esc(value).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}
