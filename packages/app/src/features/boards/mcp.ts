import { sameName, type AppData } from "../../shared/core/index.js";
import type { Store } from "../../features.core.js";
import { ENTITY, TYPE_HINT, entityOf, typeOf } from "../data/mcp.js";
import { GRID_SIZE, snapToGrid, type Entity } from "../data/core.js";
import { ToolError, WORKSPACE, object, record, text, texts, type Tool, type ToolContext } from "../../shared/mcp/index.js";
import { layeredLayout, type Board } from "./core.js";

/** The tools on a workspace's boards: put entities on one. */
export function boardTools({ open, answerSaved }: ToolContext<Store>): Tool[] {
	return [
	{
		name: "place_on_board",
		description:
			"Puts entities on a board as cards, so they can be seen with their references drawn between them. Names a board " +
			"by name or id; one of that name is made when there is none. `types` puts all entities of those types there, " +
			"`entities` the ones named (each a name or id, or { entity, type, x, y }). An entity with `x` and `y` goes there " +
			"(its card moves when it's on the board already); the others are laid out right of what's on the board, in columns " +
			"in the direction of the references (each type a band of its own), sorted so their lines cross as little as " +
			"possible; ones on the board already stay where they are.",
		inputSchema: object(
			{
				workspace: WORKSPACE,
				board: { type: "string", description: "Name or id of the board; made when there is none of that name." },
				types: { type: "array", items: { type: "string" }, description: "Names or ids of types: all their entities." },
				entities: {
					type: "array",
					items: {
						anyOf: [
							{ type: "string" },
							object({ entity: ENTITY, type: TYPE_HINT, x: { type: "number" }, y: { type: "number" } }, ["entity"]),
						],
					},
					description: "Entities by name or id, or with where their card goes (x to the right, y down; a new card is 240 × 168 until the editor sizes it to what it shows: 168 to 384 wide, as tall as needed).",
				},
			},
			["workspace", "board"],
		),
		async run(args) {
			const store = await open(args.workspace);
			if (args.types === undefined && args.entities === undefined) throw new ToolError("Give `types` or `entities` to put on the board.");
			const types = args.types === undefined ? [] : texts(args.types, "types").map((t) => typeOf(store.data, t).id);
			const given = new Map<string, { entity: Entity; at: { x: number; y: number } | null }>();
			for (const entity of store.data.entities.filter((e) => types.includes(e.typeId))) given.set(entity.id, { entity, at: null });
			if (args.entities !== undefined) {
				if (!Array.isArray(args.entities)) throw new ToolError("`entities` must be a list.");
				args.entities.forEach((item, index) => {
					const fields = typeof item === "string" ? { entity: item } : record(item, `entities[${index}]`);
					const entity = entityOf(store.data, fields.entity, fields.type);
					const hasAt = fields.x !== undefined || fields.y !== undefined;
					if (hasAt && (typeof fields.x !== "number" || typeof fields.y !== "number")) {
						throw new ToolError(`entities[${index}] ("${entity.name}") needs both x and y as numbers, or neither.`);
					}
					given.set(entity.id, { entity, at: hasAt ? { x: snapToGrid(fields.x as number), y: snapToGrid(fields.y as number) } : null });
				});
			}
			if (given.size === 0) throw new ToolError("There are no entities of those types to put on the board.");

			const { board, created } = boardOf(store, text(args.board, "board"));
			const onBoard = new Set(board.cards.map((c) => c.entityId));
			const kept = [...given.values()].filter((g) => g.at === null && onBoard.has(g.entity.id)).map((g) => g.entity);
			const toLayOut = [...given.values()].filter((g) => g.at === null && !onBoard.has(g.entity.id)).map((g) => g.entity);
			const start =
				board.cards.length === 0
					? board.viewFrame
					: { x: Math.max(...board.cards.map((c) => c.x + c.width)) + 4 * GRID_SIZE, y: Math.min(...board.cards.map((c) => c.y)) };
			const placements = [
				...[...given.values()].flatMap((g) => (g.at ? [{ entityId: g.entity.id, ...g.at }] : [])),
				...layeredLayout(store.data.types, toLayOut, start),
			];
			const cards = store.placeCards(board.id, placements);
			const name = (entityId: string) => store.data.entities.find((e) => e.id === entityId)!.name;
			return answerSaved(store, {
				board: { id: board.id, name: board.name, ...(created ? { created: true } : {}) },
				placed: cards.map((c) => ({ entity: name(c.entityId), x: c.x, y: c.y })),
				...(kept.length > 0 ? { kept: kept.map((e) => e.name) } : {}),
			});
		},
	},
	];
}

/** The boards' part of describe_workspace: each with how many cards it has. */
export function describeBoards(data: AppData): object {
	return { boards: data.boards.map((b) => ({ id: b.id, name: b.name, cards: b.cards.length })) };
}

/** The board `ref` names by id or name, or a new one of that name when there is none. */
function boardOf(store: Store, ref: string): { board: Board; created: boolean } {
	const byId = store.data.boards.find((b) => b.id === ref);
	if (byId) return { board: byId, created: false };
	const named = store.data.boards.filter((b) => sameName(b.name, ref));
	if (named.length > 1) throw new ToolError(`Several boards are called "${ref}": ${named.map((b) => b.id).join(", ")}. Name it by id.`);
	if (named.length === 1) return { board: named[0]!, created: false };
	if (ref.trim() === "") throw new ToolError("A board needs a name.");
	return { board: store.addBoard(ref), created: true };
}
