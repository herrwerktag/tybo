import "./test-dom.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "./markdown.js";

const html = (source: string) => renderMarkdown(source).innerHTML;

test("paragraphs are split by blank lines and keep their line breaks", () => {
	assert.equal(html("One\ntwo\n\nThree"), "<p>One<br>two</p><p>Three</p>");
});

test("headings start at h4, below the details panel's own headings", () => {
	assert.equal(html("# Title\n### Sub"), "<h4>Title</h4><h6>Sub</h6>");
});

test("inline bold, italic, code and nesting", () => {
	assert.equal(html("**bold** and *it* and `a*b*` and __b _i_ b__"), "<p><strong>bold</strong> and <em>it</em> and <code>a*b*</code> and <strong>b <em>i</em> b</strong></p>");
	assert.equal(html("snake_case_name stays"), "<p>snake_case_name stays</p>");
});

test("bulleted and numbered lists, with continuation lines", () => {
	assert.equal(html("- a\n  more\n- b"), "<ul><li>a<br>more</li><li>b</li></ul>");
	assert.equal(html("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
});

test("quotes, rules and fenced code", () => {
	assert.equal(html("> **q**\n> r"), "<blockquote><p><strong>q</strong><br>r</p></blockquote>");
	assert.equal(html("a\n\n---\n\nb"), "<p>a</p><hr><p>b</p>");
	assert.equal(html("```\n# not a heading\n  *x*\n```"), "<pre><code># not a heading\n  *x*</code></pre>");
});

test("links open in a new tab; only http(s) and mailto become links", () => {
	assert.equal(html("[site](https://example.com)"), '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a></p>');
	assert.equal(html("[bad](javascript:void0)"), "<p><span>bad</span></p>");
});

test("bare addresses become links, without trailing punctuation; www. ones get https", () => {
	const a = (href: string, label = href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
	assert.equal(html("see www.google.de."), `<p>see ${a("https://www.google.de", "www.google.de")}.</p>`);
	assert.equal(html("(https://x.org/a_b_c)"), `<p>(${a("https://x.org/a_b_c")})</p>`);
	assert.equal(html("[www.x.de](https://x.de)"), `<p>${a("https://x.de", "www.x.de")}</p>`);
	assert.equal(html("awww.x.de"), "<p>awww.x.de</p>");
});

test("HTML in the text stays text", () => {
	assert.equal(html('<img src=x onerror="alert(1)">'), "<p>&lt;img src=x onerror=\"alert(1)\"&gt;</p>");
});
