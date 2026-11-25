/* -- PMTiles v3 reader ------------------------------------------------------
 * PMTiles is one large file holding a whole tile pyramid, read with HTTP
 * Range requests: a 127-byte header, a root directory, optional leaf
 * directories, then the tiles. Directories map Hilbert tile ids to byte
 * ranges. Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 * Fetching and decompressing are passed in, so this stays testable.
 */

function readVarint(bytes, pos) {
	let result = 0, shift = 0, b;
	do {
		b = bytes[pos.i++];
		result += (b & 0x7f) * 2 ** shift;
		shift += 7;
	} while (b & 0x80);
	return result;
}

const u64 = (v, o) => Number(v.getBigUint64(o, true));

export function parsePmHeader(buf) {
	const v = new DataView(buf);
	const magic = String.fromCharCode(...new Uint8Array(buf, 0, 7));
	if (magic !== "PMTiles" || v.getUint8(7) !== 3) throw new Error("not a PMTiles v3 file");
	return {
		rootOffset: u64(v, 8), rootLength: u64(v, 16),
		metadataOffset: u64(v, 24), metadataLength: u64(v, 32),
		leafOffset: u64(v, 40), leafLength: u64(v, 48),
		tileDataOffset: u64(v, 56), tileDataLength: u64(v, 64),
		internalCompression: v.getUint8(97), tileCompression: v.getUint8(98), tileType: v.getUint8(99),
		minZoom: v.getUint8(100), maxZoom: v.getUint8(101),
		minLon: v.getInt32(102, true) / 1e7, minLat: v.getInt32(106, true) / 1e7,
		maxLon: v.getInt32(110, true) / 1e7, maxLat: v.getInt32(114, true) / 1e7,
	};
}

export function parsePmDirectory(bytes) {
	const pos = { i: 0 };
	const n = readVarint(bytes, pos);
	const entries = new Array(n);
	let last = 0;
	for (let k = 0; k < n; k++) { last += readVarint(bytes, pos); entries[k] = { tileId: last, offset: 0, length: 0, runLength: 0 }; }
	for (let k = 0; k < n; k++) entries[k].runLength = readVarint(bytes, pos);
	for (let k = 0; k < n; k++) entries[k].length = readVarint(bytes, pos);
	for (let k = 0; k < n; k++) {
		const o = readVarint(bytes, pos);
		entries[k].offset = o === 0 && k > 0 ? entries[k - 1].offset + entries[k - 1].length : o - 1;
	}
	return entries;
}

// z/x/y → PMTiles tile id (tiles of lower zooms first, Hilbert order within).
export function zxyToTileId(z, x, y) {
	let acc = 0;
	for (let t = 0; t < z; t++) acc += 4 ** t;
	const n = 2 ** z;
	let d = 0, rx, ry, xx = x, yy = y;
	for (let s = n / 2; s >= 1; s /= 2) {
		rx = (xx & s) > 0 ? 1 : 0;
		ry = (yy & s) > 0 ? 1 : 0;
		d += s * s * ((3 * rx) ^ ry);
		if (ry === 0) {
			if (rx === 1) { xx = s - 1 - xx; yy = s - 1 - yy; }
			const tmp = xx; xx = yy; yy = tmp;
		}
	}
	return acc + d;
}

export function findPmEntry(entries, tileId) {
	let lo = 0, hi = entries.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1, c = entries[mid].tileId - tileId;
		if (c < 0) lo = mid + 1; else if (c > 0) hi = mid - 1; else return entries[mid];
	}
	if (hi >= 0) {
		const e = entries[hi];
		if (e.runLength === 0) return e;              // a leaf directory covering this id
		if (tileId - e.tileId < e.runLength) return e; // a run of identical tiles
	}
	return null;
}

// A reader over one PMTiles file. `fetchRange(offset, length, cb(err, ArrayBuffer))`
// and `decompress(ArrayBuffer, compressionCode) → Promise<ArrayBuffer>` are supplied.
export function pmtilesReader({ fetchRange, decompress }) {
	let header = null, root = null, starting = null;
	const leaves = new Map();
	const range = (o, l) => new Promise((res, rej) => fetchRange(o, l, (e, b) => (e ? rej(e) : res(b))));
	const start = () => starting || (starting = (async () => {
		const first = await range(0, 16384);
		header = parsePmHeader(first);
		let rootBuf = header.rootOffset + header.rootLength <= first.byteLength
			? first.slice(header.rootOffset, header.rootOffset + header.rootLength)
			: await range(header.rootOffset, header.rootLength);
		root = parsePmDirectory(new Uint8Array(await decompress(rootBuf, header.internalCompression)));
	})().catch((e) => { starting = null; throw e; }));
	const leaf = async (offset, length) => {
		const key = offset + ":" + length;
		if (!leaves.has(key)) {
			const p = range(header.leafOffset + offset, length)
				.then((b) => decompress(b, header.internalCompression))
				.then((b) => parsePmDirectory(new Uint8Array(b)));
			leaves.set(key, p);
			p.catch(() => leaves.delete(key));
			if (leaves.size > 64) leaves.delete(leaves.keys().next().value);
		}
		return leaves.get(key);
	};
	return {
		async header() { await start(); return header; },
		// The decompressed tile bytes, or null where the file has no tile.
		async tile(z, x, y) {
			await start();
			if (z < header.minZoom || z > header.maxZoom) return null;
			const id = zxyToTileId(z, x, y);
			let dir = root;
			for (let depth = 0; depth < 4; depth++) {
				const e = findPmEntry(dir, id);
				if (!e) return null;
				if (e.runLength === 0) { dir = await leaf(e.offset, e.length); continue; }
				const raw = await range(header.tileDataOffset + e.offset, e.length);
				return decompress(raw, header.tileCompression);
			}
			return null;
		},
		async metadata() {
			await start();
			const b = await range(header.metadataOffset, header.metadataLength);
			return JSON.parse(new TextDecoder().decode(await decompress(b, header.internalCompression)));
		},
	};
}

// Decompression with the browser's own streams (1 none, 2 gzip).
export async function pmDecompress(buf, code) {
	if (code === 1 || code === 0) return buf;
	if (code !== 2) throw new Error("unsupported PMTiles compression " + code);
	const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Response(stream).arrayBuffer();
}
