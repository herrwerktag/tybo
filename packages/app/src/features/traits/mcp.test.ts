import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "../../test-tools.js";

/** Pitches and open questions, each with a status of its own, and a pitch with a question on it. */
async function withPitches() {
	const tools = setup();
	const { call } = tools;
	await call("create_type", {
		name: "Pitch",
		properties: [{ name: "Status", kind: "options", options: ["Entwurf", "in Arbeit", "abgeschlossen", "verworfen"] }],
	});
	await call("create_type", {
		name: "Offene Frage",
		properties: [
			{ name: "Status", kind: "options", options: ["offen", "beantwortet"] },
			{ name: "Pitch", kind: "reference", targets: ["Pitch"] },
		],
	});
	await call("create_entity", { type: "Pitch", name: "Traits", content: "Bedeutungen", values: { Status: "Entwurf" } });
	await call("create_entity", { type: "Pitch", name: "Verlauf", values: { Status: "abgeschlossen" } });
	await call("create_entity", { type: "Offene Frage", name: "Wie heißen sie?", values: { Status: "offen", Pitch: "Traits" } });
	return tools;
}

const PROGRESS = {
	name: "Fortschritt",
	roles: [
		{ name: "Stand", kind: "options", options: ["offen", "in Arbeit", "fertig"] },
		{ name: "Kurz", kind: "text" },
		{ name: "Fragen", kind: "reference" },
	],
	bindings: [
		{ type: "Pitch", role: "Stand", property: "Status", values: { Entwurf: "offen", "in Arbeit": "in Arbeit", abgeschlossen: "fertig" } },
		{ type: "Pitch", role: "Kurz", property: "content" },
		{ type: "Pitch", role: "Fragen", property: "Offene Frage.Pitch" },
		{ type: "Offene Frage", role: "Stand", property: "status", values: { offen: "offen", beantwortet: "fertig" } },
	],
};

test("a trait is made with its roles and bindings, and describe_workspace tells per type what plays each role", async () => {
	const { call } = await withPitches();
	const { trait } = await call("create_trait", PROGRESS);
	assert.deepEqual(trait.roles.map((r: { name: string; kind: string }) => `${r.name} (${r.kind})`), ["Stand (options)", "Kurz (text)", "Fragen (reference)"]);
	assert.deepEqual(trait.roles[0].options.map((o: { label: string }) => o.label), ["offen", "in Arbeit", "fertig"]);
	const described = (await call("describe_workspace")).traits;
	assert.deepEqual(described, [trait]);
	assert.deepEqual(trait.types, [
		{
			type: "Pitch",
			roles: [
				{ role: "Stand", property: "Status", values: { Entwurf: "offen", "in Arbeit": "in Arbeit", abgeschlossen: "fertig" } },
				{ role: "Kurz", property: "content" },
				{ role: "Fragen", property: "Offene Frage.Pitch" },
			],
		},
		{ type: "Offene Frage", roles: [{ role: "Stand", property: "Status", values: { offen: "offen", beantwortet: "fertig" } }] },
	]);
	// No type changed.
	const types = (await call("describe_workspace")).types;
	assert.deepEqual(types.map((t: { properties: unknown[] }) => t.properties.length), [1, 2]);
});

test("what doesn't fit a role is refused, naming the role and what fits; so is a name taken and a role twice", async () => {
	const { call, refusal } = await withPitches();
	assert.match(
		await refusal("create_trait", { name: "X", roles: [{ name: "Kurz", kind: "text" }], bindings: [{ type: "Pitch", role: "Kurz", property: "Status" }] }),
		/"Status" can't play the text role Kurz on Pitch. What fits: name, content, description/,
	);
	assert.match(
		await refusal("create_trait", { name: "X", roles: [{ name: "Stand", kind: "options", options: ["a"] }], bindings: [{ type: "Pitch", role: "Stand", property: "Status", values: { Entwurf: "b" } }] }),
		/"b" isn't a value of Stand/,
	);
	assert.match(await refusal("create_trait", { name: "X", roles: [{ name: "A", kind: "text" }, { name: "a", kind: "text" }] }), /The role "a" is there twice/);
	assert.match(await refusal("create_trait", { name: "X", roles: [{ name: "Stand", kind: "options" }] }), /Stand needs values/);
	await call("create_trait", PROGRESS);
	assert.match(await refusal("create_trait", { name: " fortschritt" }), /There is a trait "fortschritt" already/);
	assert.deepEqual((await call("describe_workspace")).traits.map((t: { name: string }) => t.name), ["Fortschritt"], "nothing else was made");
});

test("update_trait keeps a role given by its name, with what is bound to it; a role whose kind changes loses its bindings; delete needs confirm", async () => {
	const { call, refusal } = await withPitches();
	await call("create_trait", PROGRESS);
	const { trait } = await call("update_trait", {
		trait: "Fortschritt",
		name: "Progress",
		roles: [
			{ name: "Stand", kind: "options", options: ["offen", "erledigt", "fertig"] },
			{ name: "Kurz", kind: "reference" },
		],
	});
	assert.equal(trait.name, "Progress");
	assert.deepEqual(trait.types[0].roles, [{ role: "Stand", property: "Status", values: { Entwurf: "offen", abgeschlossen: "fertig" } }], "in Arbeit stood for a value gone");
	assert.deepEqual(trait.types[1].roles, [{ role: "Stand", property: "Status", values: { offen: "offen", beantwortet: "fertig" } }]);

	const { trait: rebound } = await call("update_trait", { trait: "progress", bindings: [{ type: "Offene Frage" }] });
	assert.deepEqual(rebound.types, [{ type: "Offene Frage", roles: [] }], "bindings replace all of them; a type may bear it with nothing bound");
	assert.match(await refusal("delete_trait", { trait: "Progress", confirm: false }), /confirm: true/);
	await call("delete_trait", { trait: "Progress", confirm: true });
	assert.deepEqual((await call("describe_workspace")).traits, []);
});

