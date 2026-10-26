import type { Point } from "./connectors.js";
import { DEFAULT_CARD_SIZE, GRID_SIZE, referencedIds, snapToGrid, type Entity, type EntityType } from "./model.js";

/** Space between two columns, and between two cards of a column. */
const COLUMN_GAP = 4 * GRID_SIZE;
const ROW_GAP = 2 * GRID_SIZE;
/** The height a line passing through a column keeps free there. */
const PASSAGE = GRID_SIZE;
/** How much more a passage keeps its place than a card, when they're in each other's way. */
const PASSAGE_WEIGHT = 10;
/** How often the columns are sorted, back and forth; the order with the fewest crossings is kept. */
const SWEEPS = 24;

interface Node {
	/** The entity's id, or null for a point a line passes through a column at. */
	entityId: string | null;
	column: number;
	height: number;
	/** The nodes linked with it in the columns left and right of it. */
	left: Node[];
	right: Node[];
}

/**
 * Where the cards of `entities` go when laid out from `start`, so that the lines of their references cross as little
 * as it finds: in columns from left to right in the direction of the references (a layered layout). Each type keeps
 * a band of columns of its own, right of the types referencing it; references within a type (and between types
 * at the same depth) spread its band over several columns. A line spanning several columns keeps a passage free in
 * each column between; the cards of a column are sorted by where their neighbours are, and moved to their height.
 */
export function layeredLayout(
	types: readonly Pick<EntityType, "id" | "properties">[],
	entities: readonly Pick<Entity, "id" | "typeId" | "values">[],
	start: Point,
): { entityId: string; x: number; y: number }[] {
	const given = new Set(entities.map((e) => e.id));
	const typeById = new Map(types.map((t) => [t.id, t]));
	const links = entities.flatMap((e) =>
		(typeById.get(e.typeId)?.properties ?? []).flatMap((prop) =>
			prop.kind !== "reference" ? [] : referencedIds(prop, e.values[prop.id]).filter((id) => id !== e.id && given.has(id)).map((id) => ({ from: e.id, to: id })),
		),
	);

	const band = typeBands(types);
	const typeOf = new Map(entities.map((e) => [e.id, e.typeId]));
	const bandOf = (id: string) => band.get(typeOf.get(id)!) ?? 0;
	// Within a band: right of the entities referencing it from the same band, as far as the longest such chain goes.
	const inner = longestChains(
		entities.map((e) => e.id),
		links.filter((l) => bandOf(l.from) === bandOf(l.to)),
	);
	const bands = [...new Set(entities.map((e) => bandOf(e.id)))].sort((a, b) => a - b);
	const firstColumn = new Map<number, number>();
	let next = 0;
	for (const b of bands) {
		firstColumn.set(b, next);
		next += 1 + Math.max(...entities.filter((e) => bandOf(e.id) === b).map((e) => inner.get(e.id)!));
	}
	const columnOf = (id: string) => firstColumn.get(bandOf(id))! + inner.get(id)!;

	// The nodes: one per entity, and one per column a line passes through.
	const nodes = new Map(entities.map((e): [string, Node] => [e.id, { entityId: e.id, column: columnOf(e.id), height: DEFAULT_CARD_SIZE.height, left: [], right: [] }]));
	const passages: Node[] = [];
	for (const link of links) {
		let [a, b] = [nodes.get(link.from)!, nodes.get(link.to)!];
		if (a.column === b.column) continue;
		if (a.column > b.column) [a, b] = [b, a];
		let previous = a;
		for (let column = a.column + 1; column < b.column; column++) {
			const passage: Node = { entityId: null, column, height: PASSAGE, left: [previous], right: [] };
			previous.right.push(passage);
			passages.push(passage);
			previous = passage;
		}
		previous.right.push(b);
		b.left.push(previous);
	}

	// To begin with, each column holds the entities with lines in the order given, then the passages, then the rest.
	const columns: Node[][] = Array.from({ length: next }, () => []);
	const linked = (n: Node) => n.left.length + n.right.length > 0;
	for (const n of [...nodes.values()].filter(linked)) columns[n.column]!.push(n);
	for (const n of passages) columns[n.column]!.push(n);
	for (const n of [...nodes.values()].filter((n) => !linked(n))) columns[n.column]!.push(n);

	const order = sortColumns(columns);
	const tops = placeVertically(order);
	const minTop = Math.min(...[...nodes.values()].map((n) => tops.get(n)!));
	return entities.map((e) => {
		const node = nodes.get(e.id)!;
		return {
			entityId: e.id,
			x: snapToGrid(start.x) + node.column * (DEFAULT_CARD_SIZE.width + COLUMN_GAP),
			y: snapToGrid(start.y) + snapToGrid(tops.get(node)! - minTop),
		};
	});
}

/** Per type, its depth: right of the types referencing it, as far as the longest such chain goes (a loop between
 * types doesn't run away; a reference to the type itself doesn't count). */
function typeBands(types: readonly Pick<EntityType, "id" | "properties">[]): Map<string, number> {
	const links = types.flatMap((t) => t.properties.flatMap((p) => (p.reference?.typeIds ?? []).filter((id) => id !== t.id).map((id) => ({ from: t.id, to: id }))));
	return longestChains(
		types.map((t) => t.id),
		links,
	);
}

/** Per id, the length of the longest chain of `links` leading to it. A link closing a loop (found going depth
 * first, in the order of `ids`) is left out, so a loop is laid out as a chain. */
