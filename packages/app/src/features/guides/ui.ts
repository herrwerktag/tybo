import { el, emptyState, isRecord, renderMarkdown, sharedText, type PageMaker, type UnitDescriber } from "../../shared/ui/index.js";
import { setGuide, type GuideStore } from "./core.js";
import { text } from "./texts.js";

/**
 * The Guide tab (#guide): the workspace's guide, read as written in Markdown, and changed on the same page — Edit
 * puts a form in its place (which holds off someone else's changes while it's open, like every form). Without a
 * guide, the page says what belongs here and leads to writing it.
 */
export function guidePage(): PageMaker<GuideStore> {
	return (shell) => {
		/** The store the page last started afresh for. */
		let shownStore: GuideStore | null = null;
		/** The text being written, while the form is open. */
		let draft: string | null = null;
		let focusForm = false;

		const edit = (store: GuideStore) => {
			draft = store.data.guide;
			focusForm = true;
			shell.rerender();
		};

		function form(store: GuideStore): HTMLElement {
			const area = el("textarea", {
				rows: 24,
				value: draft ?? "",
				oninput: () => {
					draft = area.value;
				},
			});
			return el(
				"form",
				{
					id: "guide-form",
					className: "card",
					onsubmit: (e) => {
						e.preventDefault();
						setGuide(store, area.value);
						draft = null;
						shell.rerender();
					},
				},
				el("label", { className: "field wide" }, el("span", {}, text.guideText), area),
				el("p", { className: "muted guide-hint" }, text.guideHint),
				el(
					"div",
					{ className: "row form-actions" },
					el("button", { type: "submit", className: "primary" }, sharedText.save),
					el(
						"button",
						{
							type: "button",
							onclick: () => {
								draft = null;
								shell.rerender();
							},
						},
						sharedText.cancel,
					),
				),
			);
		}

		return {
			routes: ["guide"],
			label: () => text.tabGuide,
			render(store) {
				if (store !== shownStore) {
					// Another workspace (or the first): nothing of the one before is being written here.
					shownStore = store;
					draft = null;
				}
				const guide = store.data.guide;
				const editButton = el("button", { type: "button", onclick: () => edit(store) }, text.editGuide);
				return el(
					"div",
					{ className: "guide-view" },
					// Without a guide, the empty page offers the button.
					el("div", { className: "section-header" }, el("h2", {}, text.guide), ...(draft === null && guide !== "" ? [editButton] : [])),
					draft !== null
						? form(store)
						: guide !== ""
							? el("article", { className: "guide-text" }, renderMarkdown(guide))
							: emptyState(text.noGuideYet, { label: text.writeGuide, run: () => edit(store) }),
				);
			},
			afterRender(root) {
				if (!focusForm) return;
				focusForm = false;
				root.querySelector<HTMLTextAreaElement>("#guide-form textarea")?.focus();
			},
		};
	};
}

/** How the history tells of the workspace's guide: its text, the one before to unfold. */
export const GUIDE_HISTORY: UnitDescriber<GuideStore> = {
	kind: "guide",
	area: "data",
	noun: text.historyGuides,
	read(value) {
		if (!isRecord(value) || typeof value.text !== "string") return null;
		return { name: text.historyGuideName, fields: [{ label: text.historyGuideText, text: value.text, long: true }] };
	},
};
