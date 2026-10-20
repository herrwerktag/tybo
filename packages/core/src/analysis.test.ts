import assert from "node:assert/strict";
import { test } from "node:test";
import { pathOptions, resolvePath, runAnalysis, type AnalysisGroup, type AnalysisResult } from "./analysis.js";
import { newReference, type Analysis, type AppData, type Entity, type EntityType, type PathStep, type PropertyDef } from "./model.js";

const reference = (id: string, name: string, typeIds: string[], multiple = false): PropertyDef => ({
	id,
	name,
	kind: "reference",
	options: [],
	reference: { ...newReference(typeIds), multiple },
	cardDisplay: "list",
});
const type = (id: string, name: string, properties: PropertyDef[] = []): EntityType => ({
	id,
	name,
	properties,
	contentTemplate: "",
	color: "#dcdcdc",
});
const entity = (id: string, typeId: string, values: Entity["values"] = {}): Entity => ({
	id,
	typeId,
	name: id,
	content: "",
	description: "",
	tags: [],
	values,
});

/** Activities, each with a responsible role, a process, events or states triggering it and states it leads to —
 * the shape of a process model. */
function processModel(): Pick<AppData, "types" | "entities"> {
	return {
		types: [
			type("event", "Event"),
			type("state", "State"),
			type("activity", "Tätigkeit", [
				reference("trigger", "getriggert durch", ["event", "state"], true),
				reference("responsible", "Verantwortlicher", ["role"]),
				reference("process", "Prozess", ["process"]),
				reference("leadsTo", "führt zu", ["state"], true),
				{ id: "status", name: "Status", kind: "options", options: ["neu", "fertig"], reference: null, cardDisplay: "list" },
			]),
			type("role", "Rolle"),
			type("process", "Prozess"),
		],
		entities: [
			entity("Antrag gestellt", "event"),
			entity("Antrag vorbereitet", "state"),
			entity("Anforderungen geklärt", "state"),
			entity("Bereit zum Rollout", "state"),
			entity("Sortieren", "activity", {
				trigger: ["Antrag gestellt", "Antrag vorbereitet"],
				responsible: "Manager",
				process: "Klärung",
				leadsTo: ["Anforderungen geklärt"],
				status: "fertig",
			}),
			entity("Umsetzen", "activity", {
				trigger: ["Anforderungen geklärt"],
				responsible: "Entwickler",
				process: "Klärung",
				leadsTo: ["Bereit zum Rollout"],
				status: "neu",
			}),
			entity("Deployen", "activity", { trigger: ["Bereit zum Rollout"], responsible: "Entwickler", process: "Deployment" }),
			entity("Aufräumen", "activity", { process: "Deployment" }),
			entity("Entwickler", "role"),
			entity("Manager", "role"),
			entity("Klärung", "process"),
			entity("Deployment", "process"),
		],
	};
}

const forward = (propertyId: string): PathStep => ({ propertyId, direction: "forward" });
const inverse = (propertyId: string): PathStep => ({ propertyId, direction: "inverse" });
const analysis = (typeId: string | null, groups: PathStep[][], columns: PathStep[][] = []): Analysis => ({
	id: "a",
	name: "A",
	typeId,
	groups,
	columns,
});

/** The result as lines: each group as its label (or "–") and count, indented per level, each row as its name and cells. */
function outline(result: AnalysisResult): string[] {
	const rows = (group: Pick<AnalysisGroup, "rows">, indent: string) =>
		group.rows.map((r) => `${indent}${r.entity.id}${r.cells.map((c) => ` | ${c.map((v) => v.label).join(", ")}`).join("")}`);
	const groups = (list: AnalysisGroup[], indent: string): string[] =>
		list.flatMap((g) => [`${indent}${g.value?.label ?? "–"} (${g.count})`, ...groups(g.groups, `${indent}  `), ...rows(g, `${indent}  `)]);
	return [...groups(result.groups, ""), ...rows(result, "")];
}