function longestChains(ids: readonly string[], links: readonly { from: string; to: string }[]): Map<string, number> {
	const out = new Map(ids.map((id) => [id, [] as string[]]));
	for (const { from, to } of links) if (out.has(to)) out.get(from)?.push(to);
	const state = new Map<string, "open" | "done">();
	const kept: { from: string; to: string }[] = [];
	const visit = (id: string) => {
		state.set(id, "open");
		for (const to of out.get(id)!) {
			if (state.get(to) === "open") continue;
			kept.push({ from: id, to });
			if (!state.has(to)) visit(to);
		}
		state.set(id, "done");
	};
	for (const id of ids) if (!state.has(id)) visit(id);
	// Without loops, each id's depth follows from the ones before it in reverse finishing order.
	const into = new Map(ids.map((id) => [id, [] as string[]]));
	for (const { from, to } of kept) into.get(to)!.push(from);
	const depth = new Map<string, number>();
	const depthOf = (id: string): number => {
		if (!depth.has(id)) depth.set(id, Math.max(0, ...into.get(id)!.map((from) => depthOf(from) + 1)));
		return depth.get(id)!;
	};
	for (const id of ids) depthOf(id);
	return depth;
}

/** The columns sorted, one after the other and back, each by the mean position of its nodes' neighbours in the
 * column just sorted (the barycenter heuristic); the order with the fewest crossings is kept. */
function sortColumns(columns: Node[][]): Node[][] {
	let order = columns.map((c) => [...c]);
	let best = order;
	let fewest = crossings(order);
	for (let sweep = 0; sweep < SWEEPS && fewest > 0; sweep++) {
		const rightward = sweep % 2 === 0;
		order = order.map((c) => [...c]);
		const indices = order.map((_, i) => i);
		for (const i of rightward ? indices.slice(1) : indices.slice(0, -1).reverse()) {
			const beside = order[rightward ? i - 1 : i + 1]!;
			const position = new Map(beside.map((n, p) => [n, p]));
			const own = new Map(order[i]!.map((n, p) => [n, p]));
			const center = (n: Node) => {
				const neighbours = (rightward ? n.left : n.right).filter((m) => position.has(m));
				// Without neighbours there, a node stays where it is.
				if (neighbours.length === 0) return (own.get(n)! / Math.max(1, order[i]!.length - 1)) * Math.max(0, beside.length - 1);
				return neighbours.reduce((sum, m) => sum + position.get(m)!, 0) / neighbours.length;
			};
			order[i] = [...order[i]!].sort((a, b) => center(a) - center(b) || own.get(a)! - own.get(b)!);
		}
		const count = crossings(order);
		if (count < fewest) [best, fewest] = [order, count];
	}
	return best;
}

/** How many links between neighbouring columns cross. */
function crossings(order: readonly Node[][]): number {
	let count = 0;
	for (let i = 0; i + 1 < order.length; i++) {
		const position = new Map(order[i + 1]!.map((n, p) => [n, p]));
		const links = order[i]!.flatMap((n, p) => n.right.filter((m) => position.has(m)).map((m) => [p, position.get(m)!] as const));
		for (let a = 0; a < links.length; a++) {
			for (let b = a + 1; b < links.length; b++) {
				if ((links[a]![0] - links[b]![0]) * (links[a]![1] - links[b]![1]) < 0) count++;
			}
		}
	}
	return count;
}

/** The top of each node: stacked in its column's order, and moved, back and forth over the columns, as close to the
 * mean height of its neighbours as the column allows. */
function placeVertically(order: readonly Node[][]): Map<Node, number> {
	const top = new Map<Node, number>();
	for (const column of order) {
		let y = 0;
		for (const n of column) {
			top.set(n, y);
			y += n.height + ROW_GAP;
		}
	}
	const middle = (n: Node) => top.get(n)! + n.height / 2;
	for (let round = 0; round < 8; round++) {
		const rightward = round % 2 === 0;
		for (const column of rightward ? order : [...order].reverse()) {
			const wanted = column.map((n) => {
				const neighbours = rightward ? n.left : n.right;
				if (neighbours.length === 0) return top.get(n)!;
				return neighbours.reduce((sum, m) => sum + middle(m), 0) / neighbours.length - n.height / 2;
			});
			fitInOrder(column, wanted).forEach((y, i) => top.set(column[i]!, y));
		}
	}
	return top;
}

/**
 * The tops closest to `wanted` (least squares) that keep the nodes in order with a gap between them: nodes
 * pushing into each other are moved as one block, to the mean of where they want to be — weighted, so the cards
 * make way for the lines passing.
 */
function fitInOrder(column: readonly Node[], wanted: readonly number[]): number[] {
	const weight = (k: number) => (column[k]!.entityId === null ? PASSAGE_WEIGHT : 1);
	const blocks: { first: number; offsets: number[]; size: number; top: number }[] = [];
	column.forEach((n, i) => {
		let block = { first: i, offsets: [0], size: n.height, top: wanted[i]! };
		for (let last = blocks.at(-1); last && last.top + last.size + ROW_GAP > block.top; last = blocks.at(-1)) {
			blocks.pop();
			const shift = last.size + ROW_GAP;
			const offsets = [...last.offsets, ...block.offsets.map((o) => o + shift)];
			const weights = offsets.map((_, k) => weight(last.first + k));
			const top = offsets.reduce((sum, o, k) => sum + weights[k]! * (wanted[last.first + k]! - o), 0) / weights.reduce((a, b) => a + b, 0);
			block = { first: last.first, offsets, size: shift + block.size, top };
		}
		blocks.push(block);
	});
	return blocks.flatMap((b) => b.offsets.map((o) => b.top + o));
}
