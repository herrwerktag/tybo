import { el } from "./dom.js";

/**
 * Renders a small, common subset of Markdown as DOM nodes: headings, paragraphs, bulleted and numbered lists,
 * quotes, fenced code, horizontal rules, and inline **bold**, *italic*, `code` and [links](https://…).
 * Text only ever becomes text nodes (never HTML), and links are limited to http(s) and mailto.
 * `{{name}}` placeholders become what `placeholder` returns for them; without one, or where it returns null, and in
 * code and link labels, they stay as typed.
 */
export function renderMarkdown(source: string, placeholder?: Placeholder): HTMLElement {
	return el("div", { className: "markdown" }, ...blocks(source.replace(/\r\n?/g, "\n").split("\n"), placeholder));
}

/** The nodes a `{{name}}` placeholder stands for; null keeps it as typed. */
export type Placeholder = (name: string) => Node[] | null;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

function blocks(lines: string[], placeholder: Placeholder | undefined): HTMLElement[] {
	const out: HTMLElement[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const code: string[] = [];
			for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) code.push(lines[i]!);
			i++; // the closing fence (if any)
			out.push(el("pre", {}, el("code", {}, code.join("\n"))));
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			// The details panel already uses h2/h3, so Markdown headings start at h4.
			const level = Math.min(heading[1]!.length + 3, 6) as 4 | 5 | 6;
			out.push(el(`h${level}`, {}, ...inline(heading[2]!, placeholder)));
			i++;
			continue;
		}
		if (RULE.test(line)) {
			out.push(el("hr"));
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			const quoted: string[] = [];
			for (; i < lines.length && QUOTE.test(lines[i]!); i++) quoted.push(lines[i]!.replace(QUOTE, ""));
			out.push(el("blockquote", {}, ...blocks(quoted, placeholder)));
			continue;
		}
		const marker = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
		if (marker) {
			const items: string[][] = [];
			for (; i < lines.length; i++) {
				const next = lines[i]!;
				if (marker.test(next)) items.push([next.replace(marker, "")]);
				else if (next.trim() && /^\s/.test(next) && !BULLET.test(next) && !NUMBERED.test(next)) items.at(-1)!.push(next.trim());
				else break;
			}
			const start = marker === NUMBERED ? Number.parseInt(line, 10) : 1;
			const list = el(marker === NUMBERED ? "ol" : "ul", {}, ...items.map((item) => el("li", {}, ...withBreaks(item, placeholder))));
			if (list instanceof HTMLOListElement && start !== 1) list.start = start;
			out.push(list);
			continue;
		}
		const paragraph: string[] = [];
		for (; i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!); i++) paragraph.push(lines[i]!.trim());
		out.push(el("p", {}, ...withBreaks(paragraph, placeholder)));
	}
	return out;
}

function startsBlock(line: string): boolean {
	return [HEADING, FENCE, RULE, QUOTE, BULLET, NUMBERED].some((pattern) => pattern.test(line));
}

/** Lines of one paragraph or list item, kept on their own lines (as the plain-text description showed them). */
function withBreaks(lines: string[], placeholder: Placeholder | undefined): Node[] {
	return lines.flatMap((line, i) => (i === 0 ? inline(line, placeholder) : [el("br"), ...inline(line, placeholder)]));
}

/**
 * `code`, [text](url), bare https://… or www.… addresses (without trailing punctuation), **bold** / __bold__,
 * *italic* / _italic_ and {{placeholders}}; the first one found wins.
 */
const INLINE =
	/`([^`]+)`|\{\{([^{}]+)\}\}|\[([^\]]+)\]\(([^)\s]+)\)|\b((?:https?:\/\/|www\.)[^\s<>]*[^\s<>.,;:!?)\]'"])|\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)\*|\b_(?!\s)(.+?)_\b/;

/** With `links` false (inside a link's label), addresses stay text, since links can't be nested. */
function inline(text: string, placeholder: Placeholder | undefined, links = true): Node[] {
	const out: Node[] = [];
	let rest = text;
	for (let match = INLINE.exec(rest); match; match = INLINE.exec(rest)) {
		if (match.index > 0) out.push(document.createTextNode(rest.slice(0, match.index)));
		const [whole, code, name, label, href, url, bold1, bold2, italic1, italic2] = match;
		if (code !== undefined) out.push(el("code", {}, code));
		else if (name !== undefined) out.push(...(placeholder?.(name) ?? [document.createTextNode(whole)]));
		else if (label !== undefined) out.push(link(label, href!));
		else if (url !== undefined) out.push(links ? link(url, /^www\./i.test(url) ? `https://${url}` : url) : document.createTextNode(url));
		else if (bold1 !== undefined || bold2 !== undefined) out.push(el("strong", {}, ...inline((bold1 ?? bold2)!, placeholder, links)));
		else out.push(el("em", {}, ...inline((italic1 ?? italic2)!, placeholder, links)));
		rest = rest.slice(match.index + whole.length);
	}
	if (rest) out.push(document.createTextNode(rest));
	return out;
}

/** A link that opens in a new tab; other schemes (javascript: etc.) stay plain text. Placeholders in its label stay as
 * typed, as they may become buttons. */
function link(label: string, href: string): Node {
	if (!/^(https?:|mailto:)/i.test(href)) return el("span", {}, ...inline(label, undefined, false));
	return el("a", { href, target: "_blank", rel: "noopener noreferrer" }, ...inline(label, undefined, false));
}
