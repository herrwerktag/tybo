import {
	cardRows,
	detailRows,
	entityTypeMap,
	inverseCardRows,
	placeholderProperty,
	propertyRow,
	type CardRow,
	type Entity,
	type EntityType,
	type Store,
} from "@tybo/core";
import { el } from "./dom.js";
import { text } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";

/** A read-only card shown while hovering or focusing an entity's tag or link (see createCardPreview). */
export interface CardPreview {
	element: HTMLElement;
	/** Shows the entity's card while `tag` is hovered or focused. */
	attach(tag: HTMLElement, entityId: string): void;
	hide(): void;
}

/**
 * A card preview inside `container` (positioned, e.g. the canvas): in its coordinates, so zoom doesn't shrink it,
 * and as tall as its visible part allows. The preview's element still has to be put into the container.
 */
export function createCardPreview(store: Store, container: HTMLElement): CardPreview {
	const preview = el("article", { className: "canvas-card card-preview", role: "tooltip", id: "card-preview" });
	preview.hidden = true;
	let previewTimer: ReturnType<typeof setTimeout> | undefined;

	function show(anchor: HTMLElement, entityId: string): void {
		const entity = store.data.entities.find((e) => e.id === entityId);
		if (!entity || !anchor.isConnected) return;
		const type = store.data.types.find((t) => t.id === entity.typeId);
		const entityNames = new Map(store.data.entities.map((e) => [e.id, e.name]));
		const { header, body } = cardParts(store, entity, type, entityNames, () => false, { preview: null });
		preview.replaceChildren(header, ...(body ? [body] : []));
		preview.hidden = false;

		// The whole card, as tall as the container's visible part allows.
		const gap = 6;
		const margin = 8;
		const area = container.getBoundingClientRect();
		const tag = anchor.getBoundingClientRect();
		preview.style.maxHeight = `${area.height - 2 * margin}px`;
		const { offsetWidth: width, offsetHeight: height } = preview;
		// Fade the bottom only if even the full height isn't enough.
		preview.classList.toggle("clipped", !!body && body.scrollHeight > body.clientHeight);

		// Below the tag if it fits, else above; otherwise as low as fits inside the container (it may cover the tag,
		// which is fine because the preview never catches the pointer).
		const tagTop = tag.top - area.top;
		const tagBottom = tag.bottom - area.top;
		let top: number;
		if (tagBottom + gap + height <= area.height - margin) top = tagBottom + gap;
		else if (tagTop - gap - height >= margin) top = tagTop - gap - height;
		else top = Math.max(margin, area.height - margin - height);
		const left = Math.min(Math.max(margin, tag.left - area.left), area.width - width - margin);
		// A scrolling container moves its content, the preview with it.
		Object.assign(preview.style, { left: `${left + container.scrollLeft}px`, top: `${top + container.scrollTop}px` });
	}

	function hide(): void {
		clearTimeout(previewTimer);
		preview.hidden = true;
	}

	return {
		element: preview,
		attach(tag, entityId) {
			tag.tabIndex = 0;
			tag.setAttribute("aria-describedby", preview.id);
			tag.addEventListener("pointerenter", () => {
				clearTimeout(previewTimer);
				// A short delay, so moving across a card doesn't flash previews.
				previewTimer = setTimeout(() => show(tag, entityId), 250);
			});
			tag.addEventListener("pointerleave", hide);
			tag.addEventListener("focus", () => show(tag, entityId));
			tag.addEventListener("blur", hide);
		},
		hide,
	};
}

/**
 * Label/value rows: text as plain text, options as a grey chip, references as tags in their entity's type color.
 * With a `preview`, hovering or focusing a reference tag shows that entity's card.
 */
function propertyList(store: Store, rows: CardRow[], preview: CardPreview | null): HTMLElement {
	return el(
		"dl",
		{ className: "card-props" },
		...rows.flatMap((row) => {
			const value =
				row.kind === "text"
					? el("dd", { className: "prop-text", title: row.values.join("") }, ...row.values)
					: el(
							"dd",
							{ className: "prop-chips" },
							...row.values.map((v, i) => {
								if (row.kind !== "reference") return el("span", { className: "chip" }, v);
								// Same color as the top bar of the card it points to.
								const tag = el("span", { className: "ref-tag" }, v);
								const entityId = row.entityIds[i];
								const typeId = store.data.entities.find((e) => e.id === entityId)?.typeId;
								const color = store.data.types.find((t) => t.id === typeId)?.color;
								if (color) tag.style.background = color;
								if (preview && entityId) preview.attach(tag, entityId);
								return tag;
							}),
						);
			return [el("dt", { title: row.label }, row.label), value];
		}),
	);
}

