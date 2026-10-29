import type { EntityType, Store } from "../../legacy/core/index.js";
import { DETAILS_WIDTH_KEY, createCardPreview, entityDetails } from "../data/ui/entity-card.js";
import { showEntityEditor } from "../data/ui/entity-form.js";
import { text as legacyText } from "../../legacy/ui/i18n.js";
import { moveItem } from "../../shared/core/index.js";
import { downloadFile, el, readPreference, resizeHandle, safeFileName, typeDot, writePreference, zipFiles, type PageMaker } from "../../shared/ui/index.js";
import {
	addAnalysis,
	deleteAnalysis,
	pathOptions,
	resolvePath,
	runAnalysis,
	updateAnalysis,
	type Analysis,
	type AnalysisGroup,
	type AnalysisRow,
	type AnalysisValue,
	type PathOption,
	type PathStep,
} from "./core.js";
import { analysisMarkdownFiles, pathLabel } from "./export.js";
import { text as dataText } from "../data/texts.js";
import { text } from "./texts.js";

/** The analysis open in the Analyses tab. */
const SELECTED_KEY = "analysis-selected";

const sameStep = (a: PathStep, b: PathStep) => a.propertyId === b.propertyId && a.direction === b.direction;

/**
 * The Analyses tab: the saved analyses in a list, the one chosen set up above (the type of its rows, the paths it
 * groups them by, the paths of its columns) and its result below — the rows in nested groups, a table per group.
 * Hovering an entity named in the result shows its card; clicking it shows its details beside, like on a board, where
 * Edit shows its form instead.
 */
