import type { DataStore } from "../data/core.js";
import { createCardPreview, detailsPanel, type EntityPlaces } from "../data/ui.js";
import { traitRoute } from "../traits/ui.js";
import { text as traitText } from "../traits/texts.js";
import { text as dataText } from "../data/texts.js";
import { freeName, moveItem, nameTaken } from "../../shared/core/index.js";
import { downloadFile, el, emptyState, isRecord, listenWhileConnected, readPreference, refused, safeFileName, typeDot, writePreference, zipFiles, sharedText, type EntityLink, type PageMaker, type SearchSource, type UnitDescriber } from "../../shared/ui/index.js";
import {
	addAnalysis,
	analysisFrom,
	deleteAnalysis,
	groupingPaths,
	isRoleOption,
	normalizeLevel,
	nextOptions,
	pathOptions,
	resolvePath,
	rowTypeIds,
	runAnalysis,
	sameStep,
	updateAnalysis,
	type Analysis,
	type AnalysisGroup,
	type AnalysisRow,
	type AnalysisValue,
	type GroupLevel,
	type PathFrom,
	type PathOption,
	type PathStep,
} from "./core.js";
import { analysisMarkdownFiles, pathLabel, stepName } from "./export.js";
import { text } from "./texts.js";

/** The analysis open in the Analyses tab. */
const SELECTED_KEY = "analysis-selected";
/** Whether the analysis's setup is unfolded; folded, only a line telling it is left and the result moves up. */
const SETUP_OPEN_KEY = "analysis-setup-open";

/**
 * The Analyses tab: the saved analyses in a list, the analysis chosen set up above (the type or trait of its rows, the
 * paths it groups them by, the paths of its columns) and its result below — the rows in nested groups, a table per
 * group. The traits themselves are kept in the Data tab.
 * Hovering an entity named in the result shows its card; clicking it shows its details beside, like on a board, where
 * Edit shows its form instead, and the features' `entityLinks` and `entityPlaces` lead on to their pages.
 */
