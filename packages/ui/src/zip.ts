/**
 * Text files packed into a ZIP archive, stored without compression (what's exported is small, and every unzip tool
 * reads it). Names are UTF-8, so umlauts come out right.
 */
export function zipFiles(files: readonly { name: string; contents: string }[]): Uint8Array<ArrayBuffer> {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	const directory: Uint8Array[] = [];
	let offset = 0;
	for (const file of files) {
		const name = encoder.encode(file.name);
		const data = encoder.encode(file.contents);
		const crc = crc32(data);
		// Version 2.0, UTF-8 names (bit 11), stored (method 0), no date.
		const common = (view: DataView, at: number) => {
			view.setUint16(at, 20, true);
			view.setUint16(at + 2, 0x0800, true);
			view.setUint16(at + 4, 0, true);
			view.setUint32(at + 10, crc, true);
			view.setUint32(at + 14, data.length, true);
			view.setUint32(at + 18, data.length, true);
			view.setUint16(at + 22, name.length, true);
		};
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		common(local, 4);
		parts.push(new Uint8Array(local.buffer), name, data);

		const entry = new DataView(new ArrayBuffer(46));
		entry.setUint32(0, 0x02014b50, true);
		entry.setUint16(4, 20, true); // made by
		common(entry, 6);
		entry.setUint32(42, offset, true);
		directory.push(new Uint8Array(entry.buffer), name);
		offset += 30 + name.length + data.length;
	}
	const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, files.length, true);
	end.setUint16(10, files.length, true);
	end.setUint32(12, directorySize, true);
	end.setUint32(16, offset, true);

	const all = [...parts, ...directory, new Uint8Array(end.buffer)];
	const zip = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of all) {
		zip.set(part, at);
		at += part.length;
	}
	return zip;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}