export function analysisView(store: Store): HTMLElement {
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
	/** The entity whose details are shown beside the result. */
	let shownEntityId: string | null = null;
	/** Whether the details panel shows the entity's form instead of its details. */
	let editing = false;
	const details = el("aside", { className: "details-panel", ariaLabel: legacyText.details });
	const detailsHandle = resizeHandle(details, { key: DETAILS_WIDTH_KEY, side: "right", min: 16, max: 40 });
	detailsHandle.classList.add("details-resize");
	const view = el("div", { className: "analysis-view" }, main, detailsHandle, details);

	// Every change (here, or undone and redone) shows anew, keeping focus on the control it came from.
	store.onHistoryChange(() => {
		if (view.isConnected) render();
	});

	// Escape closes the details (the listener removes itself once this view is gone).
	function onKeyDown(e: KeyboardEvent): void {
		if (!view.isConnected) return document.removeEventListener("keydown", onKeyDown);
		if (e.key === "Escape" && shownEntityId !== null && !(e.target as Element).closest("input, select, textarea")) showDetails(null);
	}
	document.addEventListener("keydown", onKeyDown);

	function render(): void {
		const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey;
		const current = selected();
		preview.hide(); // its link is about to be replaced
		content.replaceChildren(listSection(current), ...(current ? [setupSection(current), resultSection(current)] : []));
		if (!current) content.append(el("section", {}, el("p", { className: "muted" }, text.analysisEmpty)));
		if (focusKey) content.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus();
		showDetails(shownEntityId); // the entity may have changed or been removed
	}

	/** Shows the entity's details beside the result (none: closes them), and marks its links there. */
	function showDetails(entityId: string | null): void {
		const entity = entityId === null ? undefined : store.data.entities.find((e) => e.id === entityId);
		if (entity?.id !== shownEntityId) editing = false;
		shownEntityId = entity?.id ?? null;
		details.hidden = !entity;
		const type = entity && store.data.types.find((t) => t.id === entity.typeId);
		if (entity && type && editing) {
			// Saving draws the result again (see onHistoryChange), keeping the form until it's done.
			showEntityEditor(details, store, entity, type, {
				onClose: () => showDetails(null),
				onDone: () => {
					editing = false;
					showDetails(entity.id);
				},
			});
		} else {
			const edit = () => {
				editing = true;
				showDetails(shownEntityId);
			};
			details.replaceChildren(
				...(entity
					? entityDetails(store, entity, {
							actions: [el("button", { type: "button", onclick: edit }, dataText.edit)],
							onClose: () => showDetails(null),
							onSelectEntity: showDetails,
						})
					: []),
			);
		}
		for (const link of content.querySelectorAll<HTMLElement>(".entity-link")) {
			link.classList.toggle("selected", link.dataset.entityId === shownEntityId);
		}
	}

	function listSection(current: Analysis | undefined): HTMLElement {
		const add = el(
			"button",
			{
				type: "button",
				className: "primary",
				onclick: () => {
					const item = addAnalysis(store, text.defaultAnalysisName(store.data.analyses.length + 1));
					writePreference(SELECTED_KEY, item.id);
					render();
					view.querySelector<HTMLInputElement>(".analysis-setup input")?.select();
				},
			},
			text.newAnalysis,
		);
		return el(
			"section",
			{ className: "analysis-list" },
			el("div", { className: "section-header" }, el("h2", {}, text.analyses), add),
			el(
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
			),
		);
	}

	function setupSection(analysis: Analysis): HTMLElement {
		const update = (patch: Partial<Omit<Analysis, "id">>) => updateAnalysis(store, analysis.id, patch);
		const name = el("input", {
			value: analysis.name,
			ariaLabel: dataText.name,
			onchange: () => update({ name: name.value }),
		});
		const rowType = el(
			"select",
			{
				ariaLabel: text.analysisRowType,
				onchange: () => update({ typeId: rowType.value || null, groups: [], columns: [] }),
			},
			el("option", { value: "" }, text.analysisPickType),
			...store.data.types.map((t) => el("option", { value: t.id, selected: t.id === analysis.typeId }, t.name)),
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
		const typeId = analysis.typeId;
		const known = typeId !== null && store.data.types.some((t) => t.id === typeId);
		return el(
			"section",
			{ className: "analysis-setup" },
			el(
				"div",
				{ className: "analysis-meta" },
				el("label", { className: "field" }, el("span", {}, dataText.name), name),
				el("label", { className: "field" }, el("span", {}, text.analysisRowType), rowType),
				remove,
			),
			...(known
				? [
						pathList("groups", text.analysisGroups, text.analysisGroupsHint, text.addGroupLevel, analysis.groups, typeId, (groups) =>
							update({ groups }),
						),
						pathList("columns", text.analysisColumns, text.analysisColumnsHint, text.addColumn, analysis.columns, typeId, (columns) =>
							update({ columns }),
						),
					]
				: []),
		);
	}

	/** The paths of the groups or the columns, each editable, movable and removable, and a button adding one. */
	function pathList(
		key: string,
		title: string,
		hint: string,
		addLabel: string,
		paths: PathStep[][],
		typeId: string,
		save: (paths: PathStep[][]) => void,
	): HTMLElement {
		const add = el("button", { type: "button", onclick: () => save([...paths, []]) }, `+ ${addLabel}`);
		add.dataset.focusKey = `${key}:add`;
		return el(
			"fieldset",
			{ className: "path-list" },
			el("legend", {}, title),
			el("p", { className: "muted path-hint" }, hint),
			el(
				"ol",
				{},
				...paths.map((path, i) => {
					const set = (next: PathStep[]) => save(paths.map((p, j) => (j === i ? next : p)));
					const button = (label: string, symbol: string, focus: string, onclick: () => void, disabled = false) => {
						const b = el("button", { type: "button", className: "icon-button", title: label, ariaLabel: label, disabled, onclick }, symbol);
						b.dataset.focusKey = `${key}:${i}:${focus}`;
						return b;
					};
					return el(
						"li",
						{ className: "path-row" },
						pathEditor(`${key}:${i}`, path, typeId, set),
						el(
							"div",
							{ className: "path-actions" },
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
	function pathEditor(key: string, path: PathStep[], typeId: string, set: (path: PathStep[]) => void): HTMLElement {
		const { options, broken } = resolvePath(store.data.types, typeId, path);
		const fitting = broken === null ? path.length : broken;
		const select = (index: number, from: string[], current: PathStep | null) => {
			const choices = pathOptions(store.data.types, from);
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

		let from = [typeId];
		const selects: HTMLElement[] = [];
		for (const [index, step] of path.slice(0, fitting + (broken === null ? 0 : 1)).entries()) {
			selects.push(select(index, from, step));
			from = options[index]?.typeIds ?? [];
		}
		// Another step can follow a fitting path whose last step leads to entities.
		if (broken === null && from.length > 0 && pathOptions(store.data.types, from).length > 0) selects.push(select(path.length, from, null));
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

	/** How a step reads in a select: a property of the entity (and the types it leads to), or one of another type
	 * referencing it. */
	function stepLabel(option: PathOption | undefined): string {
		if (!option) return text.pathMissingStep;
		if (option.step.direction === "inverse") {
			return option.prop.reference?.inverseLabel || text.inverseStep(typeName(option.ownerTypeId), option.prop.name);
		}
		return option.typeIds.length > 0 ? `${option.prop.name} → ${option.typeIds.map(typeName).join(" / ")}` : option.prop.name;
	}

	function resultSection(analysis: Analysis): HTMLElement {
		const header = el("div", { className: "section-header" }, el("h2", {}, text.analysisResult));
		const section = el("section", { className: "analysis-result" }, header);
		const type = store.data.types.find((t) => t.id === analysis.typeId);
		if (!type) {
			section.append(el("p", { className: "muted" }, text.analysisChooseType));
			return section;
		}
		const result = runAnalysis(store.data, analysis);
		if (result.count === 0) {
			section.append(el("p", { className: "muted" }, text.analysisNoRows(type.name)));
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
		const levels = analysis.groups.filter((path) => path.length > 0 && resolvePath(store.data.types, type.id, path).broken === null);
		const headers = [type.name, ...analysis.columns.map((path) => pathLabel(store.data.types, type.id, path))];
		section.append(el("p", { className: "muted" }, text.analysisCount(result.count)));
		section.append(...(result.groups.length > 0 ? groups(type, result.groups, levels, headers, 0) : [table(type, result.rows, headers)]));
		return section;
	}

	function groups(type: EntityType, list: AnalysisGroup[], levels: PathStep[][], headers: string[], level: number): HTMLElement[] {
		const heading = `h${Math.min(3 + level, 6)}` as "h3" | "h4" | "h5" | "h6";
		return list.map((group) =>
			el(
				"div",
				{ className: "analysis-group" },
				el(
					heading,
					{},
					group.value ? valueView(group.value) : el("span", { className: "muted" }, text.analysisNoValue(pathLabel(store.data.types, type.id, levels[level]!))),
					el("span", { className: "muted analysis-count" }, text.analysisCount(group.count)),
				),
				...(group.groups.length > 0 ? groups(type, group.groups, levels, headers, level + 1) : [table(type, group.rows, headers)]),
			),
		);
	}

	/** The rows as a table: the entity, then a cell per column. Narrow screens show each row as a card (see CSS), with its
	 * column's name above every value. */
	function table(type: EntityType, rows: AnalysisRow[], headers: string[]): HTMLElement {
		const cell = (values: AnalysisValue[], label: string) => {
			const td = el("td", {}, ...(values.length > 0 ? join(values.map(valueView)) : ["—"]));
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
							cell([{ label: row.entity.name, entityId: row.entity.id }], type.name),
							...row.cells.map((values, i) => cell(values, headers[i + 1] ?? "")),
						),
					),
				),
			),
		);
	}

	/** An entity as a link (with its type's color) showing its card while hovered and its details when clicked, or a
	 * text. */
	function valueView(value: AnalysisValue): HTMLElement {
		const entity = value.entityId !== null ? store.data.entities.find((e) => e.id === value.entityId) : undefined;
		if (!entity) return el("span", {}, value.label);
		const color = store.data.types.find((t) => t.id === entity.typeId)?.color;
		const link = el(
			"button",
			{ type: "button", className: "entity-link", onclick: () => showDetails(entity.id) },
			...(color ? [typeDot(color)] : []),
			entity.name,
		);
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

/** The Analyses tab, after the boards. */
export const ANALYSES_PAGE: PageMaker<Store> = () => ({ routes: ["analysis"], label: () => text.tabAnalysis, render: analysisView });
