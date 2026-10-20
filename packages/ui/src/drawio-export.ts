import {
	cardRows,
	effectiveCardDisplay,
	fillPlaceholders,
	inverseCardRows,
	nearest,
	referencedIds,
	type AppData,
	type CanvasCard,
	type CardRow,
	type Entity,
	type EntityType,
	type LineArrow,
} from "@tybo/core";

/**
 * A board as a draw.io file: its cards as boxes, where they are on the board, showing what the cards show (type bar,
 * name, properties, content), and the lines of `line` references as edges attached to them, so they stay attached
 * when moved in draw.io. A card's description is its tooltip. Like the editor outside a story, the whole board is
 * in; drawings and stories are left out.
 */
export function boardDrawio(data: Pick<AppData, "types" | "entities" | "boards">, boardId: string): string {
	const board = data.boards.find((b) => b.id === boardId);
	if (!board) throw new Error(`No board ${boardId}`);
	const types = new Map(data.types.map((t) => [t.id, t]));
	const entities = new Map(data.entities.map((e) => [e.id, e]));
	const entityNames = new Map(data.entities.map((e) => [e.id, e.name]));
	const cards = board.cards.filter((c) => entities.has(c.entityId));
	const cardsByEntity = new Map<string, CanvasCard[]>();
	for (const card of cards) cardsByEntity.set(card.entityId, [...(cardsByEntity.get(card.entityId) ?? []), card]);

	const vertices: string[] = [];
	const edges: string[] = [];
	for (const card of cards) {
		const entity = entities.get(card.entityId)!;
		const type = types.get(entity.typeId);
		// Like on the canvas: other cards of the referenced entity, the line going to the nearest one.
		const targetCards = (entityId: string) => (cardsByEntity.get(entityId) ?? []).filter((c) => c.id !== card.id);
		const isLinked = (entityId: string) => targetCards(entityId).length > 0;
		const rows = [...(type ? cardRows(type, entity, entityNames, isLinked) : []), ...inverseCardRows(data, entity, entityNames, isLinked)];
		// Cards without content are as tall as what they show, which the editor measures: here it's counted in grid
		// steps like in the stylesheet (bar, one line of name, the property rows with half a step above and below).
		const height = entity.content.trim() ? card.height : 72 + (rows.length > 0 ? 24 * (rows.length + 1) : 0);
		const label = cardLabel(entity, type, rows, (id) => types.get(entities.get(id)?.typeId ?? "")?.color ?? "#ebebeb");
		vertices.push(
			`<UserObject id="${attr(cellId(card.id))}" label="${attr(label)}" tooltip="${attr(description(entity, type, entityNames))}">` +
				`<mxCell style="${CARD_STYLE}" vertex="1" parent="1">` +
				`<mxGeometry x="${card.x}" y="${card.y}" width="${card.width}" height="${height}" as="geometry"/>` +
				`</mxCell></UserObject>`,
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
		`<mxfile host="tybo"><diagram id="${attr(board.id)}" name="${attr(board.name)}">` +
		`<mxGraphModel grid="1" gridSize="24" guides="1" connect="1" arrows="1" page="0"><root>` +
		`<mxCell id="0"/><mxCell id="1" parent="0"/>${vertices.join("")}${edges.join("")}` +
		`</root></mxGraphModel></diagram></mxfile>\n`
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

/** The description as plain text, its {{Property}} placeholders filled in like in the details panel ("—" when empty). */
function description(entity: Entity, type: EntityType | undefined, entityNames: ReadonlyMap<string, string>): string {
	return fillPlaceholders(entity.description.trim(), type, (prop) => {
		const value = entity.values[prop.id];
		const shown =
			prop.kind === "reference"
				? referencedIds(prop, value).flatMap((id) => entityNames.get(id) ?? []).join(", ")
				: typeof value === "string"
					? value.trim()
					: "";
		return shown || "—";
	});
}

const cellId = (cardId: string) => `card-${cardId}`;

/** Text as HTML, for labels. */
function esc(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text as an XML attribute value; line breaks kept. */
function attr(value: string): string {
	return esc(value).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}
