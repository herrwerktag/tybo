import type { AppData } from "../../shared/core/index.js";
import { newReference, type Entity, type EntityType, type OptionDef, type PropertyDef } from "../data/core.js";
import type { Trait } from "./core.js";

/** The data of the traits' tests and the analyses of a trait: pitches, open questions, rules and job stories, each
 * with a status of its own; the trait Progress over pitches and questions (and job stories, through their pitch). */

const options = (id: string, name: string, labels: Record<string, string>): PropertyDef => ({
	id,
	name,
	kind: "options",
	options: Object.entries(labels).map(([id, label]): OptionDef => ({ id, label })),
	reference: null,
	cardDisplay: "list",
});
const reference = (id: string, name: string, typeIds: string[], multiple = false): PropertyDef => ({
	id,
	name,
	kind: "reference",
	options: [],
	reference: { ...newReference(typeIds), multiple },
	cardDisplay: "list",
});
const textProperty = (id: string, name: string): PropertyDef => ({ id, name, kind: "text", options: [], reference: null, cardDisplay: "list" });
const type = (id: string, name: string, properties: PropertyDef[]): EntityType => ({ id, name, properties, contentTemplate: "", color: "#dcdcdc" });
const entity = (id: string, typeId: string, name: string, values: Entity["values"] = {}, content = ""): Entity => ({
	id,
	typeId,
	name,
	content,
	description: "",
	tags: [],
	values,
});

/** Progress: a stand (open, in progress, done), a short text and what it belongs to. */
export const progress = (): Trait => ({
	id: "progress",
	name: "Fortschritt",
	roles: [
		{ id: "stand", name: "Stand", kind: "options", options: [{ id: "r-open", label: "offen" }, { id: "r-doing", label: "in Arbeit" }, { id: "r-done", label: "fertig" }] },
		{ id: "short", name: "Kurz", kind: "text", options: [] },
		{ id: "belongs", name: "gehört zu", kind: "reference", options: [] },
	],
	bindings: {
		pitch: {
			// "verworfen" stands for none.
			stand: { propertyId: "p-status", direction: "forward", values: { draft: "r-open", planned: "r-open", doing: "r-doing", closed: "r-done" } },
			short: { field: "content" },
		},
		question: {
			stand: { propertyId: "q-status", direction: "forward", values: { open: "r-open", answered: "r-done" } },
			short: { propertyId: "q-text", direction: "forward", values: {} },
		},
		// A job story belongs to the pitch planning it; its own stand is unbound.
		story: { belongs: { propertyId: "p-stories", direction: "inverse", values: {} } },
	},
});

export function progressModel(): Pick<AppData, "types" | "entities" | "traits"> {
	return {
		types: [
			type("pitch", "Pitch", [
				options("p-status", "Status", { draft: "Entwurf", planned: "geplant", doing: "in Arbeit", closed: "abgeschlossen", dropped: "verworfen" }),
				reference("p-stories", "Job Story", ["story"], true),
			]),
			type("question", "Offene Frage", [options("q-status", "Status", { open: "offen", answered: "beantwortet" }), reference("q-pitch", "Pitch", ["pitch"]), textProperty("q-text", "Frage")]),
			type("rule", "Regel", [options("r-status", "Status", { valid: "gültig" })]),
			type("story", "Job Story", []),
		],
		entities: [
			entity("traits", "pitch", "Traits", { "p-status": "draft", "p-stories": ["see"] }, "Bedeutungen"),
			entity("history", "pitch", "Verlauf", { "p-status": "closed" }),
			entity("story-mode", "pitch", "Story-Modus", { "p-status": "dropped" }),
			entity("naming", "question", "Wie heißen sie?", { "q-status": "open", "q-pitch": "traits", "q-text": "Trait oder Merkmal?" }),
			entity("where", "question", "Wo gepflegt?", { "q-status": "answered" }),
			entity("rule", "rule", "Regel 1", { "r-status": "valid" }),
			entity("see", "story", "Fortschritt sehen"),
		],
		traits: [progress()],
	};
}