export function analysisView(
	store: DataStore,
	{ entityLinks = [], entityPlaces = [] }: { entityLinks?: readonly EntityLink[]; entityPlaces?: readonly EntityPlaces[] } = {},
): HTMLElement {
	const selected = (): Analysis | undefined => {
		const id = readPreference(SELECTED_KEY);
		return store.data.analyses.find((item) => item.id === id) ?? store.data.analyses[0];
	};
	const typeName = (id: string) => store.data.types.find((t) => t.id === id)?.name ?? "?";

	const content = el("div", { className: "analysis-content" });
	const main = el("div", { className: "analysis-main" }, content);
	const preview = createCardPreview(store, main);
	main.append(preview.element);
	main.addEventListener("scroll", preview.hide, { passive: true });
	/** The details of the entity clicked in the result; saving draws the result again (see onHistoryChange),
	 * keeping the form until it's done. */
	const details = detailsPanel(store, { onClose: () => showDetails(null), onSelectEntity: (id) => showDetails(id), links: entityLinks, places: entityPlaces });
	const view = el("div", { className: "analysis-view" }, main, details.handle, details.element);

	// Every change (here, or undone and redone) shows anew, keeping focus on the control it came from; the first
	// change after this view is gone stops listening (each visit of the page makes a new one).
	const stopWatching = store.onHistoryChange(() => (view.isConnected ? render() : stopWatching()));

	// Escape closes the details.
	listenWhileConnected(view, "keydown", (e) => {
		if (e.key === "Escape" && details.shown() !== null && !(e.target as Element).closest("input, select, textarea")) showDetails(null);
	});

	function render(): void {
		const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey;
		const current = selected();
		preview.hide(); // its link is about to be replaced
		content.replaceChildren(
			listSection(current),
			...(current ? [setupSection(current), resultSection(current)] : []),
		);
		// "New analysis" is right beside, in the list.
		if (!current) content.append(el("section", {}, emptyState(text.analysisEmpty)));
		if (focusKey) content.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus();
		showDetails(details.shown()); // the entity may have changed or been removed
	}

	/** Shows the entity's details beside the result (none: closes them), and marks its links there. */
	function showDetails(entityId: string | null): void {
		details.show(entityId);
		for (const link of content.querySelectorAll<HTMLElement>(".entity-link")) {
			link.classList.toggle("selected", link.dataset.entityId === details.shown());
		}
	}

	function listSection(current: Analysis | undefined): HTMLElement {
		const add = el(
			"button",
			{
				type: "button",
				onclick: () => {
					const item = addAnalysis(store, freeName(store.data.analyses, text.defaultAnalysisName));
					writePreference(SELECTED_KEY, item.id);
					writePreference(SETUP_OPEN_KEY, "true"); // a new one needs setting up
					render();
					view.querySelector<HTMLInputElement>(".analysis-setup input")?.select();
				},
			},
			text.newAnalysis,
		);
		const entries = el(
			"ul",
			{},
			...store.data.analyses.map((item) =>
				el(
					"li",
					{},
					el(
						"button",
						{
							type: "button",
							className: "analysis-entry",
							ariaCurrent: String(item.id === current?.id),
							onclick: () => {
								writePreference(SELECTED_KEY, item.id);
								render();
							},
						},
						item.name,
					),
				),
			),
		);
		return el(
			"section",
			{ className: "analysis-list" },
			el("div", { className: "section-header" }, el("h2", {}, text.analyses), add),
			entries,
		);
	}

	function setupSection(analysis: Analysis): HTMLElement {
		const update = (patch: Partial<Omit<Analysis, "id">>) => updateAnalysis(store, analysis.id, patch);
		const name = el("input", {
			value: analysis.name,
			ariaLabel: sharedText.name,
			onchange: () => {
				const taken = nameTaken(store.data.analyses, name.value, analysis.id);
				if (!refused(name, taken ? text.analysisNameTaken(name.value.trim()) : null)) update({ name: name.value });
			},
		});
		// A type's value is its id, a trait's "trait:" and its id.
		const rowType = el(
			"select",
			{
				ariaLabel: text.analysisRowType,
				onchange: () => {
					const [traitId] = rowType.value.startsWith("trait:") ? [rowType.value.slice(6)] : [];
					update({ typeId: traitId === undefined ? rowType.value || null : null, traitId: traitId ?? null, groups: [], columns: [] });
				},
			},
			el("option", { value: "" }, text.analysisPickType),
			el("optgroup", { label: text.analysisTypes }, ...store.data.types.map((t) => el("option", { value: t.id, selected: analysis.traitId === null && t.id === analysis.typeId }, t.name))),
			...(store.data.traits.length > 0
				? [el("optgroup", { label: traitText.traits }, ...store.data.traits.map((t) => el("option", { value: `trait:${t.id}`, selected: t.id === analysis.traitId }, t.name)))]
				: []),
		);
		rowType.dataset.focusKey = "row-type";
		const remove = el(
			"button",
			{
				type: "button",
				onclick: () => {
					if (confirm(text.confirmDeleteAnalysis(analysis.name))) deleteAnalysis(store, analysis.id);
				},
			},
			text.deleteAnalysis,
		);
		const from = analysisFrom(store.data, analysis);
		// Folded: the name and, in short, what the rows are, how they're grouped and their columns.
		const open = readPreference(SETUP_OPEN_KEY) === "true";
		const toggle = el(
			"button",
			{
				type: "button",
				title: text.setupHint,
				ariaExpanded: String(open),
				onclick: () => {
					writePreference(SETUP_OPEN_KEY, String(!open));
					render();
				},
			},
			open ? text.hideSetup : text.showSetup,
		);
		toggle.dataset.focusKey = "setup-toggle";
		const paths = (list: PathStep[][]) => (from ? list.map((path) => pathLabel(store.data, from, path)).join(", ") : "");
		const levels = (list: GroupLevel[]) =>
			from ? list.map((level) => pathLabel(store.data, from, level.path) + (level.hideEmpty ? ` (${text.onlyWithValue})` : "")).join(", ") : "";
		const trait = store.data.traits.find((t) => t.id === analysis.traitId);
		const basis = trait?.name ?? (analysis.typeId ? typeName(analysis.typeId) : "—");
		const summary = el(
			"p",
			{ className: "analysis-summary muted" },
			el("span", {}, `${text.analysisRowType}: `, el("strong", {}, basis)),
			...(analysis.groups.length > 0 ? [el("span", {}, `${text.analysisGroups}: ${levels(analysis.groups)}`)] : []),
			...(analysis.columns.length > 0 ? [el("span", {}, `${text.analysisColumns}: ${paths(analysis.columns)}`)] : []),
		);
		const body = el(
			"div",
			{ className: "analysis-setup-body" },
			el(
				"div",
				{ className: "analysis-meta" },
				el("label", { className: "field" }, el("span", {}, sharedText.name), name),
				el("label", { className: "field" }, el("span", {}, text.analysisRowType), rowType),
				// A trait is kept in the Data tab: a link there, to see or change what it means.
				...(trait ? [el("a", { href: traitRoute(trait.id), className: "trait-link" }, traitText.openTrait(trait.name))] : []),
				remove,
			),
			...(from
				? [
						pathList("groups", text.analysisGroups, text.analysisGroupsHint, text.addGroupLevel, analysis.groups, from, (groups) => update({ groups }), {
							pathOf: (level) => level.path,
							withPath: (level, path) => ({ ...level, path }),
							blank: { path: [], hideEmpty: false },
							// Whether the rows the level's path leads nowhere from are left out of the whole analysis.
							extra: (level, set, focusKey) => {
								const box = el("input", { type: "checkbox", checked: level.hideEmpty, onchange: () => set({ ...level, hideEmpty: box.checked }) });
								box.dataset.focusKey = focusKey;
								return el("label", { className: "checkbox-setting path-hide-empty", title: text.onlyWithValueHint }, box, ` ${text.onlyWithValue}`);
							},
						}),
						pathList("columns", text.analysisColumns, text.analysisColumnsHint, text.addColumn, analysis.columns, from, (columns) => update({ columns }), {
							pathOf: (path) => path,
							withPath: (_, path) => path,
							blank: [],
						}),
					]
				: []),
		);
		body.hidden = !open;
		return el(
			"section",
			{ className: open ? "analysis-setup open" : "analysis-setup" },
			el("div", { className: "analysis-setup-head" }, el("h2", {}, analysis.name), toggle),
			...(open ? [] : [summary]),
			body,
		);
	}

	/** The groups' levels or the columns, each a path (`pathOf`) editable, movable and removable, with what `extra`
	 * adds to it, and a button adding one (`blank`). */
	function pathList<T>(
		key: string,
		title: string,
		hint: string,
		addLabel: string,
		paths: T[],
		from: PathFrom,
		save: (paths: T[]) => void,
		{
			pathOf,
			withPath,
			blank,
			extra,
		}: { pathOf: (item: T) => PathStep[]; withPath: (item: T, path: PathStep[]) => T; blank: T; extra?: (item: T, set: (item: T) => void, focusKey: string) => HTMLElement },
	): HTMLElement {
		const add = el("button", { type: "button", onclick: () => save([...paths, blank]) }, `+ ${addLabel}`);
		add.dataset.focusKey = `${key}:add`;
		return el(
			"fieldset",
			{ className: "path-list" },
			el("legend", {}, title),
			el("p", { className: "muted path-hint" }, hint),
			el(
				"ol",
				{},
				...paths.map((item, i) => {
					const setItem = (next: T) => save(paths.map((p, j) => (j === i ? next : p)));
					const set = (next: PathStep[]) => setItem(withPath(item, next));
					const button = (label: string, symbol: string, focus: string, onclick: () => void, disabled = false) => {
						const b = el("button", { type: "button", className: "icon-button", title: label, ariaLabel: label, disabled, onclick }, symbol);
						b.dataset.focusKey = `${key}:${i}:${focus}`;
						return b;
					};
					return el(
						"li",
						{ className: "path-row" },
						pathEditor(`${key}:${i}`, pathOf(item), from, set),
						el(
							"div",
							{ className: "path-actions" },
							...(extra ? [extra(item, setItem, `${key}:${i}:extra`)] : []),
							button(text.moveUp, "↑", "up", () => save(moveItem(paths, i, i - 1)), i === 0),
							button(text.moveDown, "↓", "down", () => save(moveItem(paths, i, i + 1)), i === paths.length - 1),
							button(text.removePath, "✕", "remove", () => save(paths.filter((_, j) => j !== i))),
						),
					);
				}),
			),
			add,
		);
	}

	/** A path as a chain of selects, each offering the steps that can follow the one before; choosing a step anew
	 * drops the steps after it, which may not fit any more. A last, empty select adds a step. */
	function pathEditor(key: string, path: PathStep[], start: PathFrom, set: (path: PathStep[]) => void): HTMLElement {
		const resolved = resolvePath(store.data, start, path);
		const { broken } = resolved;
		const fitting = broken === null ? path.length : broken;
		const select = (index: number, current: PathStep | null) => {
			const choices = index === 0 ? pathOptions(store.data, start) : nextOptions(store.data, start, path.slice(0, index));
			const missing = current !== null && !choices.some((c) => sameStep(c.step, current));
			const input = el(
				"select",
				{
					ariaLabel: current ? stepLabel(choices.find((c) => sameStep(c.step, current))) : index === 0 ? text.pathFirstStep : text.pathNextStep,
					className: missing ? "invalid" : "",
					onchange: () => {
						const choice = choices[Number(input.value)];
						if (choice) set([...path.slice(0, index), choice.step]);
					},
				},
				...(current === null
					? [el("option", { value: "", selected: true }, index === 0 ? text.pathFirstStep : text.pathNextStep)]
					: missing
						? [el("option", { value: "", selected: true }, text.pathMissingStep)]
						: []),
				...choices.map((c, i) => el("option", { value: String(i), selected: current !== null && sameStep(c.step, current) }, stepLabel(c))),
			);
			input.dataset.focusKey = `${key}:step:${index}`;
			return input;
		};

		const selects: HTMLElement[] = [];
		for (const [index, step] of path.slice(0, fitting + (broken === null ? 0 : 1)).entries()) selects.push(select(index, step));
		// Another step can follow a fitting path whose last step leads to entities.
		if (broken === null && nextOptions(store.data, start, path, resolved).length > 0) selects.push(select(path.length, null));
		const shorten = el(
			"button",
			{ type: "button", className: "icon-button", title: text.removeLastStep, ariaLabel: text.removeLastStep, onclick: () => set(path.slice(0, -1)) },
			"⌫",
		);
		shorten.dataset.focusKey = `${key}:shorten`;
		return el(
			"div",
			{ className: "path-editor" },
			...selects.flatMap((s, i) => (i === 0 ? [s] : [el("span", { className: "path-arrow", ariaHidden: "true" }, "›"), s])),
			...(path.length > 1 || broken !== null ? [shorten] : []),
			...(broken !== null ? [el("p", { className: "error path-hint" }, text.pathBroken)] : []),
		);
	}

	/** How a step reads in a select: a property or role of the entity (and the types it leads to), or a property of
	 * another type referencing it. */
	function stepLabel(option: PathOption | undefined): string {
		if (!option) return text.pathMissingStep;
		const name = stepName(store.data.types, option);
		if (!isRoleOption(option) && option.step.direction === "inverse") return name;
		return option.typeIds.length > 0 ? `${name} → ${option.typeIds.map(typeName).join(" / ")}` : name;
	}

	function resultSection(analysis: Analysis): HTMLElement {
		const header = el("div", { className: "section-header" }, el("h2", {}, text.analysisResult));
		const section = el("section", { className: "analysis-result" }, header);
		const from = analysisFrom(store.data, analysis);
		if (!from) {
			section.append(el("p", { className: "muted" }, text.analysisChooseType));
			return section;
		}
		const trait = store.data.traits.find((t) => t.id === analysis.traitId);
		const basisName = trait?.name ?? typeName(analysis.typeId ?? "");
		const result = runAnalysis(store.data, analysis);
		if (result.count === 0) {
			// Rows there are, but the levels hiding those without a value left none.
			const hiding = analysis.groups.filter((level) => level.hideEmpty).map((level) => pathLabel(store.data, from, level.path));
			const rowTypes = new Set(rowTypeIds(store.data, analysis));
			const hidden = hiding.length > 0 && store.data.entities.some((e) => rowTypes.has(e.typeId));
			// No rows for good: the next step is making some (of the type), or giving the trait types to bear it.
			section.append(
				hidden
					? emptyState(text.analysisAllHidden(hiding.join(", ")))
					: trait
						? emptyState(text.analysisNoTraitRows(trait.name), { label: traitText.openTrait(trait.name), href: traitRoute(trait.id) })
						: emptyState(text.analysisNoRows(basisName), { label: dataText.createNewEntity, href: `#entities/new/${encodeURIComponent(analysis.typeId ?? "")}` }),
			);
			return section;
		}
		const exportMarkdown = () => {
			const date = new Date().toISOString().slice(0, 10);
			const files = analysisMarkdownFiles(store.data, analysis, date);
			if (files.length === 1) downloadFile(files[0]!.name, files[0]!.contents, "text/markdown;charset=utf-8");
			else downloadFile(`${safeFileName(analysis.name)} ${date}.zip`, zipFiles(files), "application/zip");
		};
		header.append(
			el("button", { type: "button", title: text.exportAnalysisMarkdownHint, onclick: exportMarkdown }, text.exportAnalysisMarkdown),
		);
		const levels = groupingPaths(store.data, from, analysis);
		const headers = [basisName, ...analysis.columns.map((path) => pathLabel(store.data, from, path))];
		section.append(el("p", { className: "muted" }, text.analysisCount(result.count)));
		section.append(...(result.groups.length > 0 ? groups(from, result.groups, levels, headers, 0) : [table(result.rows, headers)]));
		return section;
	}

	function groups(from: PathFrom, list: AnalysisGroup[], levels: PathStep[][], headers: string[], level: number): HTMLElement[] {
		const heading = `h${Math.min(3 + level, 6)}` as "h3" | "h4" | "h5" | "h6";
		return list.map((group) =>
			el(
				"div",
				{ className: "analysis-group" },
				el(
					heading,
					{},
					group.value ? valueView(group.value) : el("span", { className: "muted" }, text.analysisNoValue(pathLabel(store.data, from, levels[level]!))),
					el("span", { className: "muted analysis-count" }, text.analysisCount(group.count)),
				),
				...(group.groups.length > 0 ? groups(from, group.groups, levels, headers, level + 1) : [table(group.rows, headers)]),
			),
		);
	}

	/** The rows as a table: the entity, then a cell per column. Narrow screens show each row as a card (see CSS), with its
	 * column's name above every value. */
	function table(rows: AnalysisRow[], headers: string[]): HTMLElement {
		// The row's entity by name; what its columns lead to as tags in their types' colors, like on the cards.
		const cell = (values: AnalysisValue[], label: string, asTags: boolean) => {
			const content =
				values.length === 0
					? [el("span", { className: "muted" }, "—")]
					: asTags
						? [el("div", { className: "prop-chips" }, ...values.map((v) => valueView(v, true)))]
						: join(values.map((v) => valueView(v)));
			const td = el("td", {}, ...content);
			td.dataset.label = label;
			return td;
		};
		return el(
			"div",
			{ className: "table-wrap" },
			el(
				"table",
				{ className: "analysis-table" },
				el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", {}, h)))),
				el(
					"tbody",
					{},
					...rows.map((row) =>
						el(
							"tr",
							{},
							cell([{ label: row.entity.name, entityId: row.entity.id }], headers[0]!, false),
							...row.cells.map((values, i) => cell(values, headers[i + 1] ?? "", true)),
						),
					),
				),
			),
		);
	}

	/** An entity as a link (with its type's color as a dot, or `asTag` as a tag filled with it) showing its card while
	 * hovered and its details when clicked, or a text (as a chip with `asTag`). A span acting as a button, since a
	 * <button> never wraps inline: a long name would take a line of its own and push the comma after it onto the next. */
	function valueView(value: AnalysisValue, asTag = false): HTMLElement {
		const entity = value.entityId !== null ? store.data.entities.find((e) => e.id === value.entityId) : undefined;
		if (!entity) return el("span", asTag ? { className: "chip" } : {}, value.label);
		const color = store.data.types.find((t) => t.id === entity.typeId)?.color;
		const link = el(
			"span",
			{
				className: asTag ? "entity-link ref-tag" : "entity-link",
				role: "button",
				tabIndex: 0,
				onclick: () => showDetails(entity.id),
				onkeydown: (event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					showDetails(entity.id);
				},
			},
			...(color && !asTag ? [typeDot(color)] : []),
			entity.name,
		);
		if (color && asTag) link.style.background = color;
		link.dataset.entityId = entity.id;
		preview.attach(link, entity.id);
		return link;
	}

	render();
	return view;
}