test("pathOptions: a type's own properties, then the references of any type that can point at it", () => {
	const { types } = processModel();
	const describe = (from: string[]) => pathOptions(types, from).map((o) => `${o.step.direction} ${o.prop.name} → ${o.typeIds.join("/")}`);
	assert.deepEqual(describe(["activity"]), [
		"forward getriggert durch → event/state",
		"forward Verantwortlicher → role",
		"forward Prozess → process",
		"forward führt zu → state",
		"forward Status → ",
	]);
	assert.deepEqual(describe(["role"]), ["inverse Verantwortlicher → activity"]);
	assert.deepEqual(describe(["event", "state"]), ["inverse getriggert durch → activity", "inverse führt zu → activity"]);
});

test("resolvePath: where a path stops fitting — a property that's gone, or a step after a text or options property", () => {
	const { types } = processModel();
	assert.deepEqual(resolvePath(types, "role", [inverse("responsible"), forward("trigger")]).broken, null);
	assert.equal(resolvePath(types, "role", [forward("responsible")]).broken, 0);
	assert.equal(resolvePath(types, "activity", [forward("process"), forward("gone")]).broken, 1);
	assert.equal(resolvePath(types, "activity", [forward("status"), forward("process")]).broken, 1);
});

test("per role and process: the activities with what triggers them; activities without a role last", () => {
	const result = runAnalysis(processModel(), analysis("activity", [[forward("responsible")], [forward("process")]], [[forward("trigger")]]));
	assert.deepEqual(outline(result), [
		"Entwickler (2)",
		"  Klärung (1)",
		"    Umsetzen | Anforderungen geklärt",
		"  Deployment (1)",
		"    Deployen | Bereit zum Rollout",
		"Manager (1)",
		"  Klärung (1)",
		"    Sortieren | Antrag gestellt, Antrag vorbereitet",
		"– (1)",
		"  Deployment (1)",
		"    Aufräumen | ",
	]);
	assert.equal(result.count, 4);
	assert.deepEqual(result.groups[0]!.value, { label: "Entwickler", entityId: "Entwickler" });
});

test("a row leading to several values is in each of their groups, counted once in the group above", () => {
	const result = runAnalysis(processModel(), analysis("activity", [[forward("process")], [forward("trigger")]]));
	assert.deepEqual(outline(result), [
		"Klärung (2)",
		"  Antrag gestellt (1)",
		"    Sortieren",
		"  Antrag vorbereitet (1)",
		"    Sortieren",
		"  Anforderungen geklärt (1)",
		"    Umsetzen",
		"Deployment (2)",
		"  Bereit zum Rollout (1)",
		"    Deployen",
		"  – (1)",
		"    Aufräumen",
	]);
});

test("chains go both ways: per role, what triggers its activities and the activities a state leads to", () => {
	const result = runAnalysis(
		processModel(),
		analysis("role", [], [[inverse("responsible")], [inverse("responsible"), forward("trigger")], [inverse("responsible"), forward("trigger"), inverse("leadsTo")]]),
	);
	assert.deepEqual(outline(result), [
		"Entwickler | Umsetzen, Deployen | Anforderungen geklärt, Bereit zum Rollout | Sortieren, Umsetzen",
		"Manager | Sortieren | Antrag gestellt, Antrag vorbereitet | ",
	]);
});

test("grouping by an options property follows the order of its options", () => {
	const result = runAnalysis(processModel(), analysis("activity", [[forward("status")]]));
	assert.deepEqual(outline(result), ["neu (1)", "  Umsetzen", "fertig (1)", "  Sortieren", "– (2)", "  Deployen", "  Aufräumen"]);
	assert.deepEqual(result.groups[0]!.value, { label: "neu", entityId: null });
});

test("paths that don't fit are left out of the groups and give empty cells; without a type there are no rows", () => {
	const data = processModel();
	const result = runAnalysis(data, analysis("activity", [[forward("gone")], []], [[forward("gone")], []]));
	assert.deepEqual(outline(result), ["Sortieren |  | ", "Umsetzen |  | ", "Deployen |  | ", "Aufräumen |  | "]);
	assert.deepEqual(runAnalysis(data, analysis(null, [])), { count: 0, groups: [], rows: [] });
	assert.deepEqual(runAnalysis(data, analysis("deleted", [])), { count: 0, groups: [], rows: [] });
});
