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

test("tables: a header, its alignment from the delimiter row, and inline formatting in cells", () => {
	assert.equal(
		html("| Typ | Anzahl | Status |\n| :-- | --: | :-: |\n| **Idee** | 26 | `offen` |"),
		'<div class="table-wrap"><table><thead><tr><th style="text-align: left;">Typ</th><th style="text-align: right;">Anzahl</th><th style="text-align: center;">Status</th></tr></thead>' +
			'<tbody><tr><td style="text-align: left;"><strong>Idee</strong></td><td style="text-align: right;">26</td><td style="text-align: center;"><code>offen</code></td></tr></tbody></table></div>',
	);
});

test("tables: outer pipes are optional, \\| is a pipe, rows get the header's cells, a header alone has no body", () => {
	assert.equal(
		html("a | b\n--- | ---\nx \\| y\n1 | 2 | 3"),
		'<div class="table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>x | y</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table></div>',
	);
	assert.equal(html("| a |\n| - |"), '<div class="table-wrap"><table><thead><tr><th>a</th></tr></thead></table></div>');
});

test("tables end at a blank line or another block, and may follow a paragraph or sit in a quote", () => {
	const table = (body: string) => `<div class="table-wrap"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody>${body}</tbody></table></div>`;
	assert.equal(html("Intro\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter"), `<p>Intro</p>${table("<tr><td>1</td><td>2</td></tr>")}<p>After</p>`);
	assert.equal(html("| a | b |\n|---|---|\n| 1 | 2 |\n- item"), `${table("<tr><td>1</td><td>2</td></tr>")}<ul><li>item</li></ul>`);
	assert.equal(html("> | a | b |\n> |---|---|\n> | 1 | 2 |"), `<blockquote>${table("<tr><td>1</td><td>2</td></tr>")}</blockquote>`);
});

test("without a delimiter row of as many cells, pipes stay text", () => {
	assert.equal(html("Eingang | Ausgang\nrot | grün"), "<p>Eingang | Ausgang<br>rot | grün</p>");
	assert.equal(html("| a | b |\n| --- |"), "<p>| a | b |<br>| --- |</p>");
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

test("placeholders become the resolver's nodes, also in lists and bold; unknown ones, code and link labels keep the text", () => {
	const resolve = (name: string) => (name === "Owner" ? [document.createTextNode("Ann")] : null);
	const withValues = (source: string) => renderMarkdown(source, resolve).innerHTML;
	assert.equal(withValues("By {{Owner}}, {{Typo}}"), "<p>By Ann, {{Typo}}</p>");
	assert.equal(withValues("- **{{Owner}}**"), "<ul><li><strong>Ann</strong></li></ul>");
	assert.equal(withValues("`{{Owner}}`"), "<p><code>{{Owner}}</code></p>");
	assert.equal(withValues("[{{Owner}}](https://x.de)"), '<p><a href="https://x.de" target="_blank" rel="noopener noreferrer">{{Owner}}</a></p>');
	assert.equal(html("By {{Owner}}"), "<p>By {{Owner}}</p>");
	assert.equal(withValues("| By |\n| -- |\n| {{Owner}} |"), '<div class="table-wrap"><table><thead><tr><th>By</th></tr></thead><tbody><tr><td>Ann</td></tr></tbody></table></div>');
});
