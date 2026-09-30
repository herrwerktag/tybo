import assert from "node:assert/strict";
import { test } from "node:test";
import { isUlid, ulid } from "./ulid.js";

test("ulid has 26 Crockford base32 characters", () => {
	const id = ulid();
	assert.equal(id.length, 26);
	assert.ok(isUlid(id));
});

test("ulid encodes the timestamp like the spec example", () => {
	assert.equal(ulid(1469918176385).slice(0, 10), "01ARYZ6S41");
});

test("ulids sort by time and are unique", () => {
	assert.ok(ulid(1000) < ulid(2000));
	assert.notEqual(ulid(1000), ulid(1000));
});

test("isUlid rejects other ids", () => {
	assert.ok(!isUlid("5f0c6f3e-1b2a-4c3d-9e8f-0a1b2c3d4e5f"));
	assert.ok(!isUlid("01ARYZ6S41TSV4RRFFQ69G5FAI")); // "I" is not in the alphabet
	assert.ok(!isUlid(42));
});
