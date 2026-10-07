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
export function downloadFile(fileName: string, contents: string, type = "application/json"): void {
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
