import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { zipFiles } from "./zip.js";

/** The files in a ZIP, read from its central directory and local headers, each checked against its CRC-32. */
function unzip(zip: Uint8Array): { name: string; contents: string }[] {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const decoder = new TextDecoder();
	const end = zip.length - 22;
	assert.equal(view.getUint32(end, true), 0x06054b50);
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const files = [];
	for (let i = 0; i < count; i++) {
		assert.equal(view.getUint32(at, true), 0x02014b50);
		const crc = view.getUint32(at + 16, true);
		const size = view.getUint32(at + 24, true);
		const nameLength = view.getUint16(at + 28, true);
		const local = view.getUint32(at + 42, true);
		const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
		assert.equal(view.getUint32(local, true), 0x04034b50);
		const start = local + 30 + view.getUint16(local + 26, true);
		const data = zip.subarray(start, start + size);
		assert.equal(crc32(data), crc);
		files.push({ name, contents: decoder.decode(data) });
		at += 46 + nameLength;
	}
	return files;
}

test("zipFiles packs text files that unzip again, names with umlauts included", () => {
	const files = [
		{ name: "Board.drawio", contents: "<mxfile/>\n" },
		{ name: "Prüfung & Freigabe.drawio", contents: "Grüße" },
		{ name: "leer.txt", contents: "" },
	];
	assert.deepEqual(unzip(zipFiles(files)), files);
});