/** Header (colored bar, name) and scrolling body (properties, content) shared by cards and previews. */
export function cardParts(
	store: Store,
	entity: Entity,
	type: EntityType | undefined,
	entityNames: ReadonlyMap<string, string>,
	isLinked: (entityId: string) => boolean,
	options: { buttons?: HTMLElement[]; preview: CardPreview | null },
): { header: HTMLElement; body: HTMLElement | null } {
	// Top bar in the type's color: type label (and × on real cards).
	const bar = el("div", { className: "card-bar" }, el("span", { className: "card-type" }, type?.name ?? ""), ...(options.buttons ?? []));
	if (type) bar.style.background = type.color;
	const header = el(
		"header",
		{},
		bar,
		// Wraps up to three lines; the full name is in the tooltip.
		el("strong", { className: "card-title", title: entity.name }, entity.name),
	);
	// Properties and content scroll together below the fixed header.
	// Own properties first, then the reverse side of references to this entity (e.g. "responsible for").
	const rows = [...(type ? cardRows(type, entity, entityNames, isLinked) : []), ...inverseCardRows(store.data, entity, entityNames, isLinked)];
	// Nothing to show below the name: no body at all (a compact card).
	const content = entity.content.trim();
	const body =
		rows.length > 0 || content
			? el(
					"div",
					{ className: "card-body" },
					...(rows.length > 0 ? [propertyList(store, rows, options.preview)] : []),
					...(content ? [el("div", { className: "card-content" }, entity.content)] : []),
				)
			: null;
	return { header, body };
}

/**
 * Easy-to-read details of an entity, for a details panel: its header (colored bar with ×, name, `actions`), then
 * description, all properties, content and ID. A referenced entity is a tag in the color of its type; clicking it
 * calls `onSelectEntity`.
 */
export function entityDetails(
	store: Store,
	entity: Entity,
	{ actions, onClose, onSelectEntity }: { actions: HTMLElement[]; onClose: () => void; onSelectEntity: (entityId: string) => void },
): HTMLElement[] {
	const types = new Map(store.data.types.map((t) => [t.id, t]));
	const type = types.get(entity.typeId);
	const entityNames = new Map(store.data.entities.map((e) => [e.id, e.name]));
	const entityTypes = entityTypeMap(store.data);

	const bar = el(
		"div",
		{ className: "card-bar" },
		el("span", { className: "card-type" }, type?.name ?? ""),
		el("button", { type: "button", className: "card-remove", title: text.closeDetails, ariaLabel: text.closeDetails, onclick: onClose }, "×"),
	);
	if (type) bar.style.background = type.color;
	const header = el(
		"header",
		{ className: "details-header" },
		bar,
		el("h2", { className: "details-title" }, entity.name),
		...(actions.length > 0 ? [el("div", { className: "details-actions" }, ...actions)] : []),
	);

	const section = (title: string, ...content: Node[]) => el("section", { className: "details-section" }, el("h3", {}, title), ...content);
	const rows = detailRows(store.data, entity, entityNames);
	const refTag = (name: string, entityId: string): HTMLElement => {
		const tag = el("button", { type: "button", className: "ref-tag", onclick: () => onSelectEntity(entityId) }, name);
		const color = types.get(entityTypes.get(entityId) ?? "")?.color;
		if (color) tag.style.background = color;
		return tag;
	};
	const value = (row: CardRow): HTMLElement => {
		if (row.values.length === 0) return el("dd", { className: "muted" }, "—");
		if (row.kind === "text") return el("dd", { className: "details-text" }, ...row.values);
		if (row.kind === "options") return el("dd", { className: "prop-chips" }, ...row.values.map((v) => el("span", { className: "chip" }, v)));
		return el("dd", { className: "prop-chips" }, ...row.values.map((name, i) => refTag(name, row.entityIds[i]!)));
	};
	// `{{Property}}` in the description: the value as text, references as tags, "—" when empty.
	const placeholder = (name: string): Node[] | null => {
		const prop = placeholderProperty(type, name);
		if (!prop) return null;
		const row = propertyRow(prop, entity, entityNames);
		if (row.values.length === 0) return [el("span", { className: "muted" }, "—")];
		if (row.kind !== "reference") return [document.createTextNode(row.values.join(", "))];
		return row.values.flatMap((n, i) => [...(i > 0 ? [document.createTextNode(", ")] : []), refTag(n, row.entityIds[i]!)]);
	};

	return [
		header,
		el(
			"div",
			{ className: "details-body" },
			section(
				text.description,
				entity.description.trim() ? renderMarkdown(entity.description, placeholder) : el("p", { className: "muted" }, text.noDescription),
			),
			...(rows.length > 0
				? [section(text.properties, el("dl", { className: "details-props" }, ...rows.flatMap((row) => [el("dt", {}, row.label), value(row)])))]
				: []),
			...(entity.content.trim() ? [section(text.content, el("p", { className: "details-text" }, entity.content))] : []),
			el("p", { className: "details-id" }, `${text.id}: `, el("span", { className: "mono" }, entity.id)),
		),
	];
}
