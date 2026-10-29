import type { Point } from "../../../shared/core/index.js";
import { el } from "../../../shared/ui/index.js";
import type { Store } from "../../../legacy/core/store.js";
import { filterEntities, linkCandidates, relationsOf, type Entity, type Relation } from "../../data/core.js";
import { text as dataText } from "../../data/texts.js";
import type { CanvasCard } from "../core.js";
import { text } from "../texts.js";

/** An overlay over the canvas (shown with showModal), closed by its × (see dialogHeader), Escape, or a click beside it. */
function canvasDialog(className: string, label: string): HTMLDialogElement {
	const dialog: HTMLDialogElement = el("dialog", {
		className: `canvas-dialog ${className}`,
		ariaLabel: label,
		// No expression body: an on… handler returning false would cancel every click inside, submits included.
		onclick: (e: MouseEvent) => {
			if (e.target === dialog) dialog.close();
		},
	});
	return dialog;
}

function dialogHeader(dialog: HTMLDialogElement, title: string): HTMLElement {
	return el(
		"header",
		{},
		el("h2", {}, title),
		el("button", { type: "button", className: "card-remove", title: text.close, ariaLabel: text.close, onclick: () => dialog.close() }, "×"),
	);
}

/**
 * Links a card's entity with another one, existing or new, through any relation (see relationsOf): the dialog, and
 * the button opening it. Either way the other entity's card is shown beside the card (`onLinked`).
 */
export function connectDialog(store: Store, onLinked: (card: CanvasCard) => void) {
	const dialog = canvasDialog("connect-dialog", text.connect);

	function connectButton(entity: Entity, cardId: string): HTMLButtonElement {
		const none = relationsOf(store.data.types, entity).length === 0;
		return el(
			"button",
			{ type: "button", disabled: none, title: none ? text.noRelations : text.connectHint, onclick: () => openConnect(entity.id, cardId) },
			text.connect,
		);
	}

	/** How a relation reads in the dialog, seen from the selected entity: its own reference, or another type's. */
	function relationLabel({ prop, direction, typeId }: Relation): string {
		const typeName = store.data.types.find((t) => t.id === typeId)?.name ?? "?";
		if (direction === "forward") return text.relationForward(prop.name, typeName);
		const inverse = prop.reference?.inverseLabel.trim() ?? "";
		return inverse ? text.relationInverse(inverse, typeName) : text.relationInverseUnnamed(typeName, prop.name);
	}

	function openConnect(entityId: string, cardId: string): void {
		renderConnect(entityId, cardId);
		dialog.showModal();
		dialog.querySelector<HTMLInputElement>(".connect-new input")?.focus();
	}

	/** The dialog's content for one of the relations: the existing entities fitting it (found by name), and a form for
	 * a new one. Either way the other entity's card is shown beside the card, and the selection stays on it. */
	function renderConnect(entityId: string, cardId: string, index = 0): void {
		const entity = store.data.entities.find((e) => e.id === entityId);
		if (!entity) return dialog.close();
		const relations = relationsOf(store.data.types, entity);
		const relation = relations[index];
		if (!relation) return dialog.close();
		const link = { propId: relation.prop.id, direction: relation.direction };
		const typeName = store.data.types.find((t) => t.id === relation.typeId)?.name ?? "?";
		const done = (card: CanvasCard | undefined) => {
			dialog.close();
			if (card) onLinked(card);
		};

		const choice = el(
			"select",
			{ ariaLabel: text.relation, onchange: () => renderConnect(entityId, cardId, Number(choice.value)) },
			...relations.map((r, i) => el("option", { value: String(i), selected: i === index }, relationLabel(r))),
		);
		const candidates = linkCandidates(store.data.entities, entity, relation);
		const list = el("ul", { className: "connect-list" });
		const renderList = (query: string) => {
			const found = filterEntities(candidates, { query, typeId: null });
			list.replaceChildren(
				...(found.length === 0 ? [el("li", { className: "muted" }, candidates.length === 0 ? text.noCandidates : text.noMatches)] : []),
				...found.map((other) =>
					el(
						"li",
						{},
						el(
							"button",
							{
								type: "button",
								className: "picker-option",
								onclick: () => done(store.linkEntity(cardId, link, other.id) ?? undefined),
							},
							other.name,
						),
					),
				),
			);
		};
		renderList("");
		const search = el("input", {
			type: "search",
			placeholder: text.searchEntities,
			ariaLabel: text.searchEntities,
			oninput: () => renderList(search.value),
		});
		const name = el("input", { required: true, pattern: ".*\\S.*", placeholder: dataText.name, ariaLabel: dataText.name });
		dialog.replaceChildren(
			dialogHeader(dialog, text.connectNamed(entity.name)),
			el("label", { className: "field" }, el("span", {}, text.relation), choice),
			el(
				"form",
				{
					className: "connect-new",
					onsubmit: (e: SubmitEvent) => {
						e.preventDefault();
						done(store.addLinkedEntity(cardId, link, relation.typeId, name.value)?.card);
					},
				},
				el("h3", {}, dataText.newEntity(typeName)),
				el("div", { className: "row" }, name, el("button", { type: "submit", className: "primary" }, dataText.create)),
			),
			el("div", { className: "connect-existing" }, el("h3", {}, text.existingEntity(typeName)), search, list),
		);
	}

	return { dialog, button: connectButton };
}

/** Creates an entity of any type, with its card on the board `boardId` at the first free spot from `at`, tagged with
 * `tags`: the dialog, and how to open it. */
export function newEntityDialog(
	store: Store,
	place: {
		boardId(): string;
		at(): Point;
		tags(): string[];
		onMade(made: { entity: Entity; card: CanvasCard }): void;
	},
) {
	const dialog = canvasDialog("new-entity-dialog", text.newEntityTitle);

	function openNewEntity(): void {
		const types = store.data.types;
		const typeSelect = el("select", { ariaLabel: dataText.entityType }, ...types.map((t) => el("option", { value: t.id }, t.name)));
		const name = el("input", { required: true, pattern: ".*\\S.*", placeholder: dataText.name, ariaLabel: dataText.name });
		dialog.replaceChildren(
			dialogHeader(dialog, text.newEntityTitle),
			types.length === 0
				? el("p", { className: "muted" }, dataText.createTypeFirst)
				: el(
						"form",
						{
							className: "connect-new",
							onsubmit: (e: SubmitEvent) => {
								e.preventDefault();
								const made = store.addEntityWithCard(place.boardId(), typeSelect.value, name.value, place.at(), place.tags());
								dialog.close();
								if (made) place.onMade(made);
							},
						},
						el("label", { className: "field" }, el("span", {}, dataText.entityType), typeSelect),
						el("div", { className: "row" }, name, el("button", { type: "submit", className: "primary" }, dataText.create)),
					),
		);
		dialog.showModal();
		name.focus();
	}

	return { dialog, open: openNewEntity };
}
