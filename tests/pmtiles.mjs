// Run with `node --test tests/pmtiles.mjs`; source modules only, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { findPmEntry, parsePmDirectory, parsePmHeader, pmDecompress, pmtilesReader, zxyToTileId } from "../src/utils/pmtiles.js";

test("tile ids follow the PMTiles spec's Hilbert numbering", () => {
	assert.equal(zxyToTileId(0, 0, 0), 0);
	assert.deepEqual([[0, 0], [0, 1], [1, 1], [1, 0]].map(([x, y]) => zxyToTileId(1, x, y)), [1, 2, 3, 4]);
	assert.equal(zxyToTileId(2, 0, 0), 5);
	assert.equal(zxyToTileId(20, 0, 0), 366503875925);
	const ids = new Set();
	for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) ids.add(zxyToTileId(3, x, y));
	assert.equal(ids.size, 64); assert.equal(Math.min(...ids), 21); assert.equal(Math.max(...ids), 84);
});

const varint = (n) => { const out = []; while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); } out.push(n); return out; };
function directory(entries) {
	const b = [...varint(entries.length)];
	let last = 0;
	for (const e of entries) { b.push(...varint(e.tileId - last)); last = e.tileId; }
	for (const e of entries) b.push(...varint(e.runLength));
	for (const e of entries) b.push(...varint(e.length));
	entries.forEach((e, i) => {
		const prev = entries[i - 1];
		b.push(...varint(i > 0 && e.offset === prev.offset + prev.length ? 0 : e.offset + 1));
	});
	return Uint8Array.from(b);
}

test("directories decode, including offsets that follow on from the previous entry", () => {
	const want = [
		{ tileId: 0, offset: 0, length: 10, runLength: 1 },
		{ tileId: 1, offset: 10, length: 5, runLength: 3 },
		{ tileId: 9, offset: 100, length: 7, runLength: 0 },
	];
	assert.deepEqual(parsePmDirectory(directory(want)), want);
	const d = parsePmDirectory(directory(want));
	assert.equal(findPmEntry(d, 3).tileId, 1, "inside a run");
	assert.equal(findPmEntry(d, 5), null, "past the run");
	assert.equal(findPmEntry(d, 50).runLength, 0, "a leaf directory covers later ids");
});

test("a whole small file reads end to end through ranges and gzip", async () => {
	const tile = new TextEncoder().encode("tile 1/1/0");
	const tileGz = gzipSync(tile);
	const root = gzipSync(directory([{ tileId: zxyToTileId(1, 1, 0), offset: 0, length: tileGz.length, runLength: 1 }]));
	const meta = gzipSync(Buffer.from(JSON.stringify({ name: "test" })));
	const header = Buffer.alloc(127);
	header.write("PMTiles", 0, "latin1"); header.writeUInt8(3, 7);
	let o = 127;
	const put = (pos, v) => header.writeBigUInt64LE(BigInt(v), pos);
	put(8, o); put(16, root.length); o += root.length;
	put(24, o); put(32, meta.length); o += meta.length;
	put(40, o); put(48, 0);
	put(56, o); put(64, tileGz.length);
	header.writeUInt8(2, 97); header.writeUInt8(2, 98); header.writeUInt8(1, 99); header.writeUInt8(0, 100); header.writeUInt8(2, 101);
	const file = Buffer.concat([header, root, meta, tileGz]);
	const asked = [];
	const rd = pmtilesReader({
		fetchRange: (off, len, cb) => { asked.push([off, len]); const b = file.subarray(off, off + len); cb(null, b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); },
		decompress: pmDecompress,
	});
	assert.equal((await rd.header()).maxZoom, 2);
	assert.equal(new TextDecoder().decode(await rd.tile(1, 1, 0)), "tile 1/1/0");
	assert.equal(await rd.tile(1, 0, 0), null, "a tile not in the file");
	assert.equal(await rd.tile(5, 0, 0), null, "beyond the file's zooms");
	assert.deepEqual(await rd.metadata(), { name: "test" });
	assert.throws(() => parsePmHeader(new ArrayBuffer(127)), /not a PMTiles v3 file/);
});