/** The nodes with ", " between them. */
function join(nodes: HTMLElement[]): (HTMLElement | string)[] {
	return nodes.flatMap((node, i) => (i === 0 ? [node] : [", ", node]));
}

/** The address of an analysis. */
const analysisRoute = (analysisId: string) => `#analysis/${encodeURIComponent(analysisId)}`;

/** The Analyses tab, after the boards; in an entity's details, the features' `entityLinks` and `entityPlaces`.
 * `#analysis/<id>` shows that analysis — once per address, so another one can be chosen there. */
export function analysesPage(parts: { entityLinks?: readonly EntityLink[]; entityPlaces?: readonly EntityPlaces[] } = {}): PageMaker<DataStore> {
	return () => {
		let shownTarget: string | null = null;
		return {
			routes: ["analysis"],
			label: () => text.tabAnalysis,
			render: (store) => {
				const [, id] = location.hash.slice(1).split("/");
				const target = id ? decodeURIComponent(id) : null;
				if (target !== shownTarget) {
					shownTarget = target;
					if (target !== null && store.data.analyses.some((a) => a.id === target)) writePreference(SELECTED_KEY, target);
				}
				return analysisView(store, parts);
			},
		};
	};
}

/** In the search: the analyses, and a new one, opened with its setup unfolded. */
export const ANALYSIS_SEARCH: SearchSource<DataStore> = {
	items: (store) => store.data.analyses.map((a) => ({ label: a.name, detail: text.analysis, href: analysisRoute(a.id) })),
	actions: (store) => [
		{
			label: text.newAnalysis,
			run: () => {
				const item = addAnalysis(store, freeName(store.data.analyses, text.defaultAnalysisName));
				writePreference(SETUP_OPEN_KEY, "true");
				location.hash = analysisRoute(item.id);
			},
		},
	],
};

