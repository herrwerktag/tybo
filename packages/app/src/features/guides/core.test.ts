import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_VERSION, type AppData } from "../../shared/core/index.js";
import { exportWorkspace, prepareImport, readWorkspaceFile } from "../../features.core.js";
import { memoryStorage, open, settle, titleDraft, WS } from "../../test-store.js";
import { GUIDE_ID, setGuide } from "./core.js";

test("the guide is a unit of its own: writing it writes nothing else, an empty one takes it away, undo gives it back", async () => {
	const storage = memoryStorage();
	const store = await open(storage);
	store.addType("Regel", [titleDraft], "");
	await settle();

	setGuide(store, "# Spark to Spec\n\nErst die Idee, dann der Pitch.");
	await settle();
	assert.deepEqual(storage.saves.at(-1)!.map((c) => `${c.kind}:${c.id}`), [`guide:${GUIDE_ID}`]);
	assert.equal(storage.data(WS)!.guide, "# Spark to Spec\n\nErst die Idee, dann der Pitch.");
	assert.equal((await open(storage)).data.guide, store.data.guide);

	setGuide(store, "  \n");
	await settle();
	assert.equal(store.data.guide, "");
	assert.deepEqual(storage.saves.at(-1)!.map((c) => [c.kind, c.after]), [["guide", null]]);
	assert.equal(storage.data(WS)!.guide, "");

	store.undo();
	assert.equal(store.data.guide, "# Spark to Spec\n\nErst die Idee, dann der Pitch.");
	store.redo();
	assert.equal(store.data.guide, "");
	const saves = storage.saves.length;
	setGuide(store, ""); // changed nothing
	await settle();
	assert.equal(storage.saves.length, saves);
});

test("a workspace's help — its guide, a type's description and guide, a property's note — is exported and imported as it is", async () => {
	const store = await open(memoryStorage());
	const regel = store.addType("Regel", [{ ...titleDraft, description: "Ein Satz im Präsens." }], "", undefined, {
		description: "Was im System immer gilt.",
		guide: "## Verwendung\n\nEine Regel je Aussage.",
	});
	setGuide(store, "# Methode\n\n1. Idee\n2. Pitch");

	const text = exportWorkspace("Tybo", store.data);
	const exported = JSON.parse(text).data;
	assert.equal(exported.guide, "# Methode\n\n1. Idee\n2. Pitch");
	assert.equal(exported.types[0].description, "Was im System immer gilt.");
	assert.equal(exported.types[0].guide, "## Verwendung\n\nEine Regel je Aussage.");
	assert.equal(exported.types[0].properties[0].description, "Ein Satz im Präsens.");

	const imported = readWorkspaceFile(text)!.data as AppData;
	assert.equal(imported.guide, store.data.guide);
	assert.deepEqual(imported.types, [regel]);
});

test("a workspace saved before the model's help loads unchanged, its help empty — and its next save writes only what changed", async () => {
	const before = {
		version: 13,
		types: [
			{
				id: "regel",
				name: "Regel",
				color: "#c4dafa",
				contentTemplate: "Gegeben …",
				properties: [{ id: "status", name: "Status", kind: "options", options: [{ id: "o", label: "Entwurf" }], reference: null, cardDisplay: "list" }],
			},
		],
		entities: [{ id: "01J00000000000000000000000", typeId: "regel", name: "Namen sind eindeutig", content: "", description: "Gegeben …", tags: [], values: { status: "o" } }],
		boards: [],
		traits: [],
		analyses: [],
	};
	const storage = memoryStorage(before);
	const store = await open(storage);
	assert.equal(store.problems.load, null);
	assert.equal(store.data.guide, "");
	const [regel] = store.data.types;
	assert.deepEqual(regel, { ...before.types[0]!, description: "", guide: "", properties: [{ ...before.types[0]!.properties[0]!, description: "" }] });
	assert.deepEqual(store.data.entities, before.entities);

	setGuide(store, "Neu");
	await settle();
	assert.deepEqual(storage.saves.map((save) => save.map((c) => c.kind)), [["guide"]], "the type, completed while reading, isn't written for it");

	const imported = prepareImport(before)!;
	assert.equal(imported.guide, "");
	assert.deepEqual(imported.types, store.data.types);
	assert.equal(DATA_VERSION, 14);
});
