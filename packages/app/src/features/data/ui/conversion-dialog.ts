import { el, sharedText } from "../../../shared/ui/index.js";
import {
	conversionPreview,
	conversionTargets,
	optionLabel,
	referencedIds,
	type ConversionAssignment,
	type DataStore,
	type Entity,
	type EntityType,
	type PropertyDef,
	type PropertyValue,
} from "../core.js";
import { text } from "../texts.js";

interface ConversionState {
	entity: Entity;
	sourceType: EntityType;
	targetType: EntityType | null;
	assignments: Record<string, ConversionAssignment>;
}

/**
 * Converts an entity without replacing it. The returned dialog belongs somewhere on the page; `button` opens it for
 * an entity. The target starts unchosen; compatible properties with the same name are then assigned automatically.
 */
export function conversionDialog(
	store: DataStore,
	{ onConverted }: { onConverted: (entityId: string, targetTypeId: string) => void },
): { dialog: HTMLDialogElement; button: (entity: Entity) => HTMLButtonElement } {
	const dialog = el("dialog", {
		className: "conversion-dialog",
		ariaLabel: text.convertEntity,
		onclick: (event: MouseEvent) => {
			if (event.target === dialog) dialog.close();
		},
	});
	let state: ConversionState | null = null;

	const hasValue = (value: PropertyValue | undefined): boolean =>
		value !== null && value !== undefined && (typeof value === "string" ? value.trim() !== "" : value.length > 0);

	function formatValue(property: PropertyDef, value: PropertyValue): string {
		if (value === null) return "";
		if (property.kind === "reference") {
			return referencedIds(property, value)
				.map((id) => store.data.entities.find((entity) => entity.id === id)?.name ?? "?")
				.join(", ");
		}
		if (property.kind === "options" && typeof value === "string") return optionLabel(property, value) ?? "?";
		return typeof value === "string" ? value : value.join(", ");
	}

	/** Assigns like-named compatible properties; a like-named target option is preselected too. */
	function initialAssignments(entity: Entity, sourceType: EntityType, targetType: EntityType): Record<string, ConversionAssignment> {
		const assignments: Record<string, ConversionAssignment> = {};
		for (const property of sourceType.properties) {
			const value = entity.values[property.id];
			if (value === null || value === undefined) continue;
			const candidates = conversionTargets(store.data, entity.id, targetType.id, property);
			const target = candidates.find((candidate) => candidate.name.trim().toLocaleLowerCase() === property.name.trim().toLocaleLowerCase());
			if (!target) continue;
			const sourceOption = property.kind === "options" && typeof value === "string" ? optionLabel(property, value) : null;
			const option = sourceOption === null ? undefined : target.options.find((o) => o.label === sourceOption);
			assignments[property.id] = { propertyId: target.id, ...(option ? { optionId: option.id } : {}) };
		}
		return assignments;
	}

	function open(entityId: string): void {
		const entity = store.data.entities.find((e) => e.id === entityId);
		const sourceType = store.data.types.find((type) => type.id === entity?.typeId);
		if (!entity || !sourceType || store.data.types.length < 2) return;
		state = { entity, sourceType, targetType: null, assignments: {} };
		draw();
		if (!dialog.open) dialog.showModal();
		dialog.querySelector<HTMLSelectElement>(".conversion-target-type")?.focus();
	}

	function draw(): void {
		if (!state) return;
		const { entity, sourceType, targetType, assignments } = state;
		const typeChoice = el(
			"select",
			{
				className: "conversion-target-type",
				ariaLabel: text.conversionTargetType,
				required: true,
				onchange: () => {
					if (!state) return;
					const target = store.data.types.find((type) => type.id === typeChoice.value) ?? null;
					state = {
						...state,
						targetType: target,
						assignments: target ? initialAssignments(entity, sourceType, target) : {},
					};
					draw();
				},
			},
			el("option", { value: "", selected: targetType === null }, text.conversionTargetTypePlaceholder),
			...store.data.types
				.filter((type) => type.id !== sourceType.id)
				.map((type) => el("option", { value: type.id, selected: type.id === targetType?.id }, type.name)),
		);

		const rows: HTMLElement[] = [];
		if (targetType) {
			for (const property of sourceType.properties) {
				const value = entity.values[property.id];
				if (!hasValue(value)) continue;
				const candidates = conversionTargets(store.data, entity.id, targetType.id, property);
				const assignment = assignments[property.id];
				const selectedTarget = candidates.find((candidate) => candidate.id === assignment?.propertyId);
				const usedElsewhere = new Set(
					Object.entries(assignments)
						.filter(([sourceId]) => sourceId !== property.id)
						.map(([, assigned]) => assigned.propertyId),
				);
				const targetChoice = el(
					"select",
					{
						className: "conversion-property-target",
						ariaLabel: text.conversionTargetFor(property.name),
						onchange: () => {
							if (!state) return;
							const next = { ...state.assignments };
							delete next[property.id];
							if (targetChoice.value) {
								const target = candidates.find((candidate) => candidate.id === targetChoice.value);
								if (target) {
									for (const [sourceId, other] of Object.entries(next)) {
										if (other.propertyId === target.id) delete next[sourceId];
									}
									const sourceOption = property.kind === "options" && typeof value === "string" ? optionLabel(property, value) : null;
									const option = sourceOption === null ? undefined : target.options.find((o) => o.label === sourceOption);
									next[property.id] = { propertyId: target.id, ...(option ? { optionId: option.id } : {}) };
								}
							}
							state = { ...state, assignments: next };
							draw();
						},
					},
					el("option", { value: "", selected: !selectedTarget }, text.conversionDoNotTransfer),
					...candidates.map((candidate) =>
						el(
							"option",
							{
								value: candidate.id,
								selected: candidate.id === selectedTarget?.id,
								disabled: usedElsewhere.has(candidate.id),
							},
							candidate.name,
						),
					),
				);
				targetChoice.dataset.sourceProperty = property.id;
				const controls = [targetChoice];
				if (property.kind === "options" && selectedTarget) {
					const optionChoice = el(
						"select",
						{
							className: "conversion-option-target",
							ariaLabel: text.conversionOptionFor(property.name),
							required: true,
							onchange: () => {
								if (!state) return;
								state = {
									...state,
									assignments: {
										...state.assignments,
										[property.id]: { propertyId: selectedTarget.id, ...(optionChoice.value ? { optionId: optionChoice.value } : {}) },
									},
								};
								draw();
							},
						},
						el("option", { value: "", selected: !assignment?.optionId }, text.conversionTargetOptionPlaceholder),
						...selectedTarget.options.map((option) =>
							el("option", { value: option.id, selected: option.id === assignment?.optionId }, option.label),
						),
					);
					optionChoice.dataset.sourceProperty = property.id;
					controls.push(optionChoice);
				}
				rows.push(
					el(
						"div",
						{ className: "conversion-row" },
						el(
							"div",
							{ className: "conversion-source" },
							el("strong", {}, property.name),
							el("span", { className: "conversion-current-value" }, formatValue(property, value!)),
						),
						el("div", { className: "conversion-target" }, ...controls),
						...(candidates.length === 0 ? [el("p", { className: "conversion-note" }, text.conversionNoTarget)] : []),
					),
				);
			}
		}

		const preview = targetType ? conversionPreview(store.data, entity.id, targetType.id, assignments) : null;
		const lossSections: HTMLElement[] = [];
		if (preview && preview.lostValues.length > 0) {
			lossSections.push(
				el(
					"section",
					{ className: "conversion-loss conversion-lost-values" },
					el("h3", {}, text.conversionLostValues),
					el(
						"ul",
						{},
						...preview.lostValues.map(({ property, value }) => el("li", {}, `${property.name}: ${formatValue(property, value)}`)),
					),
				),
			);
		}
		if (preview && preview.lostReferences.length > 0) {
			lossSections.push(
				el(
					"section",
					{ className: "conversion-loss conversion-lost-references" },
					el("h3", {}, text.conversionLostReferences),
					el(
						"ul",
						{},
						...preview.lostReferences.map(({ entity: other, property }) =>
							el("li", {}, `${other.name} → ${property.name}`),
						),
					),
				),
			);
		}

		const form = el(
			"form",
			{
				className: "conversion-form",
				onsubmit: (event) => {
					event.preventDefault();
					if (!state?.targetType) return;
					const currentEntity = store.data.entities.find((e) => e.id === state!.entity.id);
					const currentSource = store.data.types.find((type) => type.id === state!.sourceType.id);
					const currentTarget = store.data.types.find((type) => type.id === state!.targetType!.id);
					// Live updates normally pause while a dialog is open. Still never apply an old mapping to newer definitions.
					if (currentEntity !== state.entity || currentSource !== state.sourceType || currentTarget !== state.targetType) {
						open(state.entity.id);
						alert(text.conversionChanged);
						return;
					}
					const current = conversionPreview(store.data, state.entity.id, state.targetType.id, state.assignments);
					if (!current) return;
					const losses = current.lostValues.length + current.lostReferences.length;
					if (losses > 0 && !confirm(text.confirmConversion(current.lostValues.length, current.lostReferences.length))) return;
					const targetTypeId = state.targetType.id;
					store.convertEntity(state.entity.id, targetTypeId, state.assignments);
					dialog.close();
					onConverted(state.entity.id, targetTypeId);
				},
			},
			el("label", { className: "field" }, el("span", {}, text.conversionTargetType), typeChoice),
			...(targetType && rows.length === 0 ? [el("p", { className: "muted" }, text.conversionNoValues)] : []),
			...(rows.length > 0 ? [el("div", { className: "conversion-mapping" }, ...rows)] : []),
			...lossSections,
			el(
				"div",
				{ className: "row form-actions" },
				el("button", { type: "submit", className: "primary", disabled: !targetType }, text.convert),
				el("button", { type: "button", onclick: () => dialog.close() }, sharedText.cancel),
			),
		);
		dialog.replaceChildren(
			el(
				"header",
				{},
				el("h2", {}, text.conversionTitle(entity.name)),
				el("button", { type: "button", className: "card-remove", title: text.close, ariaLabel: text.close, onclick: () => dialog.close() }, "×"),
			),
			form,
		);
	}

	return {
		dialog,
		button: (entity) => {
			const none = store.data.types.every((type) => type.id === entity.typeId);
			return el(
				"button",
				{
					type: "button",
					className: "entity-convert",
					disabled: none,
					title: none ? text.conversionNoOtherType : text.convertEntityHint,
					onclick: () => open(entity.id),
				},
				text.convertEntity,
			);
		},
	};
}
