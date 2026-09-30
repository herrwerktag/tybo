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
