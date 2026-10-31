import { freeName, moveItem, refuseTakenName, ulid, type Point, type Rect, type StoreCore, type AppData } from "../../../shared/core/index.js";
import {
	DEFAULT_CARD_SIZE,
	canTakeMore,
	cardRows,
	inverseCardRows,
	parseTags,
	referencedIds,
	type Entity,
	type Relation,
} from "../../data/core/model.js";
import { freeSpot, frameShape, placeAround, placeBeside, type Board, type BoardList, type CanvasCard } from "./model.js";
import { newBoard } from "./normalize.js";
import { clampZoom, type Viewport } from "./viewport.js";

/** How two entities get linked, seen from one of them: through which reference property, held by which side. */
export type Link = { propId: string; direction: Relation["direction"] };

/**
 * Links the entity of the card `sourceCardId` with `other` through `link` (seen from the card's entity), in `data`,
 * which must hold `other`: the holder of the reference gets the other one added (if it allows several) or set. Then
 * `other` is shown on the card's board: by its card there, or by a new one beside the source card. Null if they
 * don't fit together, or are linked already.
 */
function linkOnBoard(data: AppData, sourceCardId: string, link: Link, other: Entity): { data: AppData; card: CanvasCard } | null {
	const board = data.boards.find((b) => b.cards.some((c) => c.id === sourceCardId));
	const source = board?.cards.find((c) => c.id === sourceCardId);
	const entity = data.entities.find((e) => e.id === source?.entityId);
	if (!board || !source || !entity || entity.id === other.id) return null;
	const [holder, target] = link.direction === "forward" ? [entity, other] : [other, entity];
	const prop = data.types.find((t) => t.id === holder.typeId)?.properties.find((p) => p.id === link.propId);
	if (prop?.kind !== "reference" || !prop.reference?.typeIds.includes(target.typeId) || !canTakeMore(prop, holder.values[prop.id])) return null;
	const linked = referencedIds(prop, holder.values[prop.id]);
	if (linked.includes(target.id)) return null;
	const value = prop.reference.multiple ? [...linked, target.id] : target.id;

	const existing = board.cards.find((c) => c.entityId === other.id);
	const card: CanvasCard = existing ?? { id: ulid(), entityId: other.id, ...placeBeside(source, board.cards, DEFAULT_CARD_SIZE), ...DEFAULT_CARD_SIZE };
	return {
		card,
		data: {
			...data,
			entities: data.entities.map((e) => (e.id === holder.id ? { ...e, values: { ...e.values, [prop.id]: value } } : e)),
			boards: existing ? data.boards : data.boards.map((b) => (b.id === board.id ? { ...b, cards: [...b.cards, card] } : b)),
		},
	};
}

/**
 * The entities the card `cardId` lists by its references (see cardRows and inverseCardRows: what is shown as a
 * line, or not at all, isn't listed) that have no card on its board: those it references, then those referencing it,
 * each once. Empty for a card that isn't there.
 */
export function referencesOffBoard(data: AppData, cardId: string): { forward: string[]; inverse: string[] } {
	const board = data.boards.find((b) => b.cards.some((c) => c.id === cardId));
	const entity = data.entities.find((e) => e.id === board?.cards.find((c) => c.id === cardId)?.entityId);
	if (!board || !entity) return { forward: [], inverse: [] };
	const names = new Map(data.entities.map((e) => [e.id, e.name]));
	const type = data.types.find((t) => t.id === entity.typeId);
	const seen = new Set(board.cards.map((c) => c.entityId));
	const offBoard = (rows: { entityIds: string[] }[]): string[] => {
		const ids = rows.flatMap((row) => row.entityIds).filter((id) => !seen.has(id));
		for (const id of ids) seen.add(id);
		return [...new Set(ids)];
	};
	const forward = offBoard(type ? cardRows(type, entity, names) : []);
	return { forward, inverse: offBoard(inverseCardRows(data, entity, names)) };
}

/** The changes to the boards and their cards, on the store of the app's data. `lists` are the features' lists on
 * each board (see `BoardList`): a new board gets them empty, and `moveItems` moves their items too. */
