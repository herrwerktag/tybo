import assert from "node:assert/strict";
import { test } from "node:test";
import { UNIT_KINDS } from "./features.core.js";
import { UNIT_STORAGES } from "./features.api.js";

test("the storage keeps the same kinds of unit as the core, in the same order", () => {
	assert.deepEqual(
		UNIT_STORAGES.map((storage) => storage.unit.kind),
		UNIT_KINDS.map((unit) => unit.kind),
	);
});
