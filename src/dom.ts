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
