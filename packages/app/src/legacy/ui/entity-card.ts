import {
	CARD_WIDTH,
	GRID_SIZE,
	cardRows,
	detailRows,
	entityTypeMap,
	inverseCardRows,
	missingRequired,
	placeholderProperty,
	propertyRow,
	type CardRow,
	type Entity,
	type EntityType,
	type Store,
} from "../core/index.js";
import { el } from "../../shared/ui/index.js";
import { text } from "./i18n.js";
import { renderMarkdown } from "../../shared/ui/index.js";

/** A read-only card shown while hovering or focusing an entity's tag or link (see createCardPreview). */
/** The width of the panel showing an entity's details, beside a board or an analysis. */
export const DETAILS_WIDTH_KEY = "details-panel-width";

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

		// As wide as a card of it on the board, as tall as the container's visible part allows.
		const gap = 6;
		const margin = 8;
		const area = container.getBoundingClientRect();
		const tag = anchor.getBoundingClientRect();
		preview.style.maxHeight = "";
		const size = cardSize(preview);
		Object.assign(preview.style, { width: size ? `${size.width}px` : "", height: "", maxHeight: `${area.height - 2 * margin}px` });
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
 * The size a card (or preview) shows what it has in: as narrow as it gets on the grid without growing taller or
 * cutting more off than at its widest (CARD_WIDTH), and exactly as tall as it then needs to show all of it (rounding
 * up to the grid would leave room empty at the bottom). Null while the card isn't laid out. Measuring leaves the
 * card's width and height set to anything: set them afterwards. (offsetWidth and offsetHeight ignore the zoom, so
 * on the board they're in world units.)
 */
export function cardSize(node: HTMLElement): { width: number; height: number } | null {
	// What's cut off with … (labels, tags, the type) or after three lines (the name) doesn't make the card taller:
	// how much of it is hidden, in pixels.
	const cutOff = () =>
		[...node.querySelectorAll(".card-type, .card-title, .card-props dt, .card-props .chip, .card-props .ref-tag")].reduce(
			(sum, e) => sum + e.scrollWidth - e.clientWidth + e.scrollHeight - e.clientHeight,
			0,
		);
	const heightAt = (width: number) => {
		Object.assign(node.style, { width: `${width}px`, height: "" });
		return node.offsetHeight;
	};
	node.style.height = "";
	node.style.width = "max-content";
	if (node.offsetWidth === 0) return null;
	const up = (value: number) => Math.ceil(value / GRID_SIZE) * GRID_SIZE;
	// Fits on one line each: as wide as the longest. Otherwise the narrowest width wrapping into as few lines as the
	// widest does, so no room is left empty at the right.
	let width = Math.min(CARD_WIDTH.max, Math.max(CARD_WIDTH.min, up(node.offsetWidth)));
	if (width === CARD_WIDTH.max) {
		const lowest = heightAt(CARD_WIDTH.max);
		const leastCut = cutOff();
		let [narrow, wide] = [CARD_WIDTH.min / GRID_SIZE - 1, CARD_WIDTH.max / GRID_SIZE]; // in grid steps; wide fits
		while (wide - narrow > 1) {
			const middle = Math.floor((narrow + wide) / 2);
			if (heightAt(middle * GRID_SIZE) <= lowest && cutOff() <= leastCut) wide = middle;
			else narrow = middle;
		}
		width = wide * GRID_SIZE;
	}
	return { width, height: heightAt(width) };
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
					? el("dd", { className: "prop-text" }, ...row.values)
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
	// Required references that are still empty, whatever their card display.
	const missing = missingRequired(type, entity).map((p) => p.name);
	const body =
		rows.length > 0 || content || missing.length > 0
			? el(
					"div",
					{ className: "card-body" },
					...(missing.length > 0 ? [el("p", { className: "card-missing" }, text.missingRequired(missing.join(", ")))] : []),
					...(rows.length > 0 ? [propertyList(store, rows, options.preview)] : []),
					...(content ? [el("div", { className: "card-content" }, entity.content)] : []),
				)
			: null;
	return { header, body };
}

/** The details panel's top bar in the type's color: the type's name and × calling `onClose`. */
export function detailsBar(type: EntityType | undefined, onClose: () => void): HTMLElement {
	const bar = el(
		"div",
		{ className: "card-bar" },
		el("span", { className: "card-type" }, type?.name ?? ""),
		el("button", { type: "button", className: "card-remove", title: text.closeDetails, ariaLabel: text.closeDetails, onclick: onClose }, "×"),
	);
	if (type) bar.style.background = type.color;
	return bar;
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

	const header = el(
		"header",
		{ className: "details-header" },
		detailsBar(type, onClose),
		el("h2", { className: "details-title" }, entity.name),
		...(actions.length > 0 ? [el("div", { className: "details-actions" }, ...actions)] : []),
	);

	const section = (title: string, ...content: Node[]) => el("section", { className: "details-section" }, el("h3", {}, title), ...content);
	const rows = detailRows(store.data, entity, entityNames);
	const missing = new Set(missingRequired(type, entity).map((p) => p.name));
	const refTag = (name: string, entityId: string): HTMLElement => {
		const tag = el("button", { type: "button", className: "ref-tag", onclick: () => onSelectEntity(entityId) }, name);
		const color = types.get(entityTypes.get(entityId) ?? "")?.color;
		if (color) tag.style.background = color;
		return tag;
	};
	const value = (row: CardRow): HTMLElement => {
		if (row.values.length === 0) {
			return missing.has(row.label) ? el("dd", { className: "missing" }, text.missingValue) : el("dd", { className: "muted" }, "—");
		}
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