/** How the history tells of an analysis: the type (or trait) of its rows, the paths it groups by and those of its
 * columns, read with the types and traits as they are now. */
export const ANALYSIS_HISTORY: UnitDescriber<DataStore> = {
	kind: "analysis",
	area: "view",
	noun: text.historyAnalyses,
	read(value, store) {
		if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.groups) || !Array.isArray(value.columns)) return null;
		const typeId = typeof value.typeId === "string" ? value.typeId : null;
		const traitId = typeof value.traitId === "string" ? value.traitId : null;
		const from = analysisFrom(store.data, { typeId, traitId });
		const paths = (list: PathStep[][]) => (from === null ? "" : list.map((path) => pathLabel(store.data, from, path)).join(" / "));
		// A write before grouping levels hid rows (format 12) holds bare paths.
		const levels = value.groups.map(normalizeLevel);
		const levelText = from === null ? "" : levels.map((level) => pathLabel(store.data, from, level.path) + (level.hideEmpty ? ` (${text.onlyWithValue})` : "")).join(" / ");
		const basis = traitId !== null ? store.data.traits.find((t) => t.id === traitId) : typeId !== null ? store.data.types.find((t) => t.id === typeId) : null;
		return {
			name: value.name,
			fields: [
				{ label: text.analysisRowType, text: basis === null ? "" : (basis?.name ?? "?") },
				{ label: text.analysisGroups, text: levelText },
				{ label: text.analysisColumns, text: paths(value.columns as PathStep[][]) },
			],
		};
	},
};