test("an analysis of a trait: made with `trait`, its paths over role names, its rows each with its type", async () => {
	const { call, refusal } = await withPitches();
	await call("create_trait", PROGRESS);
	const { analysis } = await call("create_analysis", { name: "Was offen ist", trait: "Fortschritt", groups: ["Stand"], columns: ["Kurz", "Fragen › Stand"] });
	assert.deepEqual([analysis.trait, analysis.groupedBy, analysis.columns], ["Fortschritt", ["Stand"], ["Kurz", "Fragen › Stand"]]);
	const result = await call("run_analysis", { analysis: "Was offen ist" });
	assert.equal(result.trait, "Fortschritt");
	assert.deepEqual(
		result.groups.map((g: { value: string; rows: { entity: { name: string; type: string }; cells: string[][] }[] }) => [
			g.value,
			g.rows.map((r) => [r.entity.type, r.entity.name, ...r.cells.map((c) => c.join(", "))]),
		]),
		[
			["offen", [["Pitch", "Traits", "Bedeutungen", "offen"], ["Offene Frage", "Wie heißen sie?", "", ""]]],
			["fertig", [["Pitch", "Verlauf", "", ""]]],
		],
	);

	assert.match(await refusal("create_analysis", { name: "Y", type: "Pitch", trait: "Fortschritt" }), /a `type` or a `trait`, one of them/);
	assert.match(await refusal("update_analysis", { analysis: "Was offen ist", columns: ["Status"] }), /no step "Status" here. Steps: Stand, Kurz, Fragen/);
	assert.match(await refusal("update_analysis", { analysis: "Was offen ist", columns: ["Stand › Kurz"] }), /"Stand" is a text or options role; the path ends there/);
	const { analysis: ofType } = await call("update_analysis", { analysis: "Was offen ist", type: "Pitch" });
	assert.deepEqual([ofType.type, ofType.trait, ofType.groupedBy], ["Pitch", undefined, []], "another basis empties the paths");
});

test("a reference role with a condition: only the targets meeting it count, describe_workspace tells it and the targets that never can", async () => {
	const { call, refusal } = await withPitches();
	await call("create_type", { name: "Regel", properties: [{ name: "Pitch", kind: "reference", targets: ["Pitch"] }] });
	await call("create_entity", { type: "Offene Frage", name: "Erledigt?", values: { Status: "beantwortet", Pitch: "Traits" } });
	await call("create_entity", { type: "Regel", name: "Regel 1", values: { Pitch: "Verlauf" } });
	await call("create_trait", PROGRESS);
	const { trait } = await call("create_trait", {
		name: "Blockade",
		roles: [
			{ name: "blockiert durch", kind: "reference", condition: { trait: "Fortschritt", role: "Stand", values: ["offen", "in Arbeit"] } },
			{ name: "hängt an Blockiertem", kind: "reference", condition: { role: "blockiert durch", hasTargets: true } },
		],
		bindings: [
			{ type: "Pitch", role: "blockiert durch", property: "Offene Frage.Pitch" },
			{ type: "Pitch", role: "hängt an Blockiertem", property: "Regel.Pitch" },
		],
	});
	assert.deepEqual(trait.roles.map((r: { condition: unknown }) => r.condition), [
		{ trait: "Fortschritt", role: "Stand", values: ["offen", "in Arbeit"] },
		{ trait: "Blockade", role: "blockiert durch", hasTargets: true },
	]);
	assert.deepEqual(trait.types[0].roles[1], { role: "hängt an Blockiertem", property: "Regel.Pitch", targetsNeverMeetingCondition: ["Regel"] }, "rules don't bear Blockade");

	await call("create_analysis", { name: "Blockiert", trait: "Blockade", columns: ["blockiert durch", "hängt an Blockiertem"] });
	const result = await call("run_analysis", { analysis: "Blockiert" });
	assert.deepEqual(result.rows.map((r: { entity: { name: string }; cells: string[][] }) => [r.entity.name, ...r.cells.map((c) => c.join(", "))]), [
		["Traits", "Wie heißen sie?", ""],
		["Verlauf", "", ""],
	], "the answered question doesn't block; a rule never counts, not bearing Blockade");

	assert.match(
		await refusal("update_trait", { trait: "Blockade", roles: [{ name: "blockiert durch", kind: "reference", condition: { role: "blockiert durch", hasTargets: false } }, { name: "hängt an Blockiertem", kind: "reference" }] }),
		/The conditions lead round in a circle: Blockade.blockiert durch › Blockade.blockiert durch/,
	);
	assert.match(await refusal("update_trait", { trait: "Blockade", roles: [{ name: "x", kind: "reference", condition: { trait: "Fortschritt", role: "Kurz" } }] }), /Fortschritt has no options or reference role "Kurz". Roles: Stand, Fragen/);
	assert.match(await refusal("update_trait", { trait: "Blockade", roles: [{ name: "x", kind: "reference", condition: { trait: "Fortschritt", role: "Fragen" } }] }), /say `hasTargets`/);
	const { trait: kept } = await call("update_trait", { trait: "Blockade", roles: [{ name: "blockiert durch", kind: "reference" }] });
	assert.deepEqual(kept.roles[0].condition, { trait: "Fortschritt", role: "Stand", values: ["offen", "in Arbeit"] }, "a role given without a condition keeps it");
	const { trait: cleared } = await call("update_trait", { trait: "Blockade", roles: [{ name: "blockiert durch", kind: "reference", condition: null }] });
	assert.equal(cleared.roles[0].condition, undefined);
});