export function boardOps(core: StoreCore<AppData>, lists: readonly BoardList[]) {
	const withBoard = (boardId: string, fn: (board: Board) => Board): AppData => ({
		...core.data,
		boards: core.data.boards.map((b) => (b.id === boardId ? fn(b) : b)),
	});

	function updateBoard(boardId: string, fn: (board: Board) => Board): void {
		core.change(withBoard(boardId, fn));
	}

	/** Applies fn to the board holding the card (card ids are unique across boards). */
	function updateCardBoard(cardId: string, fn: (board: Board, card: CanvasCard) => Board): void {
		for (const board of core.data.boards) {
			const card = board.cards.find((c) => c.id === cardId);
			if (card) return updateBoard(board.id, (b) => fn(b, card));
		}
	}

	return {
		/** Without a name, the board is "Board n" of the first number free; a name another board has is refused with
		 * a `NameTaken`. */
		addBoard(name: string): Board {
			refuseTakenName("board", core.data.boards, name);
			const board = newBoard(name.trim() || freeName(core.data.boards, (n) => `Board ${n}`), lists);
			core.change({ ...core.data, boards: [...core.data.boards, board] });
			return board;
		},

		/** An empty name is ignored; one another board has is refused with a `NameTaken`. */
		renameBoard(boardId: string, name: string): void {
			if (name.trim() === "") return;
			refuseTakenName("board", core.data.boards, name, boardId);
			updateBoard(boardId, (b) => ({ ...b, name: name.trim() }));
		},

		/** Moves the board to index `to` in the list of boards. */
		moveBoard(boardId: string, to: number): void {
			const from = core.data.boards.findIndex((b) => b.id === boardId);
			if (from < 0) return;
			core.change({ ...core.data, boards: moveItem(core.data.boards, from, to) });
		},

		/** Deletes a board and its cards (never the entities), even the last one. */
		deleteBoard(boardId: string): void {
			core.change({ ...core.data, boards: core.data.boards.filter((b) => b.id !== boardId) });
		},

		/** Adds a new card for the entity at (x, y), on top of the board's other cards. */
		addCard(boardId: string, entityId: string, x: number, y: number): CanvasCard {
			const card: CanvasCard = { id: ulid(), entityId, x, y, ...DEFAULT_CARD_SIZE };
			updateBoard(boardId, (b) => ({ ...b, cards: [...b.cards, card] }));
			return card;
		},

		/** Puts the cards of several entities on the board as one change: an entity with a card there already has its
		 * first card moved to (x, y), the others get a new one on top. An entity given twice goes where it's given
		 * last. Answers the cards, one per entity in the order given. */
		placeCards(boardId: string, placements: readonly { entityId: string; x: number; y: number }[]): CanvasCard[] {
			const board = core.data.boards.find((b) => b.id === boardId);
			if (!board || placements.length === 0) return [];
			const last = new Map(placements.map((p) => [p.entityId, p]));
			const cards = [...last.values()].map(({ entityId, x, y }): CanvasCard => {
				const existing = board.cards.find((c) => c.entityId === entityId);
				return existing ? { ...existing, x, y } : { id: ulid(), entityId, x, y, ...DEFAULT_CARD_SIZE };
			});
			const byId = new Map(cards.map((c) => [c.id, c]));
			const added = cards.filter((c) => !board.cards.some((b) => b.id === c.id));
			updateBoard(boardId, (b) => ({ ...b, cards: [...b.cards.map((c) => byId.get(c.id) ?? c), ...added] }));
			return cards;
		},

		/**
		 * Creates an entity of type `typeId` named `name` and links it with the entity of the card `sourceCardId`
		 * through `link` (seen from that entity; see linkOnBoard, which also places its card). It gets the type's
		 * template as description and the source entity's tags (it belongs to the same set). One change, so one
		 * undo step; null (and no change) if they don't fit together.
		 */
		addLinkedEntity(sourceCardId: string, link: Link, typeId: string, name: string): { entity: Entity; card: CanvasCard } | null {
			const type = core.data.types.find((t) => t.id === typeId);
			const sourceEntityId = core.data.boards.flatMap((b) => b.cards).find((c) => c.id === sourceCardId)?.entityId;
			const sourceEntity = core.data.entities.find((e) => e.id === sourceEntityId);
			if (!type || !sourceEntity) return null;
			const entity: Entity = {
				id: ulid(),
				typeId,
				name: name.trim(),
				content: "",
				description: type.contentTemplate,
				tags: [...sourceEntity.tags],
				values: {},
			};
			const linked = linkOnBoard({ ...core.data, entities: [...core.data.entities, entity] }, sourceCardId, link, entity);
			if (!linked) return null;
			core.change(linked.data);
			return { entity: linked.data.entities.find((e) => e.id === entity.id)!, card: linked.card }; // with its reference, if it holds it
		},

		/** Links an existing entity with the entity of the card `sourceCardId` through `link`, showing its card
		 * there (see linkOnBoard); one change. Answers that card, or null (and no change) if they don't fit together. */
		linkEntity(sourceCardId: string, link: Link, otherId: string): CanvasCard | null {
			const other = core.data.entities.find((e) => e.id === otherId);
			const linked = other && linkOnBoard(core.data, sourceCardId, link, other);
			if (!linked) return null;
			core.change(linked.data);
			return linked.card;
		},

		/** Creates an entity of type `typeId` named `name`, with `tags` and the type's template as description, and its
		 * card on the board at the first free spot from `at`; one change. */
		addEntityWithCard(boardId: string, typeId: string, name: string, at: Point, tags: readonly string[] = []): { entity: Entity; card: CanvasCard } | null {
			const type = core.data.types.find((t) => t.id === typeId);
			const board = core.data.boards.find((b) => b.id === boardId);
			if (!type || !board) return null;
			const entity: Entity = { id: ulid(), typeId, name: name.trim(), content: "", description: type.contentTemplate, tags: parseTags(tags.join(",")), values: {} };
			const card: CanvasCard = { id: ulid(), entityId: entity.id, ...freeSpot(at, board.cards, DEFAULT_CARD_SIZE), ...DEFAULT_CARD_SIZE };
			core.change({
				...core.data,
				entities: [...core.data.entities, entity],
				boards: core.data.boards.map((b) => (b.id === boardId ? { ...b, cards: [...b.cards, card] } : b)),
			});
			return { entity, card };
		},

		/**
		 * Puts the cards of the entities the card `cardId` lists but its board doesn't show (see referencesOffBoard)
		 * around it, in one change: those it references to its right, those referencing it to its left (see
		 * placeAround), each as big as `sizeOf` says (as the editor measures it). Answers the new cards.
		 */
		layOutReferences(cardId: string, sizeOf: (entityId: string) => { width: number; height: number }): CanvasCard[] {
			const board = core.data.boards.find((b) => b.cards.some((c) => c.id === cardId));
			const source = board?.cards.find((c) => c.id === cardId);
			if (!board || !source) return [];
			const { forward, inverse } = referencesOffBoard(core.data, cardId);
			const sized = (ids: string[]) => ids.map((entityId) => ({ entityId, ...sizeOf(entityId) }));
			const [right, left] = [sized(forward), sized(inverse)];
			const spots = placeAround(source, board.cards, { right, left });
			const cards: CanvasCard[] = [
				...right.map((card, i) => ({ id: ulid(), ...card, ...spots.right[i]! })),
				...left.map((card, i) => ({ id: ulid(), ...card, ...spots.left[i]! })),
			];
			if (cards.length > 0) updateBoard(board.id, (b) => ({ ...b, cards: [...b.cards, ...cards] }));
			return cards;
		},

		/** Moves a card to (x, y) and brings it to the front. */
		moveCard(cardId: string, x: number, y: number): void {
			updateCardBoard(cardId, (b, card) => ({
				...b,
				cards: [...b.cards.filter((c) => c.id !== cardId), { ...card, x, y }],
			}));
		},

		/** Moves some of a board's cards and the items of its lists (by list: `cards`, and each `BoardList`'s key) by
		 * (dx, dy) together, as one change (one undo step). Unlike moveCard, it keeps the order of the cards. */
		moveItems(boardId: string, items: Readonly<Record<string, readonly string[]>>, dx: number, dy: number): void {
			const cards = new Set(items.cards);
			updateBoard(boardId, (b) => {
				const moved: Record<string, unknown[]> = {};
				for (const { key, move } of lists) {
					const ids = new Set(items[key]);
					if (ids.size > 0) moved[key] = (b as unknown as Record<string, { id: string }[]>)[key]!.map((item) => (ids.has(item.id) ? move(item, dx, dy) : item));
				}
				return { ...b, cards: b.cards.map((c) => (cards.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c)), ...moved };
			});
		},

		/** The sizes cards were measured at, by card id. Saved, but like pan and zoom not part of the undo history:
		 * they follow from what the cards show. */
		fitCards(sizes: ReadonlyMap<string, { width: number; height: number }>): void {
			core.changeQuietly({
				...core.data,
				boards: core.data.boards.map((b) =>
					b.cards.some((c) => sizes.has(c.id)) ? { ...b, cards: b.cards.map((c) => ({ ...c, ...sizes.get(c.id) })) } : b,
				),
			});
		},

		/** Takes the card off its board; the entity itself stays. */
		removeCard(cardId: string): void {
			updateCardBoard(cardId, (b) => ({ ...b, cards: b.cards.filter((c) => c.id !== cardId) }));
		},

		/** Pan and zoom are saved, but not part of the undo history. */
		setViewport(boardId: string, viewport: Viewport): void {
			core.changeQuietly(withBoard(boardId, (b) => ({ ...b, viewport: { ...viewport, zoom: clampZoom(viewport.zoom) } })));
		},

		/** Moves or resizes the board's own frame, in a frame's shape (see frameShape). */
		setViewFrame(boardId: string, rect: Rect): void {
			updateBoard(boardId, (b) => ({ ...b, viewFrame: frameShape({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }) }));
		},
	};
}
