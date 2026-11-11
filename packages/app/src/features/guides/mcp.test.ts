import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "../../test-tools.js";

test("describe_workspace gives the model's help in full: the workspace's guide, a type's description and guide, a property's note", async () => {
	const { call } = setup();
	const guide = `# Spark to Spec\n\n${"Ein langer Absatz. ".repeat(400)}\n\n## Beispiel\n\n- Idee → Pitch`;
	await call("update_workspace_guide", { guide });
	await call("create_type", {
		name: "Regel",
		description: "Was im System immer gilt.",
		guide: "## Verwendung\n\nEine Regel je Aussage.\n\n## Beispiel\n\n„Namen sind eindeutig.“",
		properties: [{ name: "Status", kind: "options", options: ["Entwurf", "gültig"], description: "Entwürfe werden noch nicht als verbindliche Systemregel gelesen." }],
	});

	const described = await call("describe_workspace");
	assert.equal(described.guide, guide);
	const [regel] = described.types;
	assert.equal(regel.description, "Was im System immer gilt.");
	assert.equal(regel.guide, "## Verwendung\n\nEine Regel je Aussage.\n\n## Beispiel\n\n„Namen sind eindeutig.“");
	assert.equal(regel.properties[0].description, "Entwürfe werden noch nicht als verbindliche Systemregel gelesen.");
});

test("update_workspace_guide replaces the whole guide; an empty text removes it; types and entities stay", async () => {
	const { call, refusal, storage } = setup();
	await call("create_type", { name: "Regel" });
	assert.equal((await call("describe_workspace")).guide, "", "a workspace starts without a guide");

	assert.deepEqual(await call("update_workspace_guide", { guide: "Erst die Idee." }), { guide: "Erst die Idee." });
	await call("update_workspace_guide", { guide: "Erst der Pitch." });
	assert.equal((await call("describe_workspace")).guide, "Erst der Pitch.");
	assert.deepEqual(storage.saves.at(-1)!.map((c) => c.kind), ["guide"]);
	assert.deepEqual((await call("describe_workspace")).types.map((t: { name: string }) => t.name), ["Regel"]);

	await call("update_workspace_guide", { guide: "" });
	assert.equal((await call("describe_workspace")).guide, "");
	assert.match(await refusal("update_workspace_guide", {}), /guide/);
});
