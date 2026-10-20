import { text } from "./i18n.js";
import { readPreference, writePreference } from "./preferences.js";

/** Creates an element with the given properties and children. Strings become text nodes, so user text is never parsed as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
}

/** Saves text as a file through the browser's download. */
export function downloadFile(fileName: string, contents: string | Uint8Array<ArrayBuffer>, type = "application/json"): void {
	const url = URL.createObjectURL(new Blob([contents], { type }));
	const link = el("a", { href: url, download: fileName });
	document.body.append(link); // some browsers only follow links in the page
	link.click();
	link.remove();
	// Revoked later, since some browsers start reading the file only after the click returns.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from user text: characters most systems forbid become "-". */
export function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "workspace";
}

/** A small colored circle marking an entity type. */
export function typeDot(color: string): HTMLElement {
	const dot = el("span", { className: "type-dot", ariaHidden: "true" });
	dot.style.background = color;
	return dot;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Like el(), for SVG elements: properties are set as attributes. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attributes: Record<string, string | number> = {},
	...children: (Node | string)[]
): SVGElementTagNameMap[K] {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
	node.append(...children);
	return node;
}

/** Pointer movement (in screen pixels) below which a press and release counts as a click, not a drag. */
export const CLICK_TOLERANCE = 3;

/**
 * Follows a pointer from pointerdown until release, reporting the movement in screen pixels. The pointer is
 * captured by `captureTarget` (default: the element the listener is on), which must stay in the page meanwhile.
 */
export function trackPointer(
	e: PointerEvent,
	onMove: (dx: number, dy: number, event: PointerEvent) => void,
	onEnd: (dx: number, dy: number) => void,
	captureTarget: Element = e.currentTarget as Element,
): void {
	const target = captureTarget;
	const startX = e.clientX;
	const startY = e.clientY;
	let dx = 0;
	let dy = 0;
	target.setPointerCapture(e.pointerId);
	const move = (ev: Event) => {
		dx = (ev as PointerEvent).clientX - startX;
		dy = (ev as PointerEvent).clientY - startY;
		onMove(dx, dy, ev as PointerEvent);
	};
	const end = () => {
		target.removeEventListener("pointermove", move);
		target.removeEventListener("pointerup", end);
		target.removeEventListener("pointercancel", end);
		onEnd(dx, dy);
	};
	target.addEventListener("pointermove", move);
	target.addEventListener("pointerup", end);
	target.addEventListener("pointercancel", end);
}

/** What a wheel event does on a canvas: zoom by a factor around the pointer, or pan by screen pixels. */
export type WheelGesture = { zoom: number } | { pan: { dx: number; dy: number } };

/** How much one notch of a mouse wheel zooms: about one 10% step. */
const WHEEL_NOTCH_ZOOM = 1.1;

/**
 * Turns a wheel event into a canvas gesture. A mouse wheel zooms, one gentle step per notch, while a trackpad's
 * two-finger scrolling pans and its pinch (sent as Ctrl + scroll) zooms along with the fingers. Shift + scroll pans
 * sideways.
 *
 * Browsers don't say which device sent the event, so it's guessed: a mouse wheel scrolls by lines, or by whole
 * notches (`wheelDeltaY` a multiple of 120, which trackpads report as -3 × deltaY), never sideways.
 */
export function wheelGesture(
	e: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "ctrlKey" | "metaKey" | "shiftKey"> & { wheelDeltaY?: number },
): WheelGesture {
	const scale = e.deltaMode === 1 ? 16 : 1; // DOM_DELTA_LINE
	const dx = e.deltaX * scale;
	const dy = e.deltaY * scale;
	if (e.shiftKey && !e.ctrlKey && !e.metaKey) return { pan: { dx: dx === 0 ? dy : dx, dy: 0 } };
	const notches = e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 && e.wheelDeltaY % 120 === 0;
	const trackpadRatio = e.wheelDeltaY !== undefined && Math.abs(e.wheelDeltaY + 3 * e.deltaY) < 1;
	const mouseWheel = e.deltaX === 0 && e.deltaY !== 0 && (e.deltaMode === 1 || (notches && !trackpadRatio));
	if (mouseWheel) return { zoom: WHEEL_NOTCH_ZOOM ** -Math.sign(dy) };
	if (e.ctrlKey || e.metaKey) return { zoom: Math.exp(-dy * 0.01) };
	return { pan: { dx, dy } };
}

/**
 * A handle beside a side panel that changes the panel's width: dragged, or with the arrow keys when focused; a
 * double-click goes back to the default width from the CSS. The width is remembered under `key` and applied as the
 * panel's `--panel-width`, clamped to `min`…`max` (in rem). `side` is the side of the handle the panel is on.
 */
export function resizeHandle(
	panel: HTMLElement,
	{ key, side, min, max }: { key: string; side: "left" | "right"; min: number; max: number },
): HTMLElement {
	const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
	const apply = (width: number | null) => {
		if (width === null) panel.style.removeProperty("--panel-width");
		else panel.style.setProperty("--panel-width", `${Math.round(Math.min(max * rem(), Math.max(min * rem(), width)))}px`);
	};
	const resize = (width: number | null) => {
		apply(width);
		writePreference(key, panel.style.getPropertyValue("--panel-width"));
	};
	const saved = parseFloat(readPreference(key) ?? "");
	if (saved > 0) apply(saved);

	const direction = side === "left" ? 1 : -1;
	return el("div", {
		className: "resize-handle",
		role: "separator",
		tabIndex: 0,
		ariaOrientation: "vertical",
		title: text.resizePanel,
		ariaLabel: text.resizePanel,
		onpointerdown: (e: PointerEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const start = panel.getBoundingClientRect().width;
			const handle = e.currentTarget as HTMLElement;
			handle.classList.add("dragging");
			trackPointer(
				e,
				(dx) => apply(start + direction * dx),
				() => {
					handle.classList.remove("dragging");
					resize(panel.getBoundingClientRect().width);
				},
			);
		},
		ondblclick: () => resize(null),
		onkeydown: (e: KeyboardEvent) => {
			const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
			if (step === 0) return;
			e.preventDefault();
			resize(panel.getBoundingClientRect().width + direction * step * rem());
		},
	});
}

/**
 * A select filtering by one of `tags` ("All tags" first), remembered under `key`; a remembered tag no longer in
 * use counts as none (tags differing only in case are the same). `onChange` gets the tag chosen, or null for all. Answers the select and the tag it starts with.
 */
export function tagFilter(
	tags: readonly string[],
	key: string,
	onChange: (tag: string | null) => void,
): { select: HTMLSelectElement; tag: string | null } {
	const saved = readPreference(key);
	const tag = tags.find((t) => t.toLocaleLowerCase() === saved?.toLocaleLowerCase()) ?? null;
	const select: HTMLSelectElement = el(
		"select",
		{
			ariaLabel: text.filterByTag,
			onchange: () => {
				writePreference(key, select.value);
				onChange(select.value || null);
			},
		},
		el("option", { value: "" }, text.allTags),
		...tags.map((t) => el("option", { value: t, selected: t === tag }, t)),
	);
	return { select, tag };
}
